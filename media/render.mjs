/**
 * Renders `sandwich.html` to a video, one frame at a time.
 *
 * The page never reads the clock: `window.__seek(t)` puts it into an exact
 * state and this script screenshots it, so a slow machine produces the same
 * file as a fast one and a re-run is byte-comparable. That is worth more than
 * the speed a real-time screen recording would give, because the frames have
 * to survive being re-encoded by X.
 *
 * Chrome comes from the system rather than from a Playwright download, so
 * only `playwright-core` is needed:
 *
 *   npm i playwright-core
 *   node media/render.mjs
 *
 * Requires ffmpeg with libx264 on PATH.
 */

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "sandwich.html");
// Frames are scratch and land under an ignored directory. The two finished
// files go to docs/ with the rest of the material meant to be looked at.
const FRAMES = resolve(HERE, "out/frames");
const OUT = resolve(HERE, "../docs/sandwich.mp4");
const POSTER = resolve(HERE, "../docs/sandwich-poster.png");

const FPS = 30;
const W = 1280;
const H = 720;

/** A frame X will use as the thumbnail if it picks one, and a good still. */
const POSTER_T = 17.2;

const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

function run(cmd, args) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) =>
      code === 0 ? ok() : bad(new Error(`${cmd} exited ${code}`)),
    );
  });
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--force-color-profile=srgb", "--font-render-hinting=none"],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});

await page.goto(`file://${PAGE}`);
// Web fonts load asynchronously; a frame captured before they land renders in
// the fallback face and the whole run has to be thrown away.
await page.evaluate(() => document.fonts.ready);

const duration = await page.evaluate(() => window.__duration);
const total = Math.round(duration * FPS);

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

process.stdout.write(`rendering ${total} frames at ${FPS}fps\n`);

for (let i = 0; i < total; i++) {
  const t = i / FPS;
  await page.evaluate((tt) => window.__seek(tt), t);
  const buf = await page.screenshot({ type: "png" });
  writeFileSync(`${FRAMES}/${String(i).padStart(5, "0")}.png`, buf);
  if (i % 60 === 0) process.stdout.write(`  ${i}/${total}\n`);
}

await page.evaluate((tt) => window.__seek(tt), POSTER_T);
writeFileSync(POSTER, await page.screenshot({ type: "png" }));

await browser.close();

// yuv420p and even dimensions, because anything else fails to play on some
// of the surfaces X re-encodes for. faststart puts the index first so it
// begins playing before the whole file has arrived.
await run("ffmpeg", [
  "-y",
  "-framerate",
  String(FPS),
  "-i",
  `${FRAMES}/%05d.png`,
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  OUT,
]);

process.stdout.write(`\nwrote ${OUT}\n`);
