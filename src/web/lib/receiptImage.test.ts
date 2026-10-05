import { describe, expect, it, vi } from "vitest";
import { type CanvasLike, compressReceipt, encodeOnCanvas, fitWithin, ImageReadError, type ImageCodec } from "./receiptImage";

type Call = { width: number; height: number; type: string; quality: number };

function codec(opts: { width: number; height: number; webp?: boolean; size?: (c: Call) => number; failDecode?: boolean }) {
  const calls: Call[] = [];
  const close = vi.fn();
  const c: ImageCodec = {
    decode: async () => {
      if (opts.failDecode) throw new Error("HEIC");
      return { width: opts.width, height: opts.height, source: {} as CanvasImageSource, close };
    },
    encode: async (_s, width, height, type, quality) => {
      const call = { width, height, type, quality };
      calls.push(call);
      const actual = type === "image/webp" && opts.webp === false ? "image/png" : type;
      return new Blob([new Uint8Array(opts.size?.(call) ?? 300_000)], { type: actual });
    },
  };
  return { c, calls, close };
}

const file = new Blob(["x"], { type: "image/jpeg" });

describe("compressReceipt", () => {
  it("scales the long edge to 2000 px and encodes WebP at 0.8", async () => {
    const { c, calls, close } = codec({ width: 4000, height: 3000 });
    const out = await compressReceipt(file, c);
    expect(calls).toEqual([{ width: 2000, height: 1500, type: "image/webp", quality: 0.8 }]);
    expect(out).toMatchObject({ width: 2000, height: 1500 });
    expect(out.blob.type).toBe("image/webp");
    expect(close).toHaveBeenCalled();
  });

  it("scales a 48 MP photo down before encoding", async () => {
    const { c, calls } = codec({ width: 6000, height: 8000 });
    await compressReceipt(file, c);
    expect(calls[0]).toMatchObject({ width: 1500, height: 2000 });
  });

  it("never upscales small images", async () => {
    const { c, calls } = codec({ width: 800, height: 600 });
    await compressReceipt(file, c);
    expect(calls[0]).toMatchObject({ width: 800, height: 600 });
  });

  it("falls back to JPEG where WebP encoding isn't supported, and stays on JPEG", async () => {
    const { c, calls } = codec({ width: 3000, height: 2000, webp: false, size: (x) => (x.quality > 0.75 ? 1_000_000 : 500_000) });
    const out = await compressReceipt(file, c);
    expect(calls.map((x) => [x.type, x.quality])).toEqual([
      ["image/webp", 0.8],
      ["image/jpeg", 0.82],
      ["image/jpeg", 0.72],
    ]);
    expect(out.blob.type).toBe("image/jpeg");
  });

  it("steps quality down, then size, to fit 900 KB; returns the smallest if nothing fits", async () => {
    const { c, calls } = codec({ width: 4000, height: 3000, size: (x) => (x.width === 1600 ? 950_000 : 1_200_000) });
    const out = await compressReceipt(file, c);
    expect(calls.map((x) => [x.width, x.quality])).toEqual([
      [2000, 0.8],
      [2000, 0.7],
      [2000, 0.6],
      [1600, 0.7],
    ]);
    expect(out.width).toBe(1600);
    expect(out.blob.size).toBe(950_000);
  });

  it("reports undecodable files with a friendly error", async () => {
    const { c } = codec({ width: 1, height: 1, failDecode: true });
    await expect(compressReceipt(file, c)).rejects.toBeInstanceOf(ImageReadError);
    await expect(compressReceipt(file, c)).rejects.toThrow("Couldn't read this image — try a JPEG or PNG.");
  });
});

describe("fitWithin", () => {
  it("keeps at least one pixel per side", () => {
    expect(fitWithin(10000, 1, 2000)).toEqual({ width: 2000, height: 1 });
  });
});

describe("encodeOnCanvas", () => {
  it("paints white before drawing so transparent images don't turn black as JPEG", async () => {
    const ops: string[] = [];
    const ctx = {
      set fillStyle(v: string) { ops.push(`fill:${v}`); },
      fillRect: () => ops.push("fillRect"),
      drawImage: () => ops.push("draw"),
      imageSmoothingQuality: "low",
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: (cb: (b: Blob | null) => void, type: string) => cb(new Blob(["x"], { type })),
    };
    const blob = await encodeOnCanvas(canvas as unknown as CanvasLike, {} as CanvasImageSource, 100, 50, "image/jpeg", 0.82);
    expect(ops).toEqual(["fill:#ffffff", "fillRect", "draw"]);
    expect(blob.type).toBe("image/jpeg");
  });
});
