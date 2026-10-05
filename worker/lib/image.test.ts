import { describe, expect, it } from "vitest";
import { JPEG_SOS, SECRET, bytes, includesAscii, jpeg, jpegSeg, jpegSof, webp } from "../../test/fixtures/images";
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

describe("hardened JPEG handling", () => {
  const SOI = [0xff, 0xd8];
  const EOI = [0xff, 0xd9];
  const scan = [0x12, 0x34, 0xff, 0x00, 0x56];

  it("removes data appended after EOI", () => {
    const input = bytes([...jpeg({ exif: true })], jpegSeg(0xe1, `Exif\0\0${SECRET}`), [0xff, 0xd8, 0xaa]);
    const out = stripMetadata(input, "image/jpeg");
    expect(includesAscii(out, SECRET)).toBe(false);
    expect([...out.subarray(-2)]).toEqual(EOI);
    expect(sniffImage(out)).toEqual({ type: "image/jpeg", width: 1600, height: 1200 });
  });

  it("removes APP1 placed between scans and still parses the file", () => {
    const input = bytes(SOI, jpegSof(50, 40), JPEG_SOS, scan, [0xff, 0xd3, 0x77], jpegSeg(0xe1, `Exif\0\0${SECRET}`), JPEG_SOS, scan, EOI);
    expect(sniffImage(input)).toEqual({ type: "image/jpeg", width: 50, height: 40 });
    const out = stripMetadata(input, "image/jpeg");
    expect(includesAscii(out, SECRET)).toBe(false);
    expect(out.length).toBe(input.length - jpegSeg(0xe1, `Exif\0\0${SECRET}`).length);
    expect(sniffImage(out)).toEqual({ type: "image/jpeg", width: 50, height: 40 });
  });

  it("keeps ICC and Adobe segments but drops MPF and other APPn/COM", () => {
    const input = bytes(
      SOI,
      jpegSeg(0xe2, "ICC_PROFILE\0keepicc"),
      jpegSeg(0xe2, "MPF\0dropmpf"),
      jpegSeg(0xe3, "dropapp3"),
      jpegSeg(0xec, "dropapp12"),
      jpegSeg(0xee, "Adobe-keep"),
      jpegSeg(0xfe, "dropcom"),
      jpegSof(10, 10),
      JPEG_SOS,
      scan,
      EOI,
    );
    const out = stripMetadata(input, "image/jpeg");
    for (const kept of ["keepicc", "Adobe-keep"]) expect(includesAscii(out, kept)).toBe(true);
    for (const dropped of ["dropmpf", "dropapp3", "dropapp12", "dropcom"]) expect(includesAscii(out, dropped)).toBe(false);
  });

  it("rejects standalone markers before the first scan", () => {
    expect(sniffImage(bytes(SOI, [0xff, 0xd0], jpegSof(10, 10), JPEG_SOS, scan, EOI))).toBeNull();
  });

  it("rejects fragmented files quickly instead of allocating per marker", () => {
    const comments = new Array(350_000).fill([0xff, 0xfe, 0x00, 0x02]).flat();
    const input = bytes(SOI, comments, jpegSof(10, 10), JPEG_SOS, scan, EOI);
    expect(input.length).toBeGreaterThan(1_400_000);
    const t = Date.now();
    expect(sniffImage(input)).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("hardened WebP handling", () => {
  it("drops unknown chunks", () => {
    const base = webp();
    const meta = [...[..."META"].map((c) => c.charCodeAt(0)), 12, 0, 0, 0, ...[...SECRET].map((c) => c.charCodeAt(0))];
    const body = [...base.subarray(8), ...meta];
    const size = body.length;
    const input = bytes([0x52, 0x49, 0x46, 0x46, size & 0xff, (size >> 8) & 0xff, 0, 0], [...body]);
    expect(includesAscii(input, SECRET)).toBe(true);
    const out = stripMetadata(input, "image/webp");
    expect(includesAscii(out, SECRET)).toBe(false);
    expect(u32le(out, 4)).toBe(out.length - 8);
    expect(sniffImage(out)).toEqual({ type: "image/webp", width: 1600, height: 1200 });
  });
});

describe("truncation safety", () => {
  const fixtures: [string, Uint8Array][] = [
    ["jpeg", jpeg({ exif: true, comment: true })],
    ["webp VP8X", webp({ exif: true, xmp: true })],
    ["webp VP8", webp({ format: "VP8" })],
    ["webp VP8L", webp({ format: "VP8L" })],
  ];
  for (const [name, full] of fixtures) {
    it(`never throws on any prefix of ${name}`, () => {
      for (let n = 0; n <= full.length; n++) {
        const prefix = full.subarray(0, n);
        const info = sniffImage(prefix);
        if (!info) continue;
        const out = stripMetadata(prefix, info.type);
        expect(sniffImage(out)).toEqual(info);
      }
    });
  }
});
