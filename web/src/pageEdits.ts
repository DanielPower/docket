import { mul, opMatrix, type Matrix } from "../../server/src/shared/pageTransform.ts";
import type { CropBox, PageOp } from "./types";

/**
 * One page in the page editor. The edit reads "rotate r clockwise, mirror
 * left to right if m, straighten s degrees, then crop", the order the server
 * applies a PageOp in. Actions are what you see, so each one is folded into
 * that form (a flip after a crop mirrors the crop, and so on).
 */
export type EditItem = {
  /** Stable key for React and selection. */
  key: number;
  /** 1-based page number in the document as it is now. */
  from: number;
  r: 0 | 90 | 180 | 270;
  m: boolean;
  s: number;
  crop: CropBox | null;
  removed: boolean;
};

export const startItems = (pageCount: number): EditItem[] =>
  Array.from({ length: pageCount }, (_, i) => ({ key: i + 1, from: i + 1, r: 0, m: false, s: 0, crop: null, removed: false }));

const norm = (d: number) => ((((d % 360) + 360) % 360) as EditItem["r"]);

/** Turns the page as you see it, clockwise by `turn` (90, 180 or 270). */
export function rotateItem(it: EditItem, turn: 90 | 180 | 270): EditItem {
  let crop = it.crop;
  for (let i = 0; i < turn / 90; i++) crop = crop && { x: 1 - crop.y - crop.h, y: crop.x, w: crop.h, h: crop.w };
  // Under a mirror a clockwise turn becomes an anticlockwise one.
  return { ...it, r: norm(it.m ? it.r - turn : it.r + turn), crop };
}

/** Mirrors the page as you see it, left to right. */
export function flipItemH(it: EditItem): EditItem {
  return { ...it, m: !it.m, s: it.s ? -it.s : 0, crop: it.crop && { ...it.crop, x: 1 - it.crop.x - it.crop.w } };
}

/** Mirrors the page as you see it, top to bottom (a half turn, then left to right). */
export const flipItemV = (it: EditItem) => flipItemH(rotateItem(it, 180));

export const isChanged = (it: EditItem) => it.r !== 0 || it.m || it.s !== 0 || it.crop !== null;

export function toOp(it: EditItem): PageOp {
  const op: PageOp = { from: it.from };
  if (it.r) op.rotate = it.r;
  if (it.m) op.flipH = true;
  if (it.s) op.straighten = it.s;
  if (it.crop) op.crop = it.crop;
  return op;
}

/** What saving would change, in words: one line per changed or removed page, then the order. */
export function describeChanges(items: EditItem[]): Array<{ key: number | "order"; kind: "edit" | "removed" | "order"; text: string }> {
  const out: ReturnType<typeof describeChanges> = [];
  for (const it of items) {
    if (it.removed) {
      out.push({ key: it.key, kind: "removed", text: `Page ${it.from} removed` });
      continue;
    }
    if (!isChanged(it)) continue;
    const parts: string[] = [];
    if (it.m && it.r === 180) parts.push("flipped top to bottom");
    else {
      if (it.r) parts.push(it.r === 90 ? "rotated right" : it.r === 270 ? "rotated left" : "turned upside down");
      if (it.m) parts.push("flipped left to right");
    }
    if (it.s) parts.push(`straightened ${Math.abs(it.s)}°`);
    if (it.crop) parts.push("cropped");
    out.push({ key: it.key, kind: "edit", text: `Page ${it.from} ${joinWords(parts)}` });
  }
  const kept = items.filter((it) => !it.removed).map((it) => it.from);
  if (kept.some((n, i) => i > 0 && n < kept[i - 1])) out.push({ key: "order", kind: "order", text: `New page order: ${kept.join(", ")}` });
  return out;
}

const joinWords = (p: string[]) => (p.length < 2 ? p.join("") : `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`);

/**
 * The canvas transform that draws a page bitmap (the page as shown, `w` × `h`
 * points, `k` pixels per point) through an edit onto a canvas at `k2` pixels
 * per point. Returns it with the output size in points.
 */
export function canvasTransform(it: Pick<EditItem, "r" | "m" | "s" | "crop">, w: number, h: number, k: number, k2: number) {
  const o = opMatrix({ rotate: it.r, flipH: it.m, straighten: it.s, crop: it.crop }, w, h);
  const fin: Matrix = [1 / k, 0, 0, -1 / k, 0, h];
  const fout: Matrix = [k2, 0, 0, -k2, 0, o.h * k2];
  return { t: mul(fout, mul(o.m, fin)), w: o.w, h: o.h };
}

/**
 * Finds a sheet of paper in a photo: the box of rows and columns that are
 * mostly brighter than an Otsu threshold. `lum` is width × height grey levels.
 * Returns null when nothing stands out (a plain scan, say).
 */
export function detectEdges(lum: Uint8Array | Uint8ClampedArray, width: number, height: number): CropBox | null {
  const hist = new Array(256).fill(0);
  for (const v of lum) hist[v]++;
  const total = lum.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  const rowOk = (y: number) => {
    let n = 0;
    for (let x = 0; x < width; x++) if (lum[y * width + x] > threshold) n++;
    return n / width > 0.35;
  };
  const colOk = (x: number) => {
    let n = 0;
    for (let y = 0; y < height; y++) if (lum[y * width + x] > threshold) n++;
    return n / height > 0.35;
  };
  let top = 0, bottom = height - 1, left = 0, right = width - 1;
  while (top < bottom && !rowOk(top)) top++;
  while (bottom > top && !rowOk(bottom)) bottom--;
  while (left < right && !colOk(left)) left++;
  while (right > left && !colOk(right)) right--;
  const box = { x: left / width, y: top / height, w: (right + 1 - left) / width, h: (bottom + 1 - top) / height };
  // Nearly the whole image, or a sliver: no sheet found.
  if (box.w * box.h > 0.95 || box.w < 0.15 || box.h < 0.15) return null;
  return box;
}
