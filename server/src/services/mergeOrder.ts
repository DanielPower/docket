import { HttpError } from "../errors.ts";

export interface MergePage {
  id: string;
  /** 1-based, in that document's pages as they are now. */
  page: number;
}

/** Most documents one merge takes. */
export const MAX_MERGE = 20;

/** Checks a page order: every page of every document exactly once, `into` among them. Returns the documents in order of first page. */
export function checkOrder(into: string, pages: MergePage[], pageCounts: Map<string, number>): string[] {
  const ids = [...new Set(pages.map((p) => p.id))];
  if (!ids.includes(into)) throw new HttpError(400, "The pages must include the document being merged into.");
  if (ids.length < 2) throw new HttpError(400, "Choose at least one other document to merge.");
  if (ids.length > MAX_MERGE) throw new HttpError(400, `At most ${MAX_MERGE} documents can be merged at once.`);
  const seen = new Set<string>();
  for (const p of pages) {
    const n = pageCounts.get(p.id);
    if (n === undefined) throw new HttpError(404, "One of the documents wasn't found.");
    if (p.page < 1 || p.page > n) throw new HttpError(400, `Page ${p.page} doesn't exist in one of the documents.`);
    const key = `${p.id}:${p.page}`;
    if (seen.has(key)) throw new HttpError(400, "A page is listed twice.");
    seen.add(key);
  }
  const total = ids.reduce((s, id) => s + pageCounts.get(id)!, 0);
  if (seen.size !== total) throw new HttpError(400, "Every page of the chosen documents must be included. Remove pages with Edit pages afterwards.");
  return ids;
}

