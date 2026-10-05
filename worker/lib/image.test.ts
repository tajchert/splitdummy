import { describe, expect, it } from "vitest";
import { SECRET, includesAscii, jpeg, webp } from "../../test/fixtures/images";
import { sniffImage, stripMetadata } from "./image";

const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

describe("sniffImage", () => {
  it("reads JPEG dimensions from the SOF segment, past fill bytes", () => {
    expect(sniffImage(jpeg({ width: 1234, height: 987, exif: true, fill: true }))).toEqual({ type: "image/jpeg", width: 1234, height: 987 });
  });

  it("reads WebP dimensions for extended, lossy and lossless files", () => {
    expect(sniffImage(webp({ width: 2000, height: 1500 }))).toEqual({ type: "image/webp", width: 2000, height: 1500 });
    expect(sniffImage(webp({ width: 640, height: 480, format: "VP8" }))).toEqual({ type: "image/webp", width: 640, height: 480 });
    expect(sniffImage(webp({ width: 300, height: 200, format: "VP8L" }))).toEqual({ type: "image/webp", width: 300, height: 200 });
  });

  it("rejects other formats and truncated files", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull(); // PNG
    expect(sniffImage(jpeg().subarray(0, 30))).toBeNull();
    const notWebp = webp();
    notWebp.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(sniffImage(notWebp)).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("stripMetadata", () => {
  it("drops EXIF/XMP (APP1) and comments from JPEG and keeps the image segments", () => {
    const input = jpeg({ width: 800, height: 600, exif: true, comment: true });
    const out = stripMetadata(input, "image/jpeg");
    expect(includesAscii(input, SECRET)).toBe(true);
    expect(includesAscii(out, SECRET)).toBe(false);
    expect(includesAscii(out, "JFIF")).toBe(true);
    expect(sniffImage(out)).toEqual({ type: "image/jpeg", width: 800, height: 600 });
    expect([...out.subarray(-7)]).toEqual([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
  });

  it("drops EXIF and XMP chunks from WebP, clears their VP8X flags and fixes the RIFF size", () => {
    const out = stripMetadata(webp({ exif: true, xmp: true }), "image/webp");
    expect(includesAscii(out, SECRET)).toBe(false);
    expect(u32le(out, 4)).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0); // VP8X flags byte: RIFF(12) + chunk header(8)
    expect(sniffImage(out)).toEqual({ type: "image/webp", width: 1600, height: 1200 });
  });

  it("returns a copy and never mutates its input", () => {
    const input = webp({ exif: true });
    const before = [...input];
    stripMetadata(input, "image/webp");
    expect([...input]).toEqual(before);
  });
});
