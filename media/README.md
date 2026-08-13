# media

The explainer videos, and the sources they are rendered from.

Two tellings of the same day 12 measurement, for two audiences:

- `sandwich.html` is the technical one, on a single price axis: a buy order
  goes to a public pool, a searcher reads it, front-runs it, and the fill
  lands 747 bps worse. Then the same order goes through Midpoint, is sealed
  in the browser, opened inside the Confidential Extension, and clears with
  the rest of the batch at a single price.
- `story.html` is the lay one, on a single metaphor: a trade is a letter. On
  a public exchange it travels as a postcard, eyes gather, a front-runner
  reads it and $747 of your $10,000 is gone. On Midpoint it travels in a
  sealed envelope, opened only inside a vault, and everyone pays the same
  price. $747 out of $10,000 is the measured 747 bps restated at a size a
  person can feel; constant product pricing is scale invariant, so the
  restatement is arithmetic, not embellishment.

Every figure on screen comes from `PROGRESS.md` day 12 and was measured on
Coston2 against `NaiveAmm`. The illustrative bids and envelopes deliberately
carry no numbers, so nothing on screen can be mistaken for a measurement that
was not taken.

## Rendering

```
cd media
npm install
node render.mjs          # sandwich.html -> docs/sandwich.mp4
node render.mjs story    # story.html    -> docs/story.mp4
```

Writes `docs/<name>.mp4` (1280x720, 30fps) and `docs/<name>-poster.png`; the
page picks its own poster frame via `window.__poster`. Needs Chrome at
`/usr/bin/google-chrome`, or set `CHROME_PATH`, and ffmpeg with libx264.

Intermediate frames go to `media/out/frames`, which is ignored and is about
290 MB. Delete it once the encode is done.

## Why frames rather than a screen recording

Neither page ever reads the clock. Every visual state is a pure function of
`t`, and `render.mjs` sets `window.__seek(t)` for each frame before it
screenshots. A slow machine therefore produces the same file as a fast one,
and a re-render after an edit differs only where the edit was. A real time
capture would have dropped frames under load and could not be diffed at all.

The consequence for anyone editing these pages: no `requestAnimationFrame`,
no CSS transitions and no CSS animations. All three would reintroduce wall
clock timing and the captured frames would start to smear.
