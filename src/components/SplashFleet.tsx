import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { PlayerShip } from '../game/PlayerShip';
import { SHIP_COLORS } from '../constants/gameConfig';
import { ShipColorKey, ShipModelId } from '../types/game';

/** Hulls paraded on the boot splash, one at a time. */
const FLEET: ShipModelId[] = ['dart', 'viper', 'titan', 'phantom', 'valkyrie'];

/** One accent per hull so the parade reads as a fleet rather than a colour swatch. */
const FLEET_COLORS: ShipColorKey[] = ['blue', 'green', 'red', 'pink', 'blue'];

const CAMERA_FOV = 45;
const CAMERA_Z = 300;

/** Fraction of the stage a single hull is allowed to occupy. */
const STAGE_FILL = 0.66;

/** Seconds each hull holds the stage. Five hulls fit the ~2.6s splash window. */
const SLOT_SECONDS = 0.5;

/** Share of a slot spent flying in / flying out. */
const ENTER_FRACTION = 0.3;
const EXIT_FRACTION = 0.3;

/** How far off-stage (in visible widths) a hull starts and ends its pass. */
const SLIDE_FRACTION = 0.85;

/**
 * Seconds before its slot that a hull is built. Building costs a frame, so it is
 * paid while the previous hull is still mid-pass rather than on the cut.
 */
const PREBUILD_LEAD = 0.18;

/** Pixel-ratio cap. The splash stage is decorative, so it renders below native. */
const MAX_PIXEL_RATIO = 1.5;

interface FleetEntry {
  ship: PlayerShip;
  spanX: number;
  spanY: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Real in-game ship models rendered in their own tiny WebGL scene for the boot
 * splash. Reuses `PlayerShip` so the hulls, hull shader, cockpit glass and
 * thruster plumes are literally the ones flown in game, then drives them with
 * the lightweight `updatePreview` tick (no flight, shield, trail or audio).
 *
 * The hulls are paraded solo instead of laid out in a grid: rendering and
 * ticking five full ships at once (plus five sets of plume shaders) dropped
 * frames on mid-range phones. At most two exist at any moment here — the one on
 * stage and the one being built for the next slot.
 */
export const SplashFleet: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // No WebGL available: the splash simply shows without the fleet.
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 2000);
    camera.position.set(0, 0, CAMERA_Z);
    camera.lookAt(0, 0, 0);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    // Same lighting rig as the game stage so the hulls read identically.
    scene.add(new THREE.AmbientLight(0x334155, 1.2));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(100, 200, 300);
    scene.add(dirLight);
    const themeLight = new THREE.PointLight(0x38bdf8, 2.0, 900);
    themeLight.position.set(0, 60, 200);
    scene.add(themeLight);

    // Visible world extents at the hulls' depth, refreshed by layout().
    let visibleWidth = 1;
    let visibleHeight = 1;

    /** Fits one hull to the current stage, centred on its own bounding box. */
    const rescale = (entry: FleetEntry): void => {
      entry.scale = Math.min(
        (visibleWidth * STAGE_FILL) / entry.spanX,
        (visibleHeight * STAGE_FILL) / entry.spanY
      );
      entry.ship.group.scale.setScalar(entry.scale);
    };

    const entries: (FleetEntry | null)[] = FLEET.map(() => null);

    const build = (index: number): FleetEntry => {
      const ship = new PlayerShip(scene);
      ship.setShipModel(FLEET[index]);
      const colorKey = FLEET_COLORS[index % FLEET_COLORS.length];
      ship.setShipColor((SHIP_COLORS[colorKey] || SHIP_COLORS.blue).colorHex);
      ship.setVisible(false);

      // Measured while the group is still unscaled and unrotated. The turntable
      // swings depth into view, so the horizontal footprint is the larger of the
      // fuselage length and the wingspan.
      const box = ship.getModelBounds();
      const entry: FleetEntry = {
        ship,
        spanX: Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1),
        spanY: Math.max(box.max.y - box.min.y, 1),
        // The hull is not centred on its origin (nose forward, plume aft), so it
        // is recentred in the frame rather than pivoting around its pivot point.
        offsetX: (box.max.x + box.min.x) / 2,
        offsetY: (box.max.y + box.min.y) / 2,
        scale: 1
      };
      rescale(entry);
      entries[index] = entry;
      return entry;
    };

    const release = (index: number): void => {
      const entry = entries[index];
      if (!entry) return;
      entry.ship.destroy();
      entries[index] = null;
    };

    /** Resizes the renderer and refits whatever hulls are currently alive. */
    const layout = (): void => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;

      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();

      visibleHeight = 2 * CAMERA_Z * Math.tan((CAMERA_FOV * Math.PI) / 360);
      visibleWidth = visibleHeight * camera.aspect;

      for (const entry of entries) {
        if (entry) rescale(entry);
      }
    };

    layout();

    const resizeObserver = new ResizeObserver(() => layout());
    resizeObserver.observe(container);

    let frame = 0;
    let last = performance.now();
    let elapsed = 0;

    const cycleSeconds = FLEET.length * SLOT_SECONDS;

    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      elapsed += dt;

      // Loops so the stage never goes empty if the splash outlasts one pass.
      const cycleTime = elapsed % cycleSeconds;
      const current = Math.min(FLEET.length - 1, Math.floor(cycleTime / SLOT_SECONDS));
      const slotT = (cycleTime - current * SLOT_SECONDS) / SLOT_SECONDS;

      // Pre-build the next hull mid-pass, then let the finished one go.
      const upcoming = (current + 1) % FLEET.length;
      const needsPrebuild = SLOT_SECONDS - (cycleTime - current * SLOT_SECONDS) <= PREBUILD_LEAD;

      for (let i = 0; i < FLEET.length; i++) {
        if (i === current) continue;
        if (needsPrebuild && i === upcoming) continue;
        release(i);
      }

      const entry = entries[current] ?? build(current);
      if (needsPrebuild && !entries[upcoming]) build(upcoming);

      const { ship } = entry;
      ship.setVisible(true);

      // Slide in from the left, hold centred, slide out to the right.
      let slideX = 0;
      let lift = 0;
      if (slotT < ENTER_FRACTION) {
        const p = easeOutCubic(slotT / ENTER_FRACTION);
        slideX = (1 - p) * -visibleWidth * SLIDE_FRACTION;
        lift = (1 - p) * -visibleHeight * 0.12;
      } else if (slotT > 1 - EXIT_FRACTION) {
        const p = (slotT - (1 - EXIT_FRACTION)) / EXIT_FRACTION;
        const eased = p * p;
        slideX = eased * visibleWidth * SLIDE_FRACTION;
        lift = eased * visibleHeight * 0.12;
      }

      const bob = Math.sin(elapsed * 1.8) * 3;
      ship.group.position.x = slideX - entry.offsetX * entry.scale;
      ship.group.position.y = lift + bob - entry.offsetY * entry.scale;

      ship.updatePreview(dt, 0.9);

      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      for (let i = 0; i < FLEET.length; i++) release(i);
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div className="splash-fleet" ref={containerRef} aria-hidden="true" />;
};
