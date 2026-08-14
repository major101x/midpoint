/**
 * Records the live site while a real batch runs through the venue.
 *
 * Launches Chrome with Playwright's screencast recording, opens the deployed
 * page, then runs `client/scripts/demo.mjs` underneath it. The page polls the
 * chain every five seconds, so the recording captures the venue doing its
 * thing with no staging: order count rising, the enclave pinning, the batch
 * closing, and the settled batch advancing.
 *
 * Output is a raw .webm in media/out/demo-video plus the demo's stdout log.
 * The result is long (the batch window alone is a minute), so it is meant to
 * be sped up in post; see PROGRESS.md day 14 for the ffmpeg line used.
 *
 * Usage: node record-demo.mjs [url]
 */

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "out/demo-video");
const URL = process.argv[2] ?? "https://major101x.github.io/midpoint/";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();

await page.goto(URL);
// The enclave chip only renders after the cross-origin fetch to the proxy
// succeeds, so waiting for it proves the tunnel is up before anything runs.
await page.waitForSelector("text=/010198/", { timeout: 30_000 });
console.log("page is live and the enclave chip rendered");

// A moment on the hero, then down to the batch panel, which is where every
// visible state change happens. The first recording sat on the hero for two
// minutes while the batch ran below the fold.
await page.waitForTimeout(6_000);
await page
  .locator("text=Last settled batch")
  .evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
await page.waitForTimeout(3_000);

console.log("running the demo underneath the recording");
const demo = spawn("./node_modules/.bin/vite-node", ["scripts/demo.mjs"], {
  cwd: resolve(HERE, "../client"),
  env: { ...process.env, SWAP_TRADERS: process.env.SWAP_TRADERS ?? "" },
});
let logText = "";
demo.stdout.on("data", (d) => {
  logText += d;
  process.stdout.write(d);
});
demo.stderr.on("data", (d) => {
  logText += d;
  process.stderr.write(d);
});

const code = await new Promise((r) => demo.on("exit", r));
writeFileSync(resolve(OUT, "demo.log"), logText);
if (code !== 0) {
  console.error(`demo exited ${code}; keeping the recording for forensics`);
}

// Two refresh cycles so the settled state is on screen before the cut.
await page.waitForTimeout(12_000);

await context.close(); // finalises the video file
await browser.close();
console.log(`video written under ${OUT}`);
