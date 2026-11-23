import assert from "node:assert/strict";
import { test } from "node:test";
import { compose, identity, opMatrix } from "../../server/src/shared/pageTransform.ts";
import { describeChanges, detectEdges, flipItemH, flipItemV, rotateItem, startItems, toOp, type EditItem } from "../src/pageEdits.ts";

const W = 300, H = 500;

/** The same action as a one-step op on the page as currently shown. */
const STEP: Record<string, object> = {
  r90: { rotate: 90 }, r180: { rotate: 180 }, r270: { rotate: 270 }, fh: { flipH: true },
  fv: { flipV: true }, crop: { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } },
};
const ACT: Record<string, (it: EditItem) => EditItem> = {
  r90: (it) => rotateItem(it, 90), r180: (it) => rotateItem(it, 180), r270: (it) => rotateItem(it, 270),
  fh: flipItemH, fv: flipItemV,
  crop: (it) => {
    // Cropping an already cropped page: the new box is inside the old one.
    const c = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 };
    if (!it.crop) return { ...it, crop: c };
    const o = it.crop;
    return { ...it, crop: { x: o.x + c.x * o.w, y: o.y + c.y * o.h, w: c.w * o.w, h: c.h * o.h } };
  },
};

test("folding visual actions into one edit matches applying them one by one", () => {
  const names = Object.keys(ACT);
  let seed = 7;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let run = 0; run < 300; run++) {
    let item = startItems(1)[0];
    let steps = identity([{ w: W, h: H }]);
    const seq: string[] = [];
    for (let i = 0; i < 1 + Math.floor(rand() * 6); i++) {
      const n = names[Math.floor(rand() * names.length)];
      // A crop must come last within the folded edit only if it's the only one: keep at most one.
      if (n === "crop" && seq.includes("crop")) continue;
      seq.push(n);
      item = ACT[n](item);
      steps = compose(steps, [{ from: 1, ...STEP[n] }]);
    }
    const folded = opMatrix(toOp(item), W, H);
    const msg = seq.join(" ");
    assert.ok(Math.abs(folded.w - steps[0].w) < 1e-6 && Math.abs(folded.h - steps[0].h) < 1e-6, `size after ${msg}`);
    folded.m.forEach((v, i) => assert.ok(Math.abs(v - steps[0].m[i]) < 1e-6, `matrix after ${msg}: ${folded.m} vs ${steps[0].m}`));
  }
});

test("a flip after straightening keeps the picture straight", () => {
  const item = flipItemH({ ...startItems(1)[0], s: 2 });
  assert.equal(item.s, -2);
});

test("describeChanges says what will happen", () => {
  const items = startItems(4);
  items[1] = rotateItem(items[1], 90);
  items[2] = flipItemV(items[2]);
  items[3] = { ...items[3], removed: true };
  [items[0], items[1]] = [items[1], items[0]];
  assert.deepEqual(describeChanges(items).map((c) => c.text), [
    "Page 2 rotated right",
    "Page 3 flipped top to bottom",
    "Page 4 removed",
    "New page order: 2, 1, 3",
  ]);
  assert.deepEqual(describeChanges(startItems(3)), []);
});

test("detectEdges finds a bright sheet on a dark desk and nothing on a plain page", () => {
  const w = 100, h = 120;
  const lum = new Uint8Array(w * h).fill(60);
  for (let y = 20; y < 100; y++) for (let x = 30; x < 80; x++) lum[y * w + x] = 235;
  const box = detectEdges(lum, w, h)!;
  assert.ok(Math.abs(box.x - 0.3) < 0.02 && Math.abs(box.y - 20 / 120) < 0.02 && Math.abs(box.w - 0.5) < 0.02 && Math.abs(box.h - 80 / 120) < 0.02, JSON.stringify(box));
  assert.equal(detectEdges(new Uint8Array(w * h).fill(240), w, h), null);
});
