/**
 * The mark: two blocks with a rule between them.
 *
 * It is the product drawn small. The left block is `--public`, the right is
 * `--private`, and the bar between them is the midpoint they clear at. Those
 * are the same two colours the interface uses to separate what the chain sees
 * from what only the enclave sees, so the logo is not decoration on top of the
 * design system, it is the design system.
 *
 * Colours come from the tokens rather than being repeated as hex, so a change
 * to the semantic pair reaches the mark too. The favicon in `index.html` is the
 * same drawing with the values inlined, because a data URI cannot read custom
 * properties; those two need to be changed together.
 *
 * Hidden from assistive technology: the wordmark beside it already says
 * "Midpoint", and announcing it twice helps nobody.
 */
export default function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="7" fill="var(--surface-2)" />
      <rect width="32" height="32" rx="7" fill="none" stroke="var(--line-strong)" />
      <rect x="5" y="10" width="7" height="12" rx="2" fill="var(--public)" />
      <rect x="20" y="10" width="7" height="12" rx="2" fill="var(--private)" />
      <rect x="15" y="4" width="2" height="24" rx="1" fill="var(--text)" />
    </svg>
  );
}
