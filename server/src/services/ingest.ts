import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import { looksComplete } from "./fileComplete.ts";
import { basePath } from "./pages.ts";

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/tiff": ".tif",
  "image/gif": ".gif",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

/** Identifies the file by its bytes; the client-supplied type is not trusted. */
export function sniffMime(buf: Buffer, filename: string): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head4 = buf.subarray(0, 4).toString("latin1");
  if (head4 === "II*\0" || head4 === "MM\0*") return "image/tiff";
  if (head4 === "GIF8") return "image/gif";
  const ext = path.extname(filename).toLowerCase();
  if ([".txt", ".md", ".markdown"].includes(ext) && !buf.includes(0)) {
    return ext === ".txt" ? "text/plain" : "text/markdown";
  }
  return null;
}

export interface IngestResult {
  id: string;
  duplicate: boolean;
  /** The file was in the trash and has been restored. */
  restored?: boolean;
}

/** Days a document stays in the trash before it's deleted for good. */
export const TRASH_DAYS = 30;

export async function ingestBuffer(buf: Buffer, filename: string): Promise<IngestResult> {
  const mime = sniffMime(buf, filename);
  if (!mime) throw new HttpError(415, `Unsupported file type: ${filename}. Supported: PDF, PNG, JPEG, TIFF, GIF, TXT, MD.`);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  const [dupe] = await sql<{ entity_id: string; status: string }[]>`select entity_id, status from document where sha256 = ${sha256}`;
  if (dupe?.status === "trashed") {
    // Adding a file that's in the trash brings it back.
    await restoreDocument(dupe.entity_id);
    return { id: dupe.entity_id, duplicate: false, restored: true };
  }
  if (dupe) return { id: dupe.entity_id, duplicate: true };

  const id = crypto.randomUUID();
  const now = new Date();
  const rel = path.join("originals", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), id + EXT_BY_MIME[mime]);
  const abs = path.join(config.dataDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);

  const title = path.basename(filename, path.extname(filename)).replace(/[_]+/g, " ").trim() || "Untitled";
  try {
    await sql.begin(async (tx) => {
      await tx`insert into entity (id, kind, title) values (${id}, 'document', ${title})`;
      await tx`
        insert into document (entity_id, original_filename, mime_type, file_size, sha256, original_path)
        values (${id}, ${filename}, ${mime}, ${buf.length}, ${sha256}, ${rel})`;
    });
  } catch (err) {
    await fs.rm(abs, { force: true });
    // Lost a race with an identical upload.
    const [again] = await sql<{ entity_id: string }[]>`select entity_id from document where sha256 = ${sha256}`;
    if (again) return { id: again.entity_id, duplicate: true };
    throw err;
  }
  return { id, duplicate: false };
}

/** Moves a document to the trash. It can be restored until it's purged. */
export async function trashDocument(id: string): Promise<void> {
  const [d] = await sql`
    update document set trashed_from = case when status in ('inbox', 'filed') then status else 'inbox' end,
      status = 'trashed', trashed_at = now(), locked_at = null
    where entity_id = ${id} and status <> 'trashed' returning entity_id`;
  if (!d) throw new HttpError(404, "Document not found, or already in the trash.");
}

/** Brings a document back from the trash to where it was (inbox or filed). */
export async function restoreDocument(id: string): Promise<void> {
  const [d] = await sql`
    update document set status = coalesce(trashed_from, 'inbox'), trashed_at = null, trashed_from = null
    where entity_id = ${id} and status = 'trashed' returning entity_id`;
  if (!d) throw new HttpError(404, "That document isn't in the trash.");
}

/** Deletes documents that have been in the trash longer than TRASH_DAYS. Returns how many. */
export async function purgeTrash(all = false): Promise<number> {
  const rows = await sql<{ entity_id: string }[]>`
    select entity_id from document where status = 'trashed'
      ${all ? sql`` : sql`and trashed_at < now() - make_interval(days => ${TRASH_DAYS})`}`;
  for (const r of rows) await deleteDocument(r.entity_id);
  return rows.length;
}

/** Deletes a document and its files for good. */
export async function deleteDocument(id: string): Promise<void> {
  const [doc] = await sql<{ original_path: string; archive_path: string | null; thumb_path: string | null }[]>`
    select original_path, archive_path, thumb_path from document where entity_id = ${id}`;
  if (!doc) throw new HttpError(404, "Document not found.");
  await sql`delete from entity where id = ${id}`;
  for (const p of [doc.original_path, doc.archive_path, doc.thumb_path, basePath(id)]) {
    if (p) await fs.rm(path.join(config.dataDir, p), { force: true });
  }
}

/**
 * How often the consume folder is scanned. It's usually an NFS or SMB share
 * written by a scanner on another machine, where file system events never
 * fire, so scanning is the only signal there is. One readdir and a stat per
 * file each second is cheap.
 */
const POLL_MS = 1000;
/** A file that stays incomplete this long is taken anyway, so it shows up as unreadable instead of waiting forever. */
const GIVE_UP_MS = 2 * 60_000;

/** Reads the first and last KB. Opening the file also makes an NFS client fetch fresh attributes (close-to-open), so the size isn't a cached one. */
async function probe(file: string): Promise<{ size: number; complete: boolean } | null> {
  const fh = await fs.open(file, "r").catch(() => null);
  if (!fh) return null;
  try {
    const { size } = await fh.stat();
    if (size === 0) return { size, complete: false };
    const head = Buffer.alloc(Math.min(1024, size));
    const tail = Buffer.alloc(Math.min(1024, size));
    await fh.read(head, 0, head.length, 0);
    await fh.read(tail, 0, tail.length, size - tail.length);
    return { size, complete: looksComplete(head, tail) };
  } finally {
    await fh.close();
  }
}

/**
 * Scans the consume directory every second. A file is ingested, then
 * removed, once it is complete (its format's end marker is there) and its
 * size hasn't changed since the previous scan, so half-copied scans aren't
 * picked up.
 */
export function startConsumeWatcher(log: (msg: string) => void): void {
  if (!config.consumeDir) return;
  /** Size at the previous scan, and since when it has been that size. */
  const seen = new Map<string, { size: number; since: number }>();
  /**
   * Files that couldn't be removed or moved to .failed (a read-only share, say),
   * by size. They're left alone until they change, instead of being retried
   * every second.
   */
  const stuck = new Map<string, number>();
  const tick = async () => {
    try {
      await fs.mkdir(config.consumeDir, { recursive: true });
      const names = await listFiles(config.consumeDir);
      for (const file of seen.keys()) if (!names.includes(file)) seen.delete(file);
      for (const file of stuck.keys()) if (!names.includes(file)) stuck.delete(file);
      for (const file of names) {
        const p = await probe(file);
        if (!p) continue;
        if (stuck.get(file) === p.size) continue;
        stuck.delete(file);
        const prev = seen.get(file);
        if (prev?.size !== p.size) {
          seen.set(file, { size: p.size, since: Date.now() });
          continue;
        }
        if (!p.complete) {
          if (Date.now() - prev.since < GIVE_UP_MS) continue;
          log(`${file} still looks incomplete after ${GIVE_UP_MS / 60_000} minutes without growing; taking it anyway`);
        }
        seen.delete(file);
        let res: IngestResult | null = null;
        try {
          res = await ingestBuffer(await fs.readFile(file), path.basename(file));
          log(`consumed ${file} -> ${res.id}${res.duplicate ? " (duplicate)" : ""}`);
          await fs.rm(file);
        } catch (err) {
          if (!res) log(`could not consume ${file}: ${(err as Error).message}`);
          // Taken but not removable, or not taken: move it out of the way if possible.
          const failedDir = path.join(config.consumeDir, ".failed");
          const moved = res
            ? false
            : await fs.mkdir(failedDir, { recursive: true })
                .then(() => fs.rename(file, path.join(failedDir, path.basename(file))))
                .then(() => true, () => false);
          if (!moved) {
            stuck.set(file, p.size);
            log(`can't remove or move ${file} (read-only?); leaving it alone until it changes`);
          }
        }
      }
    } catch (err) {
      log(`consume watcher error: ${(err as Error).message}`);
    }
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, 1000);
}

/**
 * Not scans: hidden files and NAS system folders (QNAP @Recently-Snapshot,
 * Synology @eaDir and #recycle, Windows desktop.ini and Thumbs.db).
 */
const SKIP_NAME = /^[.@#~]|^(desktop\.ini|thumbs\.db)$/i;

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_NAME.test(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listFiles(p)));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}
