import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOrder } from "../src/services/mergeOrder.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const counts = new Map([[A, 2], [B, 1]]);

test("a page order lists the documents in order of their first page", () => {
  assert.deepEqual(checkOrder(A, [{ id: A, page: 1 }, { id: A, page: 2 }, { id: B, page: 1 }], counts), [A, B]);
  assert.deepEqual(checkOrder(A, [{ id: B, page: 1 }, { id: A, page: 2 }, { id: A, page: 1 }], counts), [B, A]);
});

test("pages of different documents can be interleaved", () => {
  assert.deepEqual(checkOrder(B, [{ id: A, page: 1 }, { id: B, page: 1 }, { id: A, page: 2 }], counts), [A, B]);
});

test("every page must be there exactly once", () => {
  assert.throws(() => checkOrder(A, [{ id: A, page: 1 }, { id: B, page: 1 }], counts), /Every page/);
  assert.throws(() => checkOrder(A, [{ id: A, page: 1 }, { id: A, page: 1 }, { id: B, page: 1 }], counts), /twice/);
  assert.throws(() => checkOrder(A, [{ id: A, page: 1 }, { id: A, page: 3 }, { id: B, page: 1 }], counts), /doesn't exist/);
});

test("the document merged into must be included, with at least one other", () => {
  assert.throws(() => checkOrder(B, [{ id: A, page: 1 }, { id: A, page: 2 }], counts), /merged into/);
  assert.throws(() => checkOrder(A, [{ id: A, page: 1 }, { id: A, page: 2 }], counts), /at least one/);
});
