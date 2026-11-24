/** Merge helpers that don't need PDF.js, so the inbox can use them without loading the merge view. */

/** An inbox document that can be merged. */
export interface MergeDoc {
  id: string;
  title: string;
  addedAt: string;
  pageCount: number;
  /** Shown under the title: who and how much. */
  sub?: string;
}

export interface MergePageRef {
  id: string;
  page: number;
}

/** "1 min later", "6 days earlier". */
export function scanGap(from: string, to: string): { text: string; minutes: number } {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  const min = Math.abs(ms) / 60000;
  const dir = ms >= 0 ? "later" : "earlier";
  if (min < 1) return { text: "within a minute", minutes: min };
  const [n, unit] = min < 60 ? [Math.round(min), "min"] : min < 48 * 60 ? [Math.round(min / 60), "hour"] : [Math.round(min / 1440), "day"];
  return { text: `${n} ${unit}${unit !== "min" && n > 1 ? "s" : ""} ${dir}`, minutes: min };
}

