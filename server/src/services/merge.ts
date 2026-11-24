import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { MergePart, Proposal } from "../shared/types.ts";
import { kickEmbeddings } from "./embeddings.ts";
import { extractText, renderThumb } from "./ocr.ts";
import { checkOrder, MAX_MERGE, type MergePage } from "./mergeOrder.ts";
import { basePath, busy } from "./pages.ts";

export { MAX_MERGE };

/**
 * Merging inbox documents into one, for a document whose sheets had to be
 * scanned separately (an invoice and its debit receipt, say).
 *
 * The document merged into keeps its id. Its searchable PDF becomes the
 * chosen pages of every part's searchable PDF (page edits included), so
 * nothing is OCRed again. Its original becomes a PDF of the same pages taken
 * from the uploads where possible, so later page edits and "Redo OCR" work
 * as for any upload; the uploads themselves are kept, unchanged, as its parts.
 * The other documents go to the trash, marked as merged, and the AI reads the
 * merged document again. Undo puts everything back as it was.
 */

interface Row {
  entity_id: string;
  status: string;
  original_filename: string;
  mime_type: string;
  file_size: string;
  original_path: string;
  archive_path: string | null;
  thumb_path: string | null;
  page_count: number | null;
  page_edits: unknown;
  content: string;
  proposal: Proposal | null;
  merge_parts: MergePart[] | null;
  premerge: Premerge | null;
  added_at: Date;
}

/** The merged-into document as it was before the merge. */
export interface Premerge {
  originalPath: string;
  mimeType: string;
  fileSize: number;
  pageCount: number | null;
  pageEdits: unknown;
  content: string;
  proposal: Proposal | null;
  parts: MergePart[] | null;
  hadBase: boolean;
  /** The documents merged in, now in the trash. */
  sources: string[];
}

const premergePath = (id: string) => path.join("archive", `${id}.premerge.pdf`);
const premergeBasePath = (id: string) => path.join("archive", `${id}.premerge.base.pdf`);
const abs = (rel: string) => path.join(config.dataDir, rel);
const exists = (rel: string) => fs.access(abs(rel)).then(() => true, () => false);

/** The uploads a document is made of. */
function partsOf(r: Row): MergePart[] {
  return r.merge_parts ?? [{ id: r.entity_id, filename: r.original_filename, mimeType: r.mime_type, originalPath: r.original_path, pages: r.page_count ?? 0 }];
}

export async function mergeDocuments(into: string, pages: MergePage[]): Promise<void> {
  const ids = [...new Set(pages.map((p) => p.id))];
  for (const id of ids) if (busy.has(id)) throw new HttpError(409, "One of the documents is being changed. Try again in a moment.");
  for (const id of ids) busy.add(id);
  try {
    const rows = await sql<Row[]>`
      select entity_id, status, original_filename, mime_type, file_size, original_path, archive_path, thumb_path,
             page_count, page_edits, content, proposal, merge_parts, premerge, added_at
      from document where entity_id in ${sql(ids)}`;
    const byId = new Map(rows.map((r) => [r.entity_id, r]));
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) throw new HttpError(404, "One of the documents wasn't found.");
      if (r.status !== "inbox") throw new HttpError(409, `"${r.original_filename}" isn't ready in the inbox. Only documents that have been read can be merged.`);
      if (!r.archive_path || !r.page_count) throw new HttpError(409, `"${r.original_filename}" has no pages to merge.`);
    }
    const order = checkOrder(into, pages, new Map(rows.map((r) => [r.entity_id, r.page_count!])));
    const keep = byId.get(into)!;

    // Pages for the searchable PDF, and for the new original.
    const archives = new Map<string, PDFDocument>();
    const originals = new Map<string, PDFDocument>();
    for (const id of order) {
      const r = byId.get(id)!;
      const archive = await PDFDocument.load(await fs.readFile(abs(r.archive_path!)), { ignoreEncryption: true, updateMetadata: false });
      archives.set(id, archive);
      // The upload's own pages keep born-digital content as it was; images and edited pages come from the searchable PDF.
      let original = archive;
      if (r.mime_type === "application/pdf" && !r.page_edits) {
        try {
          const o = await PDFDocument.load(await fs.readFile(abs(r.original_path)), { ignoreEncryption: true, updateMetadata: false });
          if (o.getPageCount() === archive.getPageCount()) original = o;
        } catch { /* use the searchable PDF */ }
      }
      originals.set(id, original);
    }
    const mergedArchive = await PDFDocument.create();
    const mergedOriginal = await PDFDocument.create();
    for (const p of pages) {
      const [a] = await mergedArchive.copyPages(archives.get(p.id)!, [p.page - 1]);
      mergedArchive.addPage(a);
      const [o] = await mergedOriginal.copyPages(originals.get(p.id)!, [p.page - 1]);
      mergedOriginal.addPage(o);
    }
    const archiveBytes = await mergedArchive.save();
    const originalBytes = await mergedOriginal.save();

    // Keep what's needed to undo. An earlier merge's undo is replaced.
    if (keep.premerge) await dropPremerge(into, keep.premerge, keep.original_path);
    await fs.copyFile(abs(keep.archive_path!), abs(premergePath(into)));
    const hadBase = await exists(basePath(into));
    if (hadBase) await fs.rename(abs(basePath(into)), abs(premergeBasePath(into)));
    const premerge: Premerge = {
      originalPath: keep.original_path,
      mimeType: keep.mime_type,
      fileSize: Number(keep.file_size),
      pageCount: keep.page_count,
      pageEdits: keep.page_edits,
      content: keep.content,
      proposal: keep.proposal,
      parts: keep.merge_parts,
      hadBase,
      sources: order.filter((id) => id !== into),
    };

    const now = new Date();
    const originalRel = path.join("originals", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), `${into}.merged-${now.getTime()}.pdf`);
    await fs.mkdir(path.dirname(abs(originalRel)), { recursive: true });
    await fs.writeFile(abs(originalRel), originalBytes);
    await fs.writeFile(abs(keep.archive_path!), archiveBytes);

    const parts = order.flatMap((id) => partsOf(byId.get(id)!));
    const { content, pageCount } = await extractText(abs(keep.archive_path!));
    const thumb = await writeThumb(into, keep.archive_path!);
    await sql.begin(async (tx) => {
      await tx`
        update document set original_path = ${originalRel}, mime_type = 'application/pdf', file_size = ${originalBytes.length},
          content = ${content}, page_count = ${pageCount}, thumb_path = ${thumb}, page_edits = null, pages_edited_at = clock_timestamp(),
          merge_parts = ${sql.json(parts as never)}, premerge = ${sql.json(premerge as never)}, embedded_model = null,
          -- Straight to the AI: the text is already there.
          status = 'queued', proposal = null, error = null, attempts = 0, retry_at = null, locked_at = null
        where entity_id = ${into}`;
      await tx`
        update document set trashed_from = 'inbox', status = 'trashed', trashed_at = now(), locked_at = null, merged_into = ${into}
        where entity_id in ${sql(premerge.sources)}`;
    });
    await sql`select refresh_document_search(${into})`;
    kickEmbeddings();
  } finally {
    for (const id of ids) busy.delete(id);
  }
}

/** Splits a merged document back into the documents it was made from, as they were. */
export async function unmergeDocument(id: string): Promise<{ restored: string[] }> {
  if (busy.has(id)) throw new HttpError(409, "The document is being changed. Try again in a moment.");
  busy.add(id);
  try {
    const [r] = await sql<Row[]>`
      select entity_id, status, original_filename, mime_type, file_size, original_path, archive_path, thumb_path,
             page_count, page_edits, content, proposal, merge_parts, premerge, added_at
      from document where entity_id = ${id}`;
    if (!r) throw new HttpError(404, "Document not found.");
    const pre = r.premerge;
    if (!pre) throw new HttpError(409, "This document wasn't merged, or its merge can't be undone any more.");
    if (!["inbox", "queued", "analyzing", "failed"].includes(r.status)) throw new HttpError(409, "Only a merged document in the inbox can be split again.");
    const sources = await sql<{ entity_id: string }[]>`
      select entity_id from document where entity_id in ${sql(pre.sources)} and status = 'trashed' and merged_into = ${id}`;
    if (sources.length !== pre.sources.length) throw new HttpError(409, "Some of the merged documents have left the trash, so the merge can't be undone.");

    await fs.rename(abs(premergePath(id)), abs(r.archive_path!));
    await fs.rm(abs(basePath(id)), { force: true });
    if (pre.hadBase) await fs.rename(abs(premergeBasePath(id)), abs(basePath(id)));
    const thumb = await writeThumb(id, r.archive_path!);
    const merged = r.original_path;
    await sql.begin(async (tx) => {
      // The worker checks the status before saving, so an AI pass still running on the merged text is dropped.
      await tx`
        update document set original_path = ${pre.originalPath}, mime_type = ${pre.mimeType}, file_size = ${pre.fileSize},
          content = ${pre.content}, page_count = ${pre.pageCount}, thumb_path = ${thumb},
          page_edits = ${pre.pageEdits ? sql.json(pre.pageEdits as never) : null}, pages_edited_at = clock_timestamp(),
          merge_parts = ${pre.parts ? sql.json(pre.parts as never) : null}, premerge = null, embedded_model = null,
          proposal = ${pre.proposal ? sql.json(pre.proposal as never) : null}, status = 'inbox', error = null, attempts = 0, locked_at = null
        where entity_id = ${id}`;
      await tx`
        update document set status = 'inbox', trashed_at = null, trashed_from = null, merged_into = null
        where entity_id in ${sql(pre.sources)}`;
    });
    await removeIfUnused(merged);
    await sql`select refresh_document_search(${id})`;
    kickEmbeddings();
    return { restored: pre.sources };
  } finally {
    busy.delete(id);
  }
}

/** Forgets how to undo a merge, deleting the files only the undo needed. */
async function dropPremerge(id: string, pre: Premerge, currentOriginal: string): Promise<void> {
  await fs.rm(abs(premergePath(id)), { force: true });
  await fs.rm(abs(premergeBasePath(id)), { force: true });
  await sql`update document set premerge = null where entity_id = ${id}`;
  if (pre.originalPath !== currentOriginal) await removeIfUnused(pre.originalPath);
}

async function writeThumb(id: string, archiveRel: string): Promise<string | null> {
  await fs.mkdir(abs("thumbs"), { recursive: true });
  return (await renderThumb(abs(archiveRel), abs(path.join("thumbs", id)))) ? path.join("thumbs", `${id}.png`) : null;
}

/** Whether any document uses this file as its original, one of its parts, or for undoing a merge. */
export async function fileInUse(rel: string, except?: string): Promise<boolean> {
  const [hit] = await sql`
    select 1 from document
    where ${except ? sql`entity_id <> ${except} and` : sql``}
      (original_path = ${rel} or merge_parts @> ${sql.json([{ originalPath: rel }] as never)} or premerge->>'originalPath' = ${rel})
    limit 1`;
  return !!hit;
}

async function removeIfUnused(rel: string): Promise<void> {
  if (!(await fileInUse(rel))) await fs.rm(abs(rel), { force: true });
}

/** Files of a document's merges, for deleting it for good. */
export function mergeFiles(id: string, parts: MergePart[] | null, premerge: Premerge | null): string[] {
  return [premergePath(id), premergeBasePath(id), ...(parts ?? []).map((p) => p.originalPath), ...(premerge ? [premerge.originalPath] : [])];
}
