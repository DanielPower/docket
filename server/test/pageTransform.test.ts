import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, compose, identity, isIdentity, opMatrix, validateOps } from "../src/shared/pageTransform.ts";

const LETTER = { w: 612, h: 792 };
const near = (a: [number, number], b: [number, number]) =>
  assert.ok(Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3, `${a} != ${b}`);

test("rotating right turns the page and moves the top left corner to the top right", () => {
  const r = opMatrix({ rotate: 90 }, LETTER.w, LETTER.h);
  assert.deepEqual([r.w, r.h], [792, 612]);
  near(apply(r.m, 0, 792), [792, 612]); // top left -> top right
  near(apply(r.m, 0, 0), [0, 612]); // bottom left -> top left
  near(apply(r.m, 612, 0), [0, 0]); // bottom right -> bottom left
});

test("rotating left is the inverse of rotating right", () => {
  const [p] = compose(compose(identity([LETTER]), [{ from: 1, rotate: 90 }]), [{ from: 1, rotate: 270 }]);
  assert.ok(isIdentity([p], [LETTER]));
});

test("four right turns, or two flips, come back to the original", () => {
  let t = identity([LETTER]);
  for (let i = 0; i < 4; i++) t = compose(t, [{ from: 1, rotate: 90 }]);
  assert.ok(isIdentity(t, [LETTER]));
  t = compose(compose(identity([LETTER]), [{ from: 1, flipH: true }]), [{ from: 1, flipH: true }]);
  assert.ok(isIdentity(t, [LETTER]));
});

test("flip left-right mirrors x only", () => {
  const r = opMatrix({ flipH: true }, 100, 200);
  near(apply(r.m, 10, 20), [90, 20]);
});

test("flip after a rotation flips what you see, not the original page", () => {
  // Rotate right then flip left-right: the original top left (0, h) ends at the top left.
  const r = opMatrix({ rotate: 90, flipH: true }, 100, 200);
  assert.deepEqual([r.w, r.h], [200, 100]);
  near(apply(r.m, 0, 200), [0, 100]);
});

test("crop is measured from the top left and sets the page size", () => {
  const r = opMatrix({ crop: { x: 0.1, y: 0.25, w: 0.5, h: 0.5 } }, 100, 200);
  assert.deepEqual([r.w, r.h], [50, 100]);
  near(apply(r.m, 10, 150), [0, 100]); // the crop's top left becomes the page's top left
  near(apply(r.m, 60, 50), [50, 0]);
});

test("straighten turns clockwise about the centre and keeps the size", () => {
  const r = opMatrix({ straighten: 90 }, 100, 100);
  assert.deepEqual([r.w, r.h], [100, 100]);
  near(apply(r.m, 50, 50), [50, 50]);
  near(apply(r.m, 100, 50), [50, 0]); // right middle -> bottom middle
});

test("compose keeps page order, removes pages, and builds on earlier edits", () => {
  const sizes = [LETTER, LETTER, { w: 300, h: 400 }];
  let t = compose(identity(sizes), [{ from: 3, rotate: 90 }, { from: 1 }]);
  assert.deepEqual(t.map((p) => p.page), [3, 1]);
  assert.deepEqual([t[0].w, t[0].h], [400, 300]);
  t = compose(t, [{ from: 2 }, { from: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }]);
  assert.deepEqual(t.map((p) => p.page), [1, 3]);
  assert.deepEqual([t[1].w, t[1].h], [200, 300]);
  assert.throws(() => compose(t, [{ from: 3 }]));
});

test("validateOps rejects bad input", () => {
  assert.equal(validateOps([], 2), "A document needs at least one page.");
  assert.match(validateOps([{ from: 3 }], 2)!, /no page 3/);
  assert.match(validateOps([{ from: 1, crop: { x: 0.6, y: 0, w: 0.6, h: 1 } }], 2)!, /inside/);
  assert.match(validateOps([{ from: 1, straighten: 60 }], 2)!, /45/);
  assert.equal(validateOps([{ from: 2, rotate: 90 }, { from: 1 }], 2), null);
});
