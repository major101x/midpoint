/**
 * The page's primary action button.
 *
 * `SpecularButton.tsx` beside this file is vendored verbatim from the React
 * Bits registry:
 *
 *   npx shadcn@latest add @react-bits/SpecularButton-TS-CSS
 *
 * Never edited, so that command stays safe to re-run. The project's settings
 * live here.
 *
 * @remarks Each instance runs its own WebGL context and animation frame loop.
 * Three buttons plus the hero aurora puts four on the page, which is well
 * inside the browser limit but is not free, so `prefers-reduced-motion` drops
 * both the idle animation and the pointer tracking rather than only one of
 * them. The specular edge stays; it just stops moving.
 */

import { useEffect, useState, type MouseEventHandler, type ReactNode } from "react";

import SpecularButton from "@/components/SpecularButton";

export interface PrimaryButtonProps {
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  /** Stretches to the container, for the order form's submit. */
  wide?: boolean;
  type?: "button" | "submit" | "reset";
}

export default function PrimaryButton({
  children,
  onClick,
  disabled,
  wide,
  type = "button",
}: PrimaryButtonProps) {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);

  return (
    <SpecularButton
      size="lg"
      radius={18}
      tint="#ffffff"
      tintOpacity={0}
      blur={0}
      textColor="#f5f5f5"
      lineColor="#ffffff"
      baseColor="#525252"
      intensity={1}
      shineSize={10}
      shineFade={40}
      thickness={1}
      speed={1}
      followMouse={!reduced}
      proximity={250}
      autoAnimate={!reduced}
      disabled={disabled}
      onClick={onClick}
      type={type}
      className={wide ? "sb-wide" : undefined}
    >
      {children}
    </SpecularButton>
  );
}
