/**
 * The hero's aurora, wrapped.
 *
 * `Aurora.tsx` beside this file is vendored verbatim from the React Bits
 * registry:
 *
 *   npx shadcn@latest add @react-bits/Aurora-TS-CSS
 *
 * Nothing in it is edited, so that command stays safe to re-run and upstream
 * fixes arrive as a clean diff. Everything this project needs on top lives
 * here instead.
 *
 * Two behaviours are added, both by controlling whether the component is
 * mounted at all rather than by patching its render loop:
 *
 *  1. `prefers-reduced-motion`. A continuously animating background is exactly
 *     what that setting exists to suppress. The canvas is replaced with a
 *     static CSS gradient, so the hero still has depth without movement.
 *  2. Tab visibility. `requestAnimationFrame` is throttled when backgrounded,
 *     but the WebGL context stays alive. Unmounting releases it outright,
 *     which matters on a page people leave open.
 */

import { useEffect, useState } from "react";

import Aurora from "@/components/Aurora";

/** Ramp read from tokens.css, so colour has one source of truth. */
const FALLBACK_STOPS: [string, string, string] = ["#14306e", "#2f6df0", "#0e7fb8"];

function stopsFromTokens(): [string, string, string] {
  if (typeof window === "undefined") return FALLBACK_STOPS;
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return [
    read("--aurora-1", FALLBACK_STOPS[0]),
    read("--aurora-3", FALLBACK_STOPS[1]),
    read("--aurora-4", FALLBACK_STOPS[2]),
  ];
}

export default function AuroraBackdrop() {
  const [stops, setStops] = useState<[string, string, string]>(FALLBACK_STOPS);
  const [reduced, setReduced] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => setStops(stopsFromTokens()), []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => setReduced(motion.matches);
    const onVisibility = () => setHidden(document.hidden);

    onMotion();
    onVisibility();
    motion.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      motion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="aurora" aria-hidden="true">
      {reduced || hidden ? (
        <div className="aurora-static" />
      ) : (
        // blend is well below the upstream default of 0.5: a wide smoothstep
        // spreads the band into an even wash, and the shape of the light is
        // the point.
        <Aurora colorStops={stops} amplitude={1.15} blend={0.28} speed={0.8} />
      )}
    </div>
  );
}
