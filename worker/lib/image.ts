/**
 * Minimal JPEG/WebP container parsing: identify the format, read the pixel size from the header and drop
 * metadata (EXIF, XMP, comments). Never decodes pixels. Pure; safe on untrusted bytes.
 */
import type { AttachmentContentType } from "@shared/api";

export interface ImageInfo {
  type: AttachmentContentType;
  width: number;
  height: number;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, i: number) => (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegInfo(b);
  if (b.length >= 20 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webpInfo(b);
  return null;
}

export function stripMetadata(b: Uint8Array, type: AttachmentContentType): Uint8Array {
  return type === "image/jpeg" ? stripJpeg(b) : stripWebp(b);
}

// ---------- JPEG ----------

/** Start-of-frame markers (baseline, progressive, lossless, arithmetic); they carry the image size. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** APP1 (EXIF, XMP), APP13 (IPTC/Photoshop), COM. */
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

interface Segment {
  marker: number;
  start: number;
  payload: number;
  end: number;
}

/** Header segments up to and including the first SOS; `rest` is where the scan data starts. */
function jpegSegments(b: Uint8Array): { segments: Segment[]; rest: number } | null {
  const segments: Segment[] = [];
  let i = 2;
  for (;;) {
    const start = i;
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++; // marker prefix plus optional fill bytes
    const marker = b[i++];
    if (marker === undefined || marker === 0xd9) return null; // truncated, or EOI before any scan
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start, payload: i, end: i });
      continue;
    }
    if (i + 2 > b.length) return null;
    const end = i + u16be(b, i);
    if (end < i + 2 || end > b.length) return null;
    segments.push({ marker, start, payload: i + 2, end });
    i = end;
    if (marker === 0xda) return { segments, rest: end };
  }
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  const parsed = jpegSegments(b);
  const sof = parsed?.segments.find((s) => SOF.has(s.marker) && s.end - s.payload >= 5);
  if (!sof) return null;
  const height = u16be(b, sof.payload + 1);
  const width = u16be(b, sof.payload + 3);
  return width > 0 && height > 0 ? { type: "image/jpeg", width, height } : null;
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const parsed = jpegSegments(b);
  if (!parsed) throw new Error("stripJpeg: not a JPEG");
  return concat([
    b.subarray(0, 2),
    ...parsed.segments.filter((s) => !JPEG_DROP.has(s.marker)).map((s) => b.subarray(s.start, s.end)),
    b.subarray(parsed.rest),
  ]);
}

// ---------- WebP ----------

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const WEBP_DROP = new Set(["EXIF", "XMP "]);

interface Chunk {
  fourcc: string;
  start: number;
  data: number;
  size: number;
  end: number;
}

function webpChunks(b: Uint8Array): Chunk[] | null {
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd < 20 || riffEnd > b.length) return null;
  const chunks: Chunk[] = [];
  let i = 12;
  while (i + 8 <= riffEnd) {
    const size = u32le(b, i + 4);
    const data = i + 8;
    if (data + size > riffEnd) return null;
    const end = Math.min(data + size + (size & 1), riffEnd);
    chunks.push({ fourcc: ascii(b, i, 4), start: i, data, size, end });
    i = end;
  }
  return chunks.length > 0 ? chunks : null;
}

const webpDims = (width: number, height: number): ImageInfo | null =>
  width > 0 && height > 0 ? { type: "image/webp", width, height } : null;

function webpInfo(b: Uint8Array): ImageInfo | null {
  const first = webpChunks(b)?.[0];
  if (!first) return null;
  const d = first.data;
  if (first.fourcc === "VP8X" && first.size >= 10) return webpDims(1 + u24le(b, d + 4), 1 + u24le(b, d + 7));
  if (first.fourcc === "VP8 " && first.size >= 10 && b[d + 3] === 0x9d && b[d + 4] === 0x01 && b[d + 5] === 0x2a) {
    return webpDims(u16le(b, d + 6) & 0x3fff, u16le(b, d + 8) & 0x3fff);
  }
  if (first.fourcc === "VP8L" && first.size >= 5 && b[d] === 0x2f) {
    const bits = u32le(b, d + 1);
    return webpDims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

function stripWebp(b: Uint8Array): Uint8Array {
  const chunks = webpChunks(b);
  if (!chunks) throw new Error("stripWebp: not a WebP");
  const kept = chunks.filter((c) => !WEBP_DROP.has(c.fourcc));
  const body = concat([b.subarray(8, 12), ...kept.map((c) => b.subarray(c.start, c.end))]);
  if (kept[0]?.fourcc === "VP8X") body[12] = body[12]! & ~(VP8X_EXIF | VP8X_XMP); // "WEBP"(4) + chunk header(8)
  const size = body.length;
  return concat([b.subarray(0, 4), new Uint8Array([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff]), body]);
}
