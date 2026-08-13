# media

The explainer video, and the source it is rendered from.

`sandwich.html` tells the story of the day 12 measurement on one price axis:
a buy order goes to a public pool, a searcher reads it, front-runs it, and the
fill lands 747 bps worse. Then the same order goes through Midpoint, is sealed
in the browser, opened inside the Confidential Extension, and clears with the
rest of the batch at a single price.

Every figure on screen comes from `PROGRESS.md` day 12 and was measured on
Coston2 against `NaiveAmm`. The three bids in the second half deliberately
carry no numbers, so nothing on screen can be mistaken for a measurement that
was not taken.

## Rendering

```
cd media
npm install
node render.mjs
```

Writes `docs/sandwich.mp4` (1280x720, 30fps, about 36 seconds) and
`docs/sandwich-poster.png`. Needs Chrome at `/usr/bin/google-chrome`, or set
`CHROME_PATH`, and ffmpeg with libx264.

Intermediate frames go to `media/out/frames`, which is ignored and is about
290 MB. Delete it once the encode is done.

## Why frames rather than a screen recording

`sandwich.html` never reads the clock. Every visual state is a pure function
of `t`, and `render.mjs` sets `window.__seek(t)` for each frame before it
screenshots. A slow machine therefore produces the same file as a fast one,
and a re-render after an edit differs only where the edit was. A real time
capture would have dropped frames under load and could not be diffed at all.

The consequence for anyone editing `sandwich.html`: no `requestAnimationFrame`,
no CSS transitions and no CSS animations. All three would reintroduce wall
clock timing and the captured frames would start to smear.
