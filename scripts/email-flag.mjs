// Renders the waving checkered flag used in the "all settled" email to public/email/finish-flag.gif.
// Email clients (Gmail, Outlook) drop CSS/SVG animation, so the animation ships as a GIF.
// Usage: node scripts/email-flag.mjs   (needs ffmpeg on PATH; sharp comes from devDependencies)
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const SIZE = 192; // rendered at 2x, shown at 96px
const FRAMES = 24;
const COLS = 6;
const ROWS = 4;
const INK = "#2a2420";
const CLOTH = "#fffcf7";
const CARD = "#fffcf7";
const BADGE = "#d9ebdf";
const ACCENT = "#c24e28";

const pole = { x: 58, top: 34, bottom: 162 };
const flag = { x: 62, y: 42, w: 96, h: 64 };

function point(u, v, phase) {
  // u, v in [0, 1] across the cloth; the pole edge (u = 0) stays fixed.
  const k = u;
  const wave = Math.sin(u * Math.PI * 2.2 - phase);
  return {
    x: flag.x + u * flag.w - k * 4 * (1 - Math.cos(u * Math.PI * 2.2 - phase)) * 0.5,
    y: flag.y + v * flag.h + k * 7 * wave + k * v * 2,
    shade: Math.cos(u * Math.PI * 2.2 - phase) * k,
  };
}

function frame(i) {
  const phase = (i / FRAMES) * Math.PI * 2;
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const [u0, u1, v0, v1] = [c / COLS, (c + 1) / COLS, r / ROWS, (r + 1) / ROWS];
      const q = [point(u0, v0, phase), point(u1, v0, phase), point(u1, v1, phase), point(u0, v1, phase)];
      const pts = q.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
      const fill = (r + c) % 2 === 0 ? INK : CLOTH;
      const s = (q[0].shade + q[1].shade) / 2;
      const overlay = s > 0 ? `rgba(255,255,255,${(s * 0.14).toFixed(3)})` : `rgba(42,36,32,${(-s * 0.22).toFixed(3)})`;
      cells.push(`<polygon points="${pts}" fill="${fill}" stroke="${fill}" stroke-width="0.6"/>`);
      cells.push(`<polygon points="${pts}" fill="${overlay}"/>`);
    }
  }
  // Outline the cloth so the light squares read against the badge.
  const edge = [];
  for (let s = 0; s <= 24; s++) edge.push(point(s / 24, 0, phase));
  for (let s = 0; s <= 16; s++) edge.push(point(1, s / 16, phase));
  for (let s = 24; s >= 0; s--) edge.push(point(s / 24, 1, phase));
  const outline = edge.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${CARD}"/>
  <circle cx="96" cy="96" r="88" fill="${BADGE}"/>
  <ellipse cx="${pole.x + 2}" cy="${pole.bottom + 2}" rx="18" ry="4" fill="rgba(45,110,78,0.18)"/>
  <rect x="${pole.x - 3}" y="${pole.top}" width="6" height="${pole.bottom - pole.top}" rx="3" fill="${INK}"/>
  <circle cx="${pole.x}" cy="${pole.top - 2}" r="6" fill="${ACCENT}"/>
  ${cells.join("\n  ")}
  <polygon points="${outline}" fill="none" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
</svg>`;
}

const work = mkdtempSync(join(tmpdir(), "email-flag-"));
try {
  for (let i = 0; i < FRAMES; i++) {
    const png = await sharp(Buffer.from(frame(i))).png().toBuffer();
    writeFileSync(join(work, `f${String(i).padStart(2, "0")}.png`), png);
  }
  const outDir = join(import.meta.dirname, "..", "public", "email");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "finish-flag.gif");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", "20", "-i", join(work, "f%02d.png"),
    "-filter_complex", "[0:v]split[a][b];[a]palettegen=max_colors=64:reserve_transparent=0[p];[b][p]paletteuse=dither=none",
    "-loop", "0", out,
  ]);
  console.log(`wrote ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
