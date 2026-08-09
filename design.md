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

They appear as legend swatches beside the two headings, and in the private
panel's list items. They used to be coloured card borders; the cards are gone
(4.2) but the rule survives the layout that carried it.

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

One token: `--accent` `#e0466b`, at 4.66:1 on `--surface`. It marks the sell
side and the losing figure in the MEV panel, and nothing else. It survived
because both of those are genuinely adverse; the decorative uses did not.

Two siblings have been removed as their last users went away. **Both
measurements still stand, and neither should be reinvented by eye:**

| Removed | Value | Why it existed |
|---|---|---|
| `--accent-strong` | `#c9345a` | White on `--accent` is 3.99:1 and fails AA for button text. A crimson fill carrying white text needs the darker shade. |
| `--accent-text` | `#ff8fa6` | Accent-coloured body copy on `--bg`, 9.22:1. `--accent` itself is too dark to read as running text. |

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

**Never dim text with `opacity` to push it down the hierarchy.** It composites
against whatever is behind and puts the real contrast beyond the reach of these
tokens, so the table above stops being true. The MEV panel's caveat did exactly
that, at `opacity: 0.75` over `--text-muted`, which landed below where either
token sits. Use `--text-faint`, or drop a size, or both.

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

**Form controls need `font: inherit` spelled out.** Buttons, inputs, selects and
textareas do not inherit typography from their ancestors, so setting a face on
`body` leaves every one of them in the browser's default. The page ran that way
for several commits before anyone noticed, which is the usual outcome: it is
easy to miss and obvious once seen.

---

## 4. Space, radius, elevation

4px base step, named by multiple (`--space-4` is 16px) rather than by t-shirt
size, so the arithmetic stays legible.

Radius climbs with surface size: 8px controls, 12px panels, 22px the hero glass
card, `999px` pills. A large card with a small radius looks accidental.

Three shadows only: `--shadow-card` for resting panels, `--shadow-raised` for
things that lift, `--shadow-glass` for the hero card, which needs a deeper
shadow to separate from a moving background.

### 4.1 Border sheen

Panels carry a hairline lit at two opposite corners, as if a single light were
catching the edge of a raised surface. `--sheen-angle` points at the top-right,
so the gradient runs bottom-left to top-right with `--sheen-lo` on one end and
`--sheen-hi` on the other. **Both remaining corners sit at the midpoint of that
axis and stay dark**, which is what makes it read as one light source rather
than as a glowing outline. Getting that wrong, by lighting all four corners, is
the usual way this effect ends up looking cheap.

Measured against the reference it was taken from:

| | Reference | Ours |
|---|---|---|
| Brightest corner | top-right | top-right |
| Order | TR > BR > BL > TL | TR > BR > BL > TL |
| Bright:dim ratio | 1.66x | 1.60x |

Kept deliberately near that ratio. Past roughly 2x it stops looking like a
material property and starts looking like a highlight someone drew on.

**Applied to the glass MEV card, and nothing else.** It began on the six
section cards, moved to the sheet that replaced them, and ended up here once
the sheet lost its border too (4.2). The effect needs an edge to catch light
on, and the lattice has rules rather than edges. One lit surface on the page
is the right number anyway.

Two implementation notes, both load-bearing:

- It is a **masked pseudo-element**, not the usual two-background
  `background-clip` recipe. That recipe has to paint a background, which would
  destroy the `backdrop-filter` on the glass card. Painting only the ring means
  one rule serves both solid and glass surfaces.
- The element **keeps its ordinary border**. That border is the dim baseline
  and the gradient only adds highlights, so the edge never vanishes where the
  gradient is transparent.

### 4.2 The ruled sheet

Content is divided by **dotted rules that run the full width and height of the
page**, not by boxes drawn around it. The lines cross to form cells; content
sits inside them, padded clear of the rules.

Three properties make it read as structure rather than as containers, and
losing any one of them turns it back into boxes:

1. **The rules are full bleed.** Rows span the viewport, so their horizontal
   lines run edge to edge rather than stopping at the content column. The two
   outer verticals sit at the content edges and span the whole lattice, so they
   read as one continuous rule passing behind everything.
2. **Nothing has a fill.** No cell has a background. A ruled sheet with a
   background is still a box; being able to see straight through it is the
   point.
3. **Dotted, not solid.** Solid hairlines at this density read as a table.

Behind them is a faint square texture at roughly 4% alpha, masked so it fades
rather than running under the footer. It is texture only and must stay far
below the rules in contrast.

Below 820px the columns collapse and the vertical rule becomes a horizontal
one, because a vertical rule with nothing beside it is a stray mark. The outer
verticals fall off screen at that width, which is correct for the same reason.

**The semantic pair moved with the layout.** With no card borders left to
colour, `--public` and `--private` are now legend swatches beside the two
headings. That suits a ruled sheet better than a coloured edge and keeps the
signal exactly as load-bearing as section 2.1 requires.

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

### 5.3 How the hero ends

It fades. The band has no radius and no visible boundary: both the tint and the
glow above it return to transparent before the band ends, so there is no edge
and therefore no corner to shape.

An earlier version ended on a rounded clip instead, which solved the same
problem (a hard horizontal line across the page) by giving the cut a shape
rather than by removing it. A fade removes it.

Two things have to be true, and they are the mirror of what the curve needed:

- **The aurora mask fades out at the bottom**, with a long tail. A short one
  reads as a gradient band, which is a softer boundary rather than no boundary.
- **The band's own tint fades too.** Leaving it opaque at the bottom would draw
  the very line the fade exists to remove.

### 5.4 The aurora

**React Bits' Aurora** (`reactbits.dev`, MIT), installed through the shadcn
registry rather than pasted:

```
npx shadcn@latest add @react-bits/Aurora-TS-CSS
```

The `TS-CSS` variant, not `JS-CSS`: this codebase is TypeScript and `tsc -b`
runs in the build, so a `.jsx` file would need `allowJs` for no benefit. Both
variants are the same component.

`web/src/components/Aurora.tsx` is vendored **verbatim and never edited**, so
that command stays safe to re-run and upstream fixes arrive as a clean diff.
Everything this project needs sits in `AuroraBackdrop.tsx` beside it, which
wraps it and controls whether it is mounted at all:

- Under `prefers-reduced-motion` the canvas is replaced with a static CSS
  gradient. The hero keeps its depth, nothing moves.
- While the tab is hidden the component unmounts, releasing the WebGL context
  outright rather than leaving it alive on a throttled loop.

Handling both by mounting rather than by patching the render loop is what keeps
the vendored file pristine.

Colour stops are read from `--aurora-*` at mount, so the tokens stay the single
source of truth. `blend` is 0.28, well below the upstream default of 0.5: a wide
smoothstep spreads the band into an even wash, and the shape of the light is the
point.

A CSS approximation using blurred radial gradients was tried first and thrown
away. It read as a flat blue rectangle rather than as light, which is the whole
reason to have the effect at all. The noise field is what makes it look like
anything.

Three constraints the implementation has to satisfy, each learned by getting it
wrong first:

1. **Full bleed.** `.hero-band` spans the viewport and carries the canvas;
   `.hero` is the contained grid on top. Confining the glow to the 1080px
   content column was what made it read as a rectangle.
2. **The canvas is flipped** (`transform: scaleY(-1)`). The shader's intensity
   rises with `uv.y`, and `uv.y` is 0 at the bottom in GL coordinates, so
   upstream draws its band at the top. The reference has light rising from
   below. Flipping the canvas rather than editing the shader keeps the shader
   comparable with upstream.
3. **Both hero columns are positioned** (`position: relative; z-index`). A
   static element does not participate in z-ordering against a positioned
   sibling, so without this the aurora paints over the copy. This looked exactly
   like a contrast problem and was not one.

---

## 6. Components and the registry

`web/components.json` configures the shadcn CLI, with the React Bits registry
registered under the `@react-bits` namespace:

```json
"registries": { "@react-bits": "https://reactbits.dev/r/{name}.json" }
```

so components install by address rather than by copy and paste:

```
npx shadcn@latest add @react-bits/Aurora-TS-CSS
```

Two conventions come with that, and both are worth keeping:

Two components come from that registry:

| Component | Used for |
|---|---|
| `@react-bits/Aurora-TS-CSS` | the hero glow |
| `@react-bits/GlassSurface-TS-CSS` | the header chips |
| `@react-bits/SpecularButton-TS-CSS` | every primary action |

`GlassSurface` needs three of its defaults overridden, and the first is not
optional: `mixBlendMode` ships as `difference`, which inverts whatever sits
behind it and turns a subtle pill into a bright inverted patch on a near-black
page. `width` and `height` ship as fixed pixel numbers, so both are handed to
CSS instead, because a pill has to size to its label. Those overrides live in
`GlassPill.tsx`, not in the vendored file.

**`color-scheme: dark` is required for any of this to be visible**, and its
absence is worth recording because the symptom points nowhere near the cause.
GlassSurface paints its rim highlights through `light-dark()`. With no
`color-scheme` declared, a page defaults to light no matter how dark its own
colours are, so those highlights resolved to black on a black page and the
pills rendered as flat dark blobs with no glass at all. The fix is one
declaration on `:root`, not tuning the component's numbers.

Worth knowing what glass can and cannot do here: on a flat near-black backdrop
there is nothing behind the pill to refract, so what reads as glass is the
frost plus the rim light. The distortion only shows where something sits
behind, which on this page means the hero.

Pill text measures 7.6:1 on the badge and 6.7:1 on the chips, so the glass
costs no legibility.

`SpecularButton` is used **once**, on Connect wallet. Its settings live in
`PrimaryButton.tsx`, which also drops both the idle animation and the pointer
tracking under `prefers-reduced-motion`, since each instance runs its own WebGL
context and frame loop.

Every other action uses `.btn-quiet`: an almost-transparent grey fill on a
hairline border. One specular button and several quiet ones gives the page a
single loudest thing, which is the point of having a loudest thing. Three of
them competed, and the one that actually matters to a first-time visitor,
connecting a wallet, was the one that got lost.

**One documented deviation from the rule below.** `SpecularButton.tsx` needed a
one-line change to compile: it derives a `steer` boolean that implies
`pointerAngle != null`, but that narrowing does not survive the intermediate
variable under `strict`, so `tsc -b` fails on it. Repeating the check inline is
a no-op at runtime. It is marked in the file. Re-running `shadcn add` will
overwrite it and the build will fail until it is reapplied.

**Vendored files are never edited.** Anything installed from a registry stays
byte-for-byte upstream, and project-specific behaviour goes in a wrapper beside
it (`Aurora.tsx` vendored, `AuroraBackdrop.tsx` ours). That is what makes
re-running `add` safe, and what makes an upstream fix a clean diff instead of a
merge.

**Imports resolve through `@/`.** The alias is declared in `tsconfig.json` and
mirrored in `vite.config.ts`, because shadcn writes imports in that form.

### What was not adopted

shadcn's default token names (`--background`, `--foreground`, `--primary`) are
deliberately not used. They describe a role in a generic UI kit; ours describe a
role in this product, and `--public` and `--private` carry an argument that
`--primary` and `--secondary` cannot. The tokens keep their names and their
place in `styles/tokens.css`; the CLI is used for its registry and its file
conventions, not its palette.

Tailwind is likewise not installed. The `tailwind` block in `components.json`
exists because the schema expects it, and points at `styles.css` so the CLI
knows where the stylesheet lives. Every registry item used here is a `-CSS`
variant, which ships plain CSS and needs no utility classes.

---

## 7. Accessibility

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

## 8. Performance budget

| Item | Now | Ceiling |
|---|---|---|
| JS, gzipped | 171 kB | 200 kB |
| CSS, gzipped | ~4 kB | 10 kB |
| Fonts, latin subset | 96 kB | 120 kB |

Two WebGL contexts: the aurora and the one specular button. The aurora stops
when the tab is hidden and never starts under `prefers-reduced-motion`; the
button drops its idle animation and pointer tracking under the same setting.

Two is the ceiling. Anything else wanting a canvas has to replace one of these
rather than join them.

---

## 9. Anti-patterns

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
