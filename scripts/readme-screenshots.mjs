// Regenerates the README images in docs/assets from the mock UI.
//   VITE_MOCK=1 npm run dev            # in another terminal
//   node scripts/readme-screenshots.mjs [http://localhost:5173] [--only=hero|flow|receipts]
import { chromium } from "@playwright/test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:5173";
const ONLY = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const want = (name) => !ONLY || ONLY === name;
const OUT = new URL("../docs/assets/", import.meta.url).pathname;
const TMP = join(OUT, ".tmp");
const THEMES = ["light", "dark"];
const PALETTE = {
  light: { bg: "#f6f1e9", ink: "#2a2520", muted: "#8a7f73", accent: "#c4502a" },
  dark: { bg: "#1b1916", ink: "#f1ebe2", muted: "#a0968a", accent: "#e0714a" },
};
const FLOW = [
  { path: "/g/p_lisbon", step: "1", title: "Collect", caption: "Everyone adds expenses, then marks themselves done." },
  { path: "/g/p_kuwait", step: "2", title: "Freeze & settle", caption: "The owner freezes. Repayments are fixed and tracked." },
  { path: "/g/p_tokyo", step: "3", title: "All settled", caption: "Every transfer confirmed. The group is finished." },
];

const RECEIPTS = [
  { step: "1", title: "Snap the bill", caption: "Add a note and up to 5 photos. They shrink in your browser first." },
  { step: "2", title: "Everyone sees it", caption: "The note and receipts travel with the expense." },
  { step: "3", title: "Check the details", caption: "Full screen, swipe between photos. Location data is stripped." },
];

/** A photographed-looking restaurant receipt, rendered to JPEG bytes. */
async function receiptPhoto() {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const items = [["Bacalhau à Brás x2", "29.80"], ["Polvo grelhado", "18.50"], ["Vinho Verde 0.75l", "16.00"], ["Pastéis de nata x6", "7.20"], ["Água com gás x3", "6.30"], ["Café x4", "4.80"]];
  await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;
      background:radial-gradient(circle at 30% 20%,#9b8a76,#5d5045 70%);font-family:'Courier New',monospace">
    <div style="width:520px;padding:44px 40px 56px;background:#fbf8f1;color:#2b2722;transform:rotate(-3deg);
        box-shadow:0 30px 60px rgba(0,0,0,.45);font-size:21px;line-height:1.5;
        clip-path:polygon(0 0,100% 0,100% 97%,95% 100%,90% 97%,85% 100%,80% 97%,75% 100%,70% 97%,65% 100%,60% 97%,55% 100%,50% 97%,45% 100%,40% 97%,35% 100%,30% 97%,25% 100%,20% 97%,15% 100%,10% 97%,5% 100%,0 97%)">
      <div style="text-align:center;font-weight:700;font-size:28px">TASCA DO CHICO</div>
      <div style="text-align:center">Rua do Diário de Notícias 39<br>1200-141 Lisboa</div>
      <div style="text-align:center;margin:10px 0 18px">NIF 503 214 778 · 03/10/2026 21:47</div>
      ${items.map(([n, p]) => `<div style="display:flex;justify-content:space-between"><span>${n}</span><span>${p}</span></div>`).join("")}
      <div style="border-top:2px dashed #2b2722;margin:16px 0 8px"></div>
      <div style="display:flex;justify-content:space-between;font-weight:700;font-size:26px"><span>TOTAL EUR</span><span>82.60</span></div>
      <div style="display:flex;justify-content:space-between"><span>IVA 13% incl.</span><span>9.50</span></div>
      <div style="text-align:center;margin-top:22px">Obrigado e volte sempre!</div>
    </div></body></html>`);
  const buffer = await page.screenshot({ type: "jpeg", quality: 90 });
  await ctx.close();
  return buffer;
}

/** Form with a note and photo, the saved expense, and the photo viewer, all in one mock session (photos live in memory). */
async function shootReceipts(theme) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  const files = [0, 1, 2].map((i) => join(TMP, `receipts-${theme}-${i}.png`));
  await page.goto(`${BASE}/g/p_lisbon/new?nodev&theme=${theme}&latency=0`);
  await page.getByLabel("What was it?").first().fill("Dinner at Tasca do Chico");
  await page.getByRole("textbox", { name: "Amount" }).fill("82.60");
  await page.getByRole("textbox", { name: "Note" }).fill("Fado night! Tip left in cash.\nTom skipped the wine.");
  await page.locator('input[type="file"]').setInputFiles({ name: "receipt.jpg", mimeType: "image/jpeg", buffer: await receiptPhoto() });
  await page.getByRole("button", { name: "Remove photo 1" }).waitFor();
  await page.waitForFunction(() => !/Preparing…|Uploading…/.test(document.body.innerText));
  await page.locator(".ef-extras").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: files[0] });
  await page.locator("#entry-form").evaluate((f) => f.requestSubmit());
  await page.waitForURL((u) => !u.pathname.endsWith("/new"));
  await page.getByText("Dinner at Tasca do Chico").first().click();
  await page.getByRole("button", { name: "Open photo 1 of 1" }).waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: files[1] });
  await page.getByRole("button", { name: "Open photo 1 of 1" }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: files[2] });
  await ctx.close();
  return files;
}

await mkdir(TMP, { recursive: true });
const browser = await chromium.launch();

async function shoot(viewport, path, theme, file) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}${path.includes("?") ? "&" : "?"}nodev&theme=${theme}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
  await page.screenshot({ path: file });
  await ctx.close();
}

/** Lays phone screens side by side with numbered step captions. */
async function composite(theme, steps, phones, file) {
  const c = PALETTE[theme];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 810 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><head>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700&display=swap" rel="stylesheet">
    <style>
      body { margin: 0; background: ${c.bg}; font-family: "DM Sans", system-ui, sans-serif; color: ${c.ink}; }
      .row { display: flex; justify-content: center; gap: 56px; padding: 44px 40px 0; }
      figure { margin: 0; width: 330px; display: flex; flex-direction: column; gap: 18px; }
      .phone { border-radius: 34px; overflow: hidden; border: 8px solid ${theme === "dark" ? "#34302b" : "#2a2520"};
               box-shadow: 0 24px 48px -20px rgba(0,0,0,.35); }
      .phone img { width: 100%; display: block; }
      figcaption b { display: block; font-size: 20px; }
      figcaption b span { color: ${c.accent}; margin-right: 8px; }
      figcaption p { margin: 4px 0 0; color: ${c.muted}; font-size: 15px; line-height: 1.4; }
    </style></head><body><div class="row">
    ${steps.map((s, i) => `<figure><div class="phone"><img src="${phones[i]}"></div>
      <figcaption><b><span>${s.step}</span>${s.title}</b><p>${s.caption}</p></figcaption></figure>`).join("")}
    </div></body></html>`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file });
  await ctx.close();
}

const dataUrl = async (file) => `data:image/png;base64,${(await readFile(file)).toString("base64")}`;

for (const theme of THEMES) {
  if (want("hero")) await shoot({ width: 1280, height: 800 }, "/g/p_lisbon", theme, join(OUT, `hero-${theme}.png`));

  if (want("flow")) {
    const phones = [];
    for (const [i, s] of FLOW.entries()) {
      const file = join(TMP, `flow-${theme}-${i}.png`);
      await shoot({ width: 390, height: 780 }, s.path, theme, file);
      phones.push(await dataUrl(file));
    }
    await composite(theme, FLOW, phones, join(OUT, `flow-${theme}.png`));
  }

  if (want("receipts")) {
    const files = await shootReceipts(theme);
    await composite(theme, RECEIPTS, await Promise.all(files.map(dataUrl)), join(OUT, `receipts-${theme}.png`));
  }
}

await browser.close();
await rm(TMP, { recursive: true, force: true });
console.log(`Wrote README images to ${OUT}`);
