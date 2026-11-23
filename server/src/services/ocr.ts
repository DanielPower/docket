import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.ts";

const execFileAsync = promisify(execFile);

const INSTALL_HINT: Record<string, string> = {
  ocrmypdf: "Install OCRmyPDF (macOS: brew install ocrmypdf; Debian/Ubuntu: apt install ocrmypdf).",
  pdftotext: "It is part of Poppler (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils).",
  pdfinfo: "It is part of Poppler (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils).",
  pdftoppm: "It is part of Poppler (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils).",
};

/** A required program isn't installed. Retrying can't help, so the worker fails the document at once. */
export class MissingToolError extends Error {}

function missingToolMessage(bin: string): string {
  const name = path.basename(bin);
  return `${bin} is not installed or not on the PATH. ${INSTALL_HINT[name] ?? ""}`.trim();
}

/** Runs a program, turning "command not found" into a MissingToolError with install instructions. */
async function run(bin: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) {
  try {
    return await execFileAsync(bin, args, opts);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") throw new MissingToolError(missingToolMessage(bin));
    throw err;
  }
}

/** Returns a message for each OCR program that can't be found. Empty when everything is installed. */
export async function checkOcrTools(): Promise<string[]> {
  const tools: Array<[string, string[]]> = [
    [config.ocr.ocrmypdfBin, ["--version"]],
    ["pdftotext", ["-v"]],
    ["pdfinfo", ["-v"]],
    ["pdftoppm", ["-v"]],
  ];
  const missing: string[] = [];
  for (const [bin, args] of tools) {
    try {
      await execFileAsync(bin, args, { timeout: 30_000 });
    } catch (err) {
      // Only "not found" matters here; some versions exit non-zero for -v.
      if ((err as { code?: unknown }).code === "ENOENT") missing.push(missingToolMessage(bin));
    }
  }
  return missing;
}

export interface OcrResult {
  content: string;
  archivePath: string | null;
  thumbPath: string | null;
  pageCount: number | null;
}

export function isOcrable(mime: string): boolean {
  return mime === "application/pdf" || mime.startsWith("image/");
}

/**
 * Produces a searchable PDF (text layer added where pages have none), extracts
 * its text, and renders a first-page thumbnail. Plain-text files are read as-is.
 */
export async function runOcr(opts: { id: string; originalPath: string; mime: string }): Promise<OcrResult> {
  const original = path.join(config.dataDir, opts.originalPath);
  if (opts.mime.startsWith("text/")) {
    return { content: await fs.readFile(original, "utf8"), archivePath: null, thumbPath: null, pageCount: null };
  }

  const archiveRel = path.join("archive", `${opts.id}.pdf`);
  const thumbRel = path.join("thumbs", `${opts.id}.png`);
  const archive = path.join(config.dataDir, archiveRel);
  const thumbBase = path.join(config.dataDir, "thumbs", opts.id);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.mkdir(path.dirname(thumbBase), { recursive: true });

  await ocrPdf(original, archive, { rotatePages: true, imageDpi: opts.mime.startsWith("image/") ? 300 : undefined });
  const { content, pageCount } = await extractText(archive);
  const thumbPath = (await renderThumb(archive, thumbBase)) ? thumbRel : null;
  return { content, archivePath: archiveRel, thumbPath, pageCount };
}

/**
 * Runs OCRmyPDF: adds a text layer to pages that are images and leaves pages
 * that already have text alone. `rotatePages` lets it turn pages it reads as
 * sideways; page edits turn it off, since the owner chose the rotation.
 */
export async function ocrPdf(input: string, output: string, opts: { rotatePages: boolean; imageDpi?: number }): Promise<void> {
  const args = [
    "--skip-text", // keep born-digital text; only OCR pages that are images
    ...(opts.rotatePages ? ["--rotate-pages"] : []),
    "--output-type", "pdf",
    "-l", config.ocr.languages,
    "-j", "1",
    "-q",
  ];
  if (opts.imageDpi) args.push("--image-dpi", String(opts.imageDpi));
  try {
    await run(config.ocr.ocrmypdfBin, [...args, input, output], { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err instanceof MissingToolError) throw err;
    const e = err as { code?: number | string; stderr?: string; message: string };
    // ocrmypdf exit codes: 2 bad input, 8 encrypted PDF, 6 "already has text" (not raised with --skip-text)
    const detail = (e.stderr || e.message).trim().split("\n").slice(-5).join("\n");
    if (e.code === 8) throw new Error("The PDF is encrypted; decrypt it and upload again.");
    throw new Error(`OCR failed (exit ${e.code}): ${detail}`);
  }
}

/** The text of a searchable PDF and its page count. */
export async function extractText(pdf: string): Promise<{ content: string; pageCount: number | null }> {
  const { stdout: text } = await run("pdftotext", ["-layout", "-enc", "UTF-8", pdf, "-"], { maxBuffer: 256 * 1024 * 1024 });
  const { stdout: info } = await run("pdfinfo", [pdf]);
  const pages = /^Pages:\s+(\d+)/m.exec(info);
  return { content: cleanText(text), pageCount: pages ? Number(pages[1]) : null };
}

/** Renders the first page to `<thumbBase>.png`. False if that failed (a thumbnail is cosmetic). */
export async function renderThumb(pdf: string, thumbBase: string): Promise<boolean> {
  try {
    await run("pdftoppm", ["-png", "-f", "1", "-l", "1", "-singlefile", "-scale-to", "480", pdf, thumbBase]);
    return true;
  } catch (err) {
    // A missing program is not cosmetic.
    if (err instanceof MissingToolError) throw err;
    return false;
  }
}

/** Renders one page (1-based) as a 300 dpi JPEG at `<outBase>.jpg`. */
export async function renderPageJpeg(pdf: string, page: number, outBase: string): Promise<void> {
  await run("pdftoppm", ["-jpeg", "-jpegopt", "quality=90", "-r", "300", "-f", String(page), "-l", String(page), "-singlefile", pdf, outBase]);
}

function cleanText(s: string): string {
  return s
    .replace(/\f/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
