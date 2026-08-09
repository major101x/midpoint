/**
 * The aurora behind the hero.
 *
 * Three blurred radial blobs drifting on long, mutually prime periods, so the
 * composite never visibly loops. Pure CSS: no canvas, no WebGL, no dependency.
 *
 * @remarks React Bits' Aurora was the obvious candidate and was rejected on
 * cost. It pulls in OGL and runs a WebGL context and a fragment shader every
 * frame for the whole time the page is open. This page is a trading interface
 * that people leave sitting in a tab, and the effect wanted here is a slow
 * ambient wash that three `filter: blur()` layers reproduce closely. Animating
 * only `transform` and `opacity` keeps the work on the compositor, off the
 * main thread, and off the CPU when the tab is hidden, which the browser
 * handles for us.
 *
 * Decorative, so it is hidden from assistive technology and stops entirely
 * under `prefers-reduced-motion`. The gradient stays in that case: the look
 * does not depend on the movement.
 */
export default function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <span className="aurora-blob aurora-1" />
      <span className="aurora-blob aurora-2" />
      <span className="aurora-blob aurora-3" />
      <span className="aurora-veil" />
    </div>
  );
}
