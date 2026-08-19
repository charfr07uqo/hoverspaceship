import * as THREE from 'three';

/**
 * Whether the active GL context can only give us `mediump` floats in fragment
 * shaders. Detected once from the real renderer and cached, because it changes
 * how surfaces have to be shaded (see below).
 *
 * Why this matters
 * ----------------
 * WebGL2 guarantees `highp` in fragment shaders; WebGL1 does not, and a fair
 * number of older Android GPUs report no fragment `highp` at all. three then
 * silently compiles the whole scene with `precision mediump float`
 * (WebGLCapabilities.getMaxPrecision falls back), which on most scenes is
 * invisible.
 *
 * It is not invisible here. `mediump` is typically fp16, so the largest finite
 * value is ~65504. This game's camera sits at z = 552 in world units, so
 * `vViewPosition` has a magnitude in the hundreds and every
 * `normalize( vViewPosition )` in three's lighting chunks squares it first:
 * 552^2 ~= 305000 overflows to inf, `inversesqrt( inf )` is 0, and the view
 * direction collapses to a zero vector. Point-light attenuation, which takes
 * `length()` of the same kind of vector, dies the same way.
 *
 * The visible result is that every MeshStandardMaterial surface loses all
 * lighting and renders as an unlit silhouette - and any fresnel term written as
 * `1 - dot( normal, viewDir )` saturates to 1 across the whole surface, painting
 * the object flat in the rim colour. That is exactly the "asteroids are flat
 * cyan blobs on one particular phone" report.
 *
 * Rather than fight fp16 range with a world-scale rewrite, affected devices get
 * lighting-free materials with the shading baked into vertex colours.
 */
let lowPrecision: boolean | null = null;

/** Call once, right after the renderer is created. */
export function detectGLPrecision(renderer: THREE.WebGLRenderer): void {
  lowPrecision = renderer.capabilities.precision !== 'highp';
}

export function isLowPrecisionGL(): boolean {
  // Default to the safe assumption only once a renderer has reported in;
  // before that, assume a capable context so nothing regresses on desktop.
  return lowPrecision === true;
}
