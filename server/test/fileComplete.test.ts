import assert from "node:assert/strict";
import { test } from "node:test";
import { looksComplete } from "../src/services/fileComplete.ts";

const check = (buf: Buffer) => looksComplete(buf.subarray(0, 1024), buf.subarray(-1024));

test("a PDF is complete once its %%EOF trailer is written", () => {
  const body = Buffer.from("%PDF-1.7\n" + "x".repeat(5000) + "\ntrailer\n<<>>\nstartxref\n123\n");
  assert.equal(check(body), false);
  assert.equal(check(Buffer.concat([body, Buffer.from("%%EOF\n")])), true);
  // Half written: the trailer isn't there yet.
  assert.equal(check(body.subarray(0, 3000)), false);
});

test("a JPEG is complete once its end-of-image marker is written", () => {
  const start = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(2000).fill(7)]);
  assert.equal(check(start), false);
  assert.equal(check(Buffer.concat([start, Buffer.from([0xff, 0xd9])])), true);
  // A few bytes of padding after the marker still count.
  assert.equal(check(Buffer.concat([start, Buffer.from([0xff, 0xd9, 0, 0, 0])])), true);
});

test("a PNG is complete once its IEND chunk is written", () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(500).fill(1)]);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  assert.equal(check(sig), false);
  assert.equal(check(Buffer.concat([sig, iend])), true);
});

test("formats without an end marker rely on the size check alone", () => {
  assert.equal(check(Buffer.from("II*\u0000 some tiff bytes")), true);
  assert.equal(check(Buffer.from("plain text")), true);
});
