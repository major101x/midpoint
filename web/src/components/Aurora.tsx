/**
 * Aurora, from React Bits (https://reactbits.dev, MIT).
 *
 * Ported from the upstream JSX to TypeScript. The shader is verbatim: simplex
 * noise drives a height field, which is ramped through three colour stops and
 * faded with a smoothstep. Two things are added that upstream does not have:
 *
 *  1. `prefers-reduced-motion` support. Upstream animates unconditionally. Here
 *     the render loop stops and a single frame is drawn, so the aurora is still
 *     there, just still.
 *  2. Pausing while the tab is hidden. A `requestAnimationFrame` loop is
 *     already throttled by the browser when backgrounded, but the WebGL context
 *     and its timer are not released. This is a trading interface that people
 *     leave open, so the loop is cancelled outright on `visibilitychange`.
 *
 * Decorative, so the container is hidden from assistive technology by its
 * parent.
 */

import { Color, Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef } from "react";

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ),
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop {
  vec3 color;
  float position;
};

#define COLOR_RAMP(colors, factor, finalColor) {              \
  int index = 0;                                            \
  for (int i = 0; i < 2; i++) {                               \
     ColorStop currentColor = colors[i];                    \
     bool isInBetween = currentColor.position <= factor;    \
     index = int(mix(float(index), float(i), float(isInBetween))); \
  }                                                         \
  ColorStop currentColor = colors[index];                   \
  ColorStop nextColor = colors[index + 1];                  \
  float range = nextColor.position - currentColor.position; \
  float lerpFactor = (factor - currentColor.position) / range; \
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);

  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);

  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;

  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);

  vec3 auroraColor = intensity * rampColor;

  fragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
}
`;

export interface AuroraProps {
  /** Three hex stops, sampled left to right across the canvas. */
  colorStops?: [string, string, string];
  amplitude?: number;
  blend?: number;
  speed?: number;
}

/**
 * Blue, not the upstream purple, read from the aurora ramp in `tokens.css`.
 *
 * Read rather than repeated, because design.md states that the tokens are the
 * single source of truth for colour. Hardcoding the same three hexes here
 * would work until someone retuned the ramp and this quietly disagreed. The
 * fallbacks cover the one case where the custom properties are not resolvable,
 * which is a server-side render with no computed style.
 *
 * See design.md section 2.2 for why these are kept clear of the
 * public/private semantic pair.
 */
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

export default function Aurora({ colorStops, amplitude = 1.0, blend = 0.5, speed = 1.0 }: AuroraProps) {
  const ctnDom = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ colorStops, amplitude, blend, speed });
  propsRef.current = { colorStops, amplitude, blend, speed };

  useEffect(() => {
    const ctn = ctnDom.current;
    if (!ctn) return;

    const renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: true });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.canvas.style.backgroundColor = "transparent";

    const geometry = new Triangle(gl);
    if (geometry.attributes.uv) delete (geometry.attributes as Record<string, unknown>).uv;

    const toRgb = (stops: readonly string[]) =>
      stops.map((hex) => {
        const c = new Color(hex);
        return [c.r, c.g, c.b];
      });

    const stops = colorStops ?? stopsFromTokens();

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: amplitude },
        uColorStops: { value: toRgb(stops) },
        uResolution: { value: [ctn.offsetWidth, ctn.offsetHeight] },
        uBlend: { value: blend },
      },
    });

    const mesh = new Mesh(gl, { geometry, program });
    ctn.appendChild(gl.canvas);

    function resize() {
      if (!ctn) return;
      const width = ctn.offsetWidth;
      const height = ctn.offsetHeight;
      renderer.setSize(width, height);
      program.uniforms.uResolution.value = [width, height];
    }
    window.addEventListener("resize", resize);
    resize();

    const draw = (t: number) => {
      const p = propsRef.current;
      program.uniforms.uTime.value = t * 0.01 * (p.speed ?? 1) * 0.1;
      program.uniforms.uAmplitude.value = p.amplitude ?? 1;
      program.uniforms.uBlend.value = p.blend ?? blend;
      program.uniforms.uColorStops.value = toRgb(p.colorStops ?? stops);
      renderer.render({ scene: mesh });
    };

    // A continuously animating background is what this setting exists to
    // suppress. One frame is still drawn, so the aurora is present but static.
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const loop = (t: number) => {
      frame = requestAnimationFrame(loop);
      draw(t);
    };
    const start = () => {
      if (frame || motionQuery.matches || document.hidden) return;
      frame = requestAnimationFrame(loop);
    };

    const onMotionChange = () => {
      stop();
      if (motionQuery.matches) draw(0);
      else start();
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    document.addEventListener("visibilitychange", onVisibility);
    motionQuery.addEventListener("change", onMotionChange);
    onMotionChange();

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", onMotionChange);
      if (gl.canvas.parentNode === ctn) ctn.removeChild(gl.canvas);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [amplitude, blend, colorStops]);

  return <div ref={ctnDom} className="aurora-canvas" />;
}
