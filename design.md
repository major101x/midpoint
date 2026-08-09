# Midpoint: Design

How the interface looks and why. Companion to `spec.md`, which covers the
mechanism, and `PROGRESS.md`, which records what was built and when.

Values live in `web/src/styles/tokens.css`. This document explains them. If the
two disagree, the tokens are the truth and this file needs updating.

---

## 1. Principles

**The contrast is the product.** The whole venue exists to separate what the
chain can see from what only the enclave can see. The interface says that with
one blue panel beside one green panel, and everything else stays out of the way.
Any decoration that competes with that pairing is wrong, however good it looks.

**Numbers must be checkable.** Every figure on the page is read live from
Coston2 or computed from live reserves. The reference this design borrows from
puts `50K+ Downloads` in its hero. We put `746 bps`, and anyone can verify it.
Do not add a metric that cannot be traced to chain state or to the repository.

**Restraint, then one moment of confidence.** The page is quiet: near-black,
thin rules, muted grey. The single exception is the hero, which is allowed to be
large and to glow, because a visitor who does not understand MEV in the first
ten seconds will never reach the controls.

**Say the awkward thing.** The footer states that attestation is simulated. The
hero's fine print says the pool is shallow and the figure is scale invariant.
Disclosure is part of the design, not an afterthought bolted on at the bottom.

---

## 2. Colour

### 2.1 The semantic pair, which is load-bearing

```
--public   #6aa9ff    what the chain can see
--private  #6ee7a8    what only the enclave can see
```

These two carry the argument. Rules:

- Never use either for decoration, hover states, or emphasis.
- Never introduce a third colour into that comparison. Two things are being
  contrasted, so there are two colours.
- Anything genuinely public renders in blue. Anything genuinely private renders
  in green. No exceptions for aesthetic convenience.

### 2.2 The aurora ramp, which is ambient only

```
--aurora-1 #14306e    --aurora-3 #2f6df0
--aurora-2 #1d4ed8    --aurora-4 #0e7fb8
```

Deeper and more saturated than `--public`, deliberately. The hero glow is blue
and the public-data colour is blue, so they are kept far enough apart in value
that a diffuse background wash is never read as a data label. Context does most
of the work here (one is a blurred field, the other is text and borders), but
the value gap is the belt to that braces.

The aurora appears behind the hero and nowhere else.

### 2.3 Accent

One hex cannot do three jobs and stay accessible, so there are three:

| Token | Use | Contrast |
|---|---|---|
| `--accent` `#e0466b` | identity, borders, large numerals | 4.66:1 on `--surface` |
| `--accent-strong` `#c9345a` | button fills carrying white text | 5.09:1 with white |
| `--accent-text` `#ff8fa6` | accent-coloured body copy | 9.22:1 on `--bg` |

White on `--accent` measures 3.99:1, which fails AA for button text at this
size. That is the entire reason `--accent-strong` exists. Do not "simplify" it
away.

### 2.4 Surfaces and text

Near-black rather than pure black: `#000` makes the edges of translucent cards
band visibly on OLED, and is harsher under sustained reading.

| Token | Value | Contrast on `--bg` |
|---|---|---|
| `--text` | `#e8ecf3` | 16.8:1 |
| `--text-muted` | `#98a1b2` | 7.7:1 |
| `--text-faint` | `#7b8598` | 5.4:1 |

`--text-faint` began at `#6c7688` and measured 4.06:1, which fails AA for
normal text. It was lightened rather than kept and excused, because it is used
at 12px, and 12px is not large text under WCAG no matter how incidental the
content feels.

---

## 3. Type

**Outfit** for display, **Inter** for everything else, both self-hosted through
`@fontsource`. The page makes no external font request and renders identically
offline.

Latin subset only, weights 400/500/600 for Outfit and 400/500 for Inter. The
unsubsetted entry points ship twenty files covering Cyrillic, Greek and
Vietnamese; a browser would never fetch them here, but they would still sit in
the build. Trimming took the font payload from 280K to 96K.

### 3.1 The hero headline

The reference's defining move is a **large headline at regular weight**, not a
bold one. Bold at that size reads as shouting; regular reads as stating a fact,
which suits a sentence that is itself a plain claim.

```
font-family: Outfit
font-size:   clamp(2rem, 1.2rem + 3.4vw, 3.5rem)
font-weight: 400
line-height: 1.12
letter-spacing: -0.022em
```

Negative tracking is not optional at display sizes. Type designed for body text
looks loose when scaled up, and the default spacing that reads correctly at 15px
reads as gappy at 56px.

### 3.2 Everything else

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 12px | annotation, uppercase labels |
| `--text-sm` | 13px | secondary copy, table rows |
| `--text-base` | 15px | body, lifted to 16px under 820px |
| `--text-xl` | 22px | figures in the MEV panel |
| `--text-2xl` | 28px | the wordmark |
| `--text-stat` | fluid to 40px | hero stat values |

Body text is 15px on desktop and **16px on phones**, where 15px sits under the
usual readability floor. The bump is applied to the base token, so every rule
derived from it moves at once.

Line height 1.55 for body, 1.12 for display. Measure capped at 58ch, because
copy past roughly 70 characters per line loses the reader.

All figures use `font-variant-numeric: tabular-nums`. Prices, balances and basis
points sit in columns, and columns only line up when digits share a width.

---

## 4. Space, radius, elevation

4px base step, named by multiple (`--space-4` is 16px) rather than by t-shirt
size, so the arithmetic stays legible.

Radius climbs with surface size: 8px controls, 12px panels, 22px the hero glass
card, `999px` pills. A large card with a small radius looks accidental.

Three shadows only: `--shadow-card` for resting panels, `--shadow-raised` for
things that lift, `--shadow-glass` for the hero card, which needs a deeper
shadow to separate from a moving background.

---

## 5. The hero

### 5.1 Order

Problem, then price, then contrast, then controls.

A visitor arriving cold previously met a disabled deposit form. Nothing told
them what the venue was for, and the strongest evidence the project has existed
only in a terminal script. The hero states the problem, quantifies it, and only
then offers anything to click.

Two columns at 1.35:1, collapsing to one under 820px. Copy left, the live MEV
figure right in a glass card, mirroring the reference's layout.

### 5.2 The stat row

Three numbers where the reference puts vanity metrics:

| Slot | Source |
|---|---|
| `746 bps` | computed from the comparison pool's live reserves |
| batches settled | `Settlement.lastSettledBatch()`, read on load |
| `194` | test count across contracts, extension and client |

The first two update themselves. The third is the one number a human must keep
honest, so it is called out here.

### 5.3 The aurora

Three blurred radial blobs drifting on long, mutually prime periods (24s, 32.9s,
43s), so the composite never visibly repeats.

**Implemented in CSS, not with React Bits.** React Bits' Aurora was the obvious
candidate and was rejected on cost: it pulls in OGL and runs a WebGL context
with a fragment shader every frame for as long as the page is open. This is a
trading interface that people leave sitting in a tab. The effect wanted is a
slow ambient wash, which three `filter: blur()` layers reproduce closely enough
that the difference is not visible at rest.

Animating only `transform` keeps the work on the compositor, off the main
thread, and off the CPU entirely when the tab is hidden.

Three constraints the implementation has to satisfy, each learned by getting it
wrong first:

1. **The hero clips the aurora** (`overflow: hidden`). This keeps the glow off
   the panels below, which is the part of the reference deliberately not copied,
   and stops the oversized blob box widening the page into a horizontal
   scrollbar.
2. **The mask fades on every side.** With a hard clip and no mask, the glow
   meets the hero boundary while still bright and draws a visible rectangle.
3. **Both hero columns are positioned** (`position: relative; z-index`). A
   static element does not participate in z-ordering against a positioned
   sibling, so without this the aurora paints over the copy and washes it out.
   This was the actual cause of what first looked like a contrast problem.

The glow blooms into a band of empty space below the content, which is why the
hero carries 5rem of bottom padding. Without that room the aurora has to sit
under the text, where it either gets dimmed into invisibility or eats the copy.

Under `prefers-reduced-motion: reduce` the drift stops completely. The gradient
stays: the look must not depend on the movement.

---

## 6. Accessibility

Non-negotiable, and all verified rather than assumed:

- **Contrast.** Every text token clears 4.5:1 on the surfaces it is used on. The
  table in section 2 records measured ratios. Re-measure after any colour change
  rather than eyeballing it.
- **Reduced motion.** The aurora stops. Transition durations collapse to 0ms.
- **Focus.** A visible ring on every interactive element, two-tone so it reads
  on both dark panels and the accent fill.
- **Touch targets.** Minimum 44x44px.
- **Decorative elements are hidden.** The aurora carries `aria-hidden="true"`.
- **No horizontal scroll** at any width. Verified at 375px and 1280px.
- **Colour is never the only signal.** The public and private panels differ by
  heading and content, not only by border colour.

---

## 7. Performance budget

| Item | Now | Ceiling |
|---|---|---|
| JS, gzipped | 152 kB | 200 kB |
| CSS, gzipped | ~4 kB | 10 kB |
| Fonts, latin subset | 96 kB | 120 kB |
| Continuously running canvases | 0 | 0 |

That last row is a rule, not a measurement. If an effect needs a canvas running
forever, it needs a better reason than this one had.

---

## 8. Anti-patterns

Things that would be wrong here specifically:

- **Repurposing `--public` or `--private`.** Covered above, and the most likely
  mistake for anyone new to the codebase.
- **A third colour in the public/private comparison.**
- **Bold hero type.** The reference's restraint is the point.
- **Emoji as icons.** SVG only.
- **Hover states that use `scale`.** They shift layout. Use colour and border.
- **Fabricated metrics.** Covered in section 1, and worth repeating: the numbers
  are the credibility.
- **Light backgrounds.** The whole palette assumes dark. There is no light mode
  and adding one is not a small change.
