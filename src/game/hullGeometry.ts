import * as THREE from 'three';

/**
 * Shared airframe geometry builders.
 *
 * Every hull in the game (player and enemy) is modelled nose-first along +X,
 * with +Y up and ±Z as the wingspan. These helpers turn compact outline data
 * into geometry in that convention, so a ship definition reads as a list of
 * coordinates rather than a pile of transform calls.
 */

/**
 * Mirrors a half-outline given on the +z side into a full symmetric loop.
 * The half runs inboard-front -> outboard -> inboard-rear; the closing edge
 * across the centreline is short enough to stay buried in the fuselage.
 */
export function mirrorOutline(half: Array<[number, number]>): Array<[number, number]> {
  const back: Array<[number, number]> = [];
  for (let i = half.length - 1; i >= 0; i--) {
    const [x, s] = half[i];
    // Points already on the centreline are their own mirror; duplicating them
    // would leave zero-length edges for the triangulator to choke on.
    if (Math.abs(s) < 1e-6) continue;
    back.push([x, -s]);
  }
  return [...half, ...back];
}

/**
 * Flat horizontal planform (wing, canard, strake, deck plan) built from a
 * mirrored half-outline of `[x, span]` pairs, extruded to `thickness` and
 * centred on y = 0 so callers position it by its mid-plane.
 */
export function makePlanform(
  half: Array<[number, number]>,
  thickness: number,
  bevel = 0.45
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  mirrorOutline(half).forEach(([x, s], i) => (i ? shape.lineTo(x, s) : shape.moveTo(x, s)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel
  });
  geo.rotateX(Math.PI / 2); // lay the slab flat: shape span -> z, depth -> -y
  geo.translate(0, thickness / 2, 0);
  return geo;
}

/**
 * Vertical blade (fin, rudder, wedge) from an `[x, y]` side profile,
 * extruded across z and centred on the centreline.
 */
export function makeFin(
  outline: Array<[number, number]>,
  thickness: number,
  bevel = 0
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  outline.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel
  });
  geo.translate(0, 0, -thickness / 2);
  return geo;
}

/**
 * Revolved hull from a `[radius, axial]` profile. The lathe spins about +Y,
 * then the whole thing is turned so the nose points down +X, and squashed by
 * `yScale`/`zScale` into a flattened or widened section.
 */
export function makeRevolvedHull(
  profile: Array<[number, number]>,
  yScale: number,
  zScale: number,
  segments = 26
): THREE.LatheGeometry {
  const geo = new THREE.LatheGeometry(
    profile.map(([r, a]) => new THREE.Vector2(r, a)),
    segments
  );
  geo.rotateZ(-Math.PI / 2);
  geo.scale(1, yScale, zScale);
  geo.computeVertexNormals();
  return geo;
}
