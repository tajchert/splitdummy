/** Header-accurate synthetic JPEG/WebP files. Never decoded, so pixel data is filler. */
export const SECRET = "GPS-52.2297N";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const segment = (marker: number, payload: number[]) => [0xff, marker, ...u16be(payload.length + 2), ...payload];

export function jpeg(opts: { width?: number; height?: number; exif?: boolean; comment?: boolean; fill?: boolean } = {}): Uint8Array {
  const { width = 1600, height = 1200 } = opts;
  return new Uint8Array([
    0xff, 0xd8,
    ...segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(opts.exif ? segment(0xe1, [...ascii("Exif"), 0, 0, ...ascii(SECRET)]) : []),
    ...(opts.comment ? segment(0xfe, ascii(`comment ${SECRET}`)) : []),
    ...(opts.fill ? [0xff] : []), // a fill byte before the next marker is legal
    ...segment(0xc0, [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56, // entropy-coded data with a stuffed 0xFF
    0xff, 0xd9,
  ]);
}

const chunk = (fourcc: string, data: number[]) => [...ascii(fourcc), ...u32le(data.length), ...data, ...(data.length % 2 ? [0] : [])];

export function webp(opts: { width?: number; height?: number; exif?: boolean; xmp?: boolean; format?: "VP8X" | "VP8" | "VP8L" } = {}): Uint8Array {
  const { width = 1600, height = 1200, format = "VP8X" } = opts;
  const vp8 = chunk("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height), 0, 0]);
  const bits = (width - 1) | ((height - 1) << 14);
  const vp8l = chunk("VP8L", [0x2f, ...u32le(bits), 0]);
  let body: number[];
  if (format === "VP8") body = vp8;
  else if (format === "VP8L") body = vp8l;
  else {
    const flags = (opts.exif ? 0x08 : 0) | (opts.xmp ? 0x04 : 0);
    body = [
      ...chunk("VP8X", [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]),
      ...vp8,
      ...(opts.exif ? chunk("EXIF", ascii(`II*\0${SECRET}`)) : []),
      ...(opts.xmp ? chunk("XMP ", ascii(`<x:xmpmeta>${SECRET}</x:xmpmeta>`)) : []),
    ];
  }
  const riff = [...ascii("WEBP"), ...body];
  return new Uint8Array([...ascii("RIFF"), ...u32le(riff.length), ...riff]);
}

export function includesAscii(bytes: Uint8Array, text: string): boolean {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s.includes(text);
}
