// Regenerates the README images in docs/assets from the mock UI.
//   VITE_MOCK=1 npm run dev            # in another terminal
//   node scripts/readme-screenshots.mjs [http://localhost:5173]
import { chromium } from "@playwright/test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:5173";
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

for (const theme of THEMES) {
  await shoot({ width: 1280, height: 800 }, "/g/p_lisbon", theme, join(OUT, `hero-${theme}.png`));

  const phones = [];
  for (const [i, s] of FLOW.entries()) {
    const file = join(TMP, `flow-${theme}-${i}.png`);
    await shoot({ width: 390, height: 780 }, s.path, theme, file);
    phones.push(`data:image/png;base64,${(await readFile(file)).toString("base64")}`);
  }

  // Lay the three phone screens side by side with step captions.
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
    ${FLOW.map((s, i) => `<figure><div class="phone"><img src="${phones[i]}"></div>
      <figcaption><b><span>${s.step}</span>${s.title}</b><p>${s.caption}</p></figcaption></figure>`).join("")}
    </div></body></html>`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(OUT, `flow-${theme}.png`) });
  await ctx.close();
}

await browser.close();
await rm(TMP, { recursive: true, force: true });
console.log(`Wrote README images to ${OUT}`);
