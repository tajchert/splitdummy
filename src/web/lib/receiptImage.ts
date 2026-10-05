/**
 * Receipt photo compression before upload: upright, long edge ≤ 2000 px, WebP (JPEG where the browser can't
 * encode WebP), stepped down to fit the size budget. Re-encoding also drops EXIF/GPS metadata.
 */
export const MAX_EDGE = 2000;
const SMALL_EDGE = 1600;
export const SIZE_BUDGET = 900_000;

/** Quality steps; JPEG needs slightly more quality than WebP for legible small print. */
const STEPS = [
  { edge: MAX_EDGE, webp: 0.8, jpeg: 0.82 },
  { edge: MAX_EDGE, webp: 0.7, jpeg: 0.72 },
  { edge: MAX_EDGE, webp: 0.6, jpeg: 0.62 },
  { edge: SMALL_EDGE, webp: 0.7, jpeg: 0.72 },
];

type OutputType = "image/webp" | "image/jpeg";

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close(): void;
}

export interface ImageCodec {
  decode(file: Blob): Promise<DecodedImage>;
  encode(source: CanvasImageSource, width: number, height: number, type: OutputType, quality: number): Promise<Blob>;
}

export interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
}

export class ImageReadError extends Error {
  constructor() {
    super("Couldn't read this image — try a JPEG or PNG.");
  }
}

export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function compressReceipt(file: Blob, codec: ImageCodec = browserCodec): Promise<CompressedImage> {
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new ImageReadError();
  }
  try {
    let type: OutputType = "image/webp";
    let best: CompressedImage | null = null;
    for (const step of STEPS) {
      const size = fitWithin(image.width, image.height, step.edge);
      let blob = await codec.encode(image.source, size.width, size.height, type, type === "image/webp" ? step.webp : step.jpeg);
      if (type === "image/webp" && blob.type !== "image/webp") {
        type = "image/jpeg"; // e.g. Safari silently returns PNG for WebP
        blob = await codec.encode(image.source, size.width, size.height, type, step.jpeg);
      }
      const result = { blob, ...size };
      if (!best || blob.size < best.blob.size) best = result;
      if (blob.size <= SIZE_BUDGET) return result;
    }
    return best!;
  } finally {
    image.close();
  }
}

/** The bits of HTMLCanvasElement we use; a fake in tests. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: "2d"): Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "drawImage" | "imageSmoothingQuality"> | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

export async function encodeOnCanvas(canvas: CanvasLike, source: CanvasImageSource, width: number, height: number, type: OutputType, quality: number): Promise<Blob> {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  // JPEG has no alpha: transparent screenshots would otherwise turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // Release the backing store early; iOS caps total canvas memory.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("Couldn't encode the image");
  return blob;
}

export const browserCodec: ImageCodec = {
  async decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
      } catch {
        // Some browsers decode more formats through <img>; try that next.
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => URL.revokeObjectURL(url) };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  },
  encode: (source, width, height, type, quality) => encodeOnCanvas(document.createElement("canvas"), source, width, height, type, quality),
};
