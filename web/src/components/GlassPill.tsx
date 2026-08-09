/**
 * A pill with a glass surface, used for the hero badge and the header chips.
 *
 * `GlassSurface.tsx` beside this file is vendored verbatim from the React Bits
 * registry:
 *
 *   npx shadcn@latest add @react-bits/GlassSurface-TS-CSS
 *
 * As with Aurora, it is never edited, so that command stays safe to re-run.
 * This wrapper holds the project's settings and the fallback.
 *
 * @remarks Three of the upstream defaults are wrong for this page and are
 * overridden here:
 *
 *  - `mixBlendMode` defaults to `difference`, which inverts whatever sits
 *    behind it. On a near-black page that turns a subtle pill into a bright
 *    inverted patch.
 *  - `width` and `height` default to fixed pixel values. A pill has to size to
 *    its label, so both are driven by CSS instead.
 *  - `borderRadius` defaults to 20, which on a 28px-tall pill is not quite a
 *    full round.
 *
 * Upstream also disables its SVG displacement filter on Safari and Firefox,
 * falling back to a plain `backdrop-filter`. That fallback is the reason this
 * is safe to use for chrome that has to be readable everywhere.
 */

import type { ReactNode } from "react";

import GlassSurface from "@/components/GlassSurface";

export interface GlassPillProps {
  children: ReactNode;
  className?: string;
}

export default function GlassPill({ children, className = "" }: GlassPillProps) {
  return (
    <GlassSurface
      width="auto"
      height="auto"
      borderRadius={999}
      blur={12}
      backgroundOpacity={0.06}
      saturation={1.1}
      brightness={60}
      opacity={0.9}
      distortionScale={-120}
      mixBlendMode="normal"
      className={`glass-pill ${className}`.trim()}
    >
      {children}
    </GlassSurface>
  );
}
