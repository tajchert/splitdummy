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
const ICC_TAG = "ICC_PROFILE\0";
/** Upper bound on marker segments, so hostile files cannot make the parser allocate without limit. */
const MAX_PARTS = 1024;

interface ParsedJpeg {
  width: number;
  height: number;
  /** Flat [start, end) byte ranges to keep, in order. */
  keep: number[];
}

/** Allowlist: JFIF/JFXX, ICC profile, Adobe and all non-APP, non-COM markers. Other APPn and COM are dropped. */
function keepJpegSegment(b: Uint8Array, marker: number, payload: number, end: number): boolean {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2) return end - payload >= ICC_TAG.length && ascii(b, payload, ICC_TAG.length) === ICC_TAG;
  return !(marker > 0xe0 || marker === 0xfe);
}

/**
 * Walks the whole file: header segments, then each scan's entropy-coded data and any segments between scans,
 * until EOI (anything after it is discarded). Returns null when malformed or implausibly fragmented.
 */
function parseJpeg(b: Uint8Array): ParsedJpeg | null {
  const keep: number[] = [0, 2];
  let width = 0;
  let height = 0;
  let parts = 0;
  let i = 2;
  let scanned = false;
  for (;;) {
    const start = i;
    if (i >= b.length) return width > 0 && height > 0 && scanned ? { width, height, keep } : null;
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++; // marker prefix plus optional fill bytes
    const marker = b[i++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8) return null;
    if (++parts > MAX_PARTS) return null;
    if (marker === 0xd9) {
      if (!scanned) return null;
      keep.push(start, i);
      return width > 0 && height > 0 ? { width, height, keep } : null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (!scanned) return null;
      if (marker === 0x01) keep.push(start, i);
      continue;
    }
    if (i + 2 > b.length) return null;
    const end = i + u16be(b, i);
    if (end < i + 2 || end > b.length) return null;
    const payload = i + 2;
    if (SOF.has(marker) && width === 0 && end - payload >= 5) {
      height = u16be(b, payload + 1);
      width = u16be(b, payload + 3);
    }
    if (keepJpegSegment(b, marker, payload, end)) keep.push(start, end);
    i = end;
    if (marker === 0xda) {
      scanned = true;
      // Entropy-coded data: FF00 and FFD0-D7 belong to it, FF FF.. is fill, any other FFxx is a marker.
      let j = i;
      while (j < b.length) {
        if (b[j] !== 0xff) {
          j++;
          continue;
        }
        let k = j + 1;
        while (b[k] === 0xff) k++;
        const m = b[k];
        if (m === undefined) {
          j = b.length;
          break;
        }
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
          j = k + 1;
          continue;
        }
        break;
      }
      keep.push(i, j);
      i = j;
    }
  }
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  const parsed = parseJpeg(b);
  return parsed ? { type: "image/jpeg", width: parsed.width, height: parsed.height } : null;
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const parsed = parseJpeg(b);
  if (!parsed) throw new Error("stripJpeg: not a JPEG");
  const { keep } = parsed;
  let size = 0;
  for (let n = 0; n < keep.length; n += 2) size += keep[n + 1]! - keep[n]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (let n = 0; n < keep.length; n += 2) {
    out.set(b.subarray(keep[n]!, keep[n + 1]!), at);
    at += keep[n + 1]! - keep[n]!;
  }
  return out;
}

// ---------- WebP ----------

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
/** Allowlist: everything needed to render; EXIF, XMP and unknown chunks are dropped. */
const WEBP_KEEP = new Set(["VP8X", "ICCP", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"]);
const MAX_CHUNKS = 1024;

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
    if (chunks.length >= MAX_CHUNKS) return null;
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
  const kept = chunks.filter((c) => WEBP_KEEP.has(c.fourcc));
  const body = concat([b.subarray(8, 12), ...kept.map((c) => b.subarray(c.start, c.end))]);
  if (kept[0]?.fourcc === "VP8X") body[12] = body[12]! & ~(VP8X_EXIF | VP8X_XMP); // "WEBP"(4) + chunk header(8)
  const size = body.length;
  return concat([b.subarray(0, 4), new Uint8Array([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff]), body]);
}
