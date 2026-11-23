import fs from "node:fs/promises";
import path from "node:path";
import { concatTransformationMatrix, drawObject, PDFDocument, PDFName, popGraphicsState, pushGraphicsState, type PDFPage } from "pdf-lib";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { PageOp } from "../shared/types.ts";
import { kickEmbeddings } from "./embeddings.ts";
import { extractText, ocrPdf, renderPageJpeg, renderThumb } from "./ocr.ts";
import { compose, identity, isIdentity, mul, rotation, validateOps, type Matrix, type PageTransform } from "../shared/pageTransform.ts";

/**
 * Page edits. The searchable PDF as OCR first produced it is kept as the base
 * (archive/<id>.base.pdf) while a document has edits, and every save rebuilds
 * the PDF from the original upload plus the full list of edits, then OCRs it.
 * So edits never stack up losses, and reverting is a file copy.
 */

interface DocRow {
  status: string;
  mime_type: string;
  original_path: string;
  archive_path: string | null;
  thumb_path: string | null;
  page_edits: PageTransform[] | null;
}

const busy = new Set<string>();

export const basePath = (id: string) => path.join("archive", `${id}.base.pdf`);

/** Applies ops (relative to the pages as they are now) and rewrites the searchable PDF. */
export async function editPages(id: string, ops: PageOp[]): Promise<void> {
  await withDoc(id, async (doc) => {
    const archive = path.join(config.dataDir, doc.archive_path!);
    const base = path.join(config.dataDir, basePath(id));
    // Unedited: the current PDF is the base. It's copied aside only once there's something to save.
    const baseDoc = await PDFDocument.load(await fs.readFile(doc.page_edits ? base : archive), { ignoreEncryption: true, updateMetadata: false });
    const sizes = baseDoc.getPages().map(shownSize);
    const current = doc.page_edits ?? identity(sizes);
    const problem = validateOps(ops, current.length);
    if (problem) throw new HttpError(400, problem);
    const next = compose(current, ops);
    if (isIdentity(next, sizes)) {
      if (doc.page_edits) await restoreBase(id, doc);
      return;
    }
    if (!doc.page_edits) await fs.copyFile(archive, base);

    const tmp = await fs.mkdtemp(path.join(config.dataDir, "tmp-pages-"));
    try {
      const source = path.join(tmp, "source.pdf");
      await fs.writeFile(source, await buildPdf(doc, base, baseDoc, next, tmp));
      const out = path.join(tmp, "out.pdf");
      await ocrPdf(source, out, { rotatePages: false });
      await fs.rename(out, archive);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    await afterRewrite(id, doc, next);
  });
}

/** Puts back the searchable PDF as OCR first produced it. */
export async function revertPages(id: string): Promise<void> {
  await withDoc(id, async (doc) => {
    if (!doc.page_edits) return;
    await restoreBase(id, doc);
  });
}

async function withDoc(id: string, fn: (doc: DocRow) => Promise<void>): Promise<void> {
  if (busy.has(id)) throw new HttpError(409, "The pages are already being saved.");
  busy.add(id);
  try {
    const [doc] = await sql<DocRow[]>`
      select status, mime_type, original_path, archive_path, thumb_path, page_edits from document where entity_id = ${id}`;
    if (!doc) throw new HttpError(404, "Document not found.");
    if (!doc.archive_path) throw new HttpError(409, "Only PDFs and images have pages to edit.");
    if (doc.status !== "inbox" && doc.status !== "filed") throw new HttpError(409, "Wait until the document has been read.");
    await fn(doc);
  } finally {
    busy.delete(id);
  }
}

async function restoreBase(id: string, doc: DocRow): Promise<void> {
  const base = path.join(config.dataDir, basePath(id));
  await fs.rename(base, path.join(config.dataDir, doc.archive_path!));
  await afterRewrite(id, doc, null);
}

/** New text, thumbnail and search entries for a rewritten PDF. */
async function afterRewrite(id: string, doc: DocRow, edits: PageTransform[] | null): Promise<void> {
  const archive = path.join(config.dataDir, doc.archive_path!);
  const { content, pageCount } = await extractText(archive);
  const thumbRel = path.join("thumbs", `${id}.png`);
  await fs.mkdir(path.join(config.dataDir, "thumbs"), { recursive: true });
  const thumb = (await renderThumb(archive, path.join(config.dataDir, "thumbs", id))) ? thumbRel : null;
  await sql`
    update document set content = ${content}, page_count = ${pageCount}, thumb_path = ${thumb},
      page_edits = ${edits ? sql.json(edits as never) : null}, pages_edited_at = clock_timestamp(),
      embedded_model = null
    where entity_id = ${id}`;
  await sql`select refresh_document_search(${id})`;
  // The text changed: embed it again for search by meaning.
  kickEmbeddings();
}

/** Width and height of a page as shown, after its own /Rotate. */
function shownSize(p: PDFPage): { w: number; h: number } {
  const b = p.getCropBox();
  return p.getRotation().angle % 180 ? { w: b.height, h: b.width } : { w: b.width, h: b.height };
}

/**
 * Builds the edited PDF, before OCR. Pages come from the original upload where
 * it's a PDF with the same pages as the base (so born-digital text and vector
 * content stay as they are). Otherwise, as for photos, the base page is
 * rendered at 300 dpi; its old OCR text is left behind and read again.
 */
async function buildPdf(doc: DocRow, base: string, baseDoc: PDFDocument, edits: PageTransform[], tmp: string): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  let original: PDFDocument | null = null;
  if (doc.mime_type === "application/pdf") {
    try {
      original = await PDFDocument.load(await fs.readFile(path.join(config.dataDir, doc.original_path)), { ignoreEncryption: true, updateMetadata: false });
      if (original.getPageCount() !== baseDoc.getPageCount()) original = null;
    } catch {
      original = null;
    }
  }
  const basePages = baseDoc.getPages();
  for (const t of edits) {
    const bp = basePages[t.page - 1];
    const shown = shownSize(bp);
    const op = original?.getPage(t.page - 1);
    // ocrmypdf keeps page boxes; if they differ anyway, render the base page instead.
    const sameBox = op && Math.abs(op.getCropBox().width - bp.getCropBox().width) < 1 &&
      Math.abs(op.getCropBox().height - bp.getCropBox().height) < 1;
    if (op && sameBox) {
      const r0 = bp.getRotation().angle;
      const untouched = t.m.every((v, i) => v === [1, 0, 0, 1, 0, 0][i]) && t.w === round(shown.w) && t.h === round(shown.h);
      if (untouched && op.getRotation().angle === r0) {
        const [copy] = await out.copyPages(original!, [t.page - 1]);
        out.addPage(copy);
        continue;
      }
      // The page's own content, unrotated, as a form in [0, W] × [0, H]; then its rotation as shown, then the edits.
      const box = op.getCropBox();
      const form = await out.embedPage(op, { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height });
      const page = out.addPage([t.w, t.h]);
      draw(page, page.node.newXObject("Pg", form.ref), mul(t.m, rotation(r0, box.width, box.height).m));
    } else {
      const jpgBase = path.join(tmp, `page-${t.page}`);
      await renderPageJpeg(base, t.page, jpgBase);
      const img = await out.embedJpg(await fs.readFile(`${jpgBase}.jpg`));
      const page = out.addPage([t.w, t.h]);
      // The render is already as shown; an image draws into the unit square.
      draw(page, page.node.newXObject("Im", img.ref), mul(t.m, [shown.w, 0, 0, shown.h, 0, 0]));
    }
  }
  return out.save();
}

function draw(page: PDFPage, name: PDFName, m: Matrix): void {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(name), popGraphicsState());
}

const round = (n: number) => Math.round(n * 1000) / 1000;
