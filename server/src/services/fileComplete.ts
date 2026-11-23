/**
 * Whether the file's last bytes are the format's end marker, i.e. the writer
 * got to the end. Formats without one (TIFF, text) count as complete; for
 * those the size check is all there is.
 */
export function looksComplete(head: Buffer, tail: Buffer): boolean {
  // PDF: the trailer ends with %%EOF, possibly followed by a newline or padding.
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return tail.toString("latin1").includes("%%EOF");
  // JPEG: FF D9 (end of image); some cameras and scanners add a few bytes after it.
  if (head[0] === 0xff && head[1] === 0xd8) return tail.subarray(-64).includes(Buffer.from([0xff, 0xd9]));
  // PNG: the IEND chunk, always the last 12 bytes.
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return tail.subarray(-12).subarray(4, 8).toString("latin1") === "IEND";
  }
  return true;
}
