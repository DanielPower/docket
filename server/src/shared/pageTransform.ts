import type { PageOp } from "./types.ts";

/**
 * Page geometry for page edits, kept free of PDF code so it can be tested.
 *
 * Coordinates are PDF-style: points, origin at the bottom left, y up. A matrix
 * [a, b, c, d, e, f] maps (x, y) to (a·x + c·y + e, b·x + d·y + f).
 */
export type Matrix = [number, number, number, number, number, number];

/** An output page: base page `page` (1-based), drawn through `m` onto a w × h page. */
export interface PageTransform {
  page: number;
  m: Matrix;
  w: number;
  h: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** a after b: apply b first, then a. */
export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Turns a w × h page clockwise by a multiple of 90°. Returns the matrix and the new size. */
export function rotation(deg: number, w: number, h: number): { m: Matrix; w: number; h: number } {
  switch (((deg % 360) + 360) % 360) {
    case 90: return { m: [0, -1, 1, 0, 0, w], w: h, h: w };
    case 180: return { m: [-1, 0, 0, -1, w, h], w, h };
    case 270: return { m: [0, 1, -1, 0, h, 0], w: h, h: w };
    default: return { m: IDENTITY, w, h };
  }
}

/** The matrix and resulting size for one op on a page that is w × h as shown. */
export function opMatrix(op: Omit<PageOp, "from">, w: number, h: number): { m: Matrix; w: number; h: number } {
  const r = rotation(op.rotate ?? 0, w, h);
  let m = r.m;
  ({ w, h } = r);
  if (op.flipH) m = mul([-1, 0, 0, 1, w, 0], m);
  if (op.flipV) m = mul([1, 0, 0, -1, 0, h], m);
  const s = op.straighten ?? 0;
  if (s) {
    const t = (s * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const cx = w / 2;
    const cy = h / 2;
    // Clockwise about the centre, page size unchanged (the corners turn into white).
    m = mul([cos, -sin, sin, cos, cx - cx * cos - cy * sin, cy + cx * sin - cy * cos], m);
  }
  const c = op.crop;
  if (c) {
    const left = c.x * w;
    const bottom = (1 - c.y - c.h) * h;
    m = mul([1, 0, 0, 1, -left, -bottom], m);
    w = c.w * w;
    h = c.h * h;
  }
  return { m: clean(m), w: round(w), h: round(h) };
}

/**
 * Applies ops (relative to the pages as they are now) to the current
 * transforms (relative to the base document). Returns the new transforms.
 */
export function compose(current: PageTransform[], ops: PageOp[]): PageTransform[] {
  return ops.map((op) => {
    const cur = current[op.from - 1];
    if (!cur) throw new RangeError(`There is no page ${op.from}.`);
    const o = opMatrix(op, cur.w, cur.h);
    return { page: cur.page, m: clean(mul(o.m, cur.m)), w: o.w, h: o.h };
  });
}

/** The transforms for an unedited document whose pages are these sizes (as shown). */
export function identity(sizes: Array<{ w: number; h: number }>): PageTransform[] {
  return sizes.map((s, i) => ({ page: i + 1, m: IDENTITY, w: round(s.w), h: round(s.h) }));
}

export function isIdentity(t: PageTransform[], sizes: Array<{ w: number; h: number }>): boolean {
  return (
    t.length === sizes.length &&
    t.every((p, i) => p.page === i + 1 && p.m.every((v, j) => Math.abs(v - IDENTITY[j]) < 1e-6) &&
      Math.abs(p.w - sizes[i].w) < 0.01 && Math.abs(p.h - sizes[i].h) < 0.01)
  );
}

/** Checks ops from a client: real pages, sane values, at least one page left. */
export function validateOps(ops: PageOp[], pageCount: number): string | null {
  if (!ops.length) return "A document needs at least one page.";
  for (const op of ops) {
    if (!Number.isInteger(op.from) || op.from < 1 || op.from > pageCount) return `There is no page ${op.from}.`;
    if (op.straighten !== undefined && !(Math.abs(op.straighten) <= 45)) return "Straighten by at most 45°.";
    const c = op.crop;
    if (c) {
      const ok = [c.x, c.y, c.w, c.h].every((v) => Number.isFinite(v)) &&
        c.x >= 0 && c.y >= 0 && c.w >= 0.02 && c.h >= 0.02 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001;
      if (!ok) return "The crop must stay inside the page.";
    }
  }
  return null;
}

/** Rounds away floating-point noise so 90° turns stay exact. */
function clean(m: Matrix): Matrix {
  return m.map((v) => {
    const r = Math.round(v * 1e6) / 1e6;
    return Object.is(r, -0) ? 0 : r;
  }) as Matrix;
}
const round = (n: number) => Math.round(n * 1000) / 1000;
