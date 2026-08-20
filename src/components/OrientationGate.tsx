import React, { useEffect, useState } from 'react';

/**
 * Media query for "a touch device being held sideways".
 *
 * `pointer: coarse` keeps the gate off desktops, where a short, wide browser
 * window is a legitimate way to play and the 9:16 frame simply letterboxes.
 */
const LANDSCAPE_QUERY = '(orientation: landscape) and (pointer: coarse)';

/**
 * The Screen Orientation API's lock() is only honoured while the document is
 * fullscreen, and only on browsers that implement it (Chrome/Edge on Android).
 * iOS Safari has neither, which is why the CSS/React gate below exists as the
 * portable fallback rather than as a nicety.
 */
interface LockableOrientation {
  lock?: (orientation: 'portrait') => Promise<void>;
  unlock?: () => void;
}

/**
 * Best-effort request for a hard portrait lock. Silently gives up when the
 * browser has no lock(), rejects it (not fullscreen), or exposes no
 * screen.orientation at all — the visual gate covers those cases.
 */
export const requestPortraitLock = async (): Promise<void> => {
  if (typeof window === 'undefined') return;
  const orientation = window.screen?.orientation as LockableOrientation | undefined;
  if (!orientation?.lock) return;
  try {
    await orientation.lock('portrait');
  } catch {
    // Locking is not permitted here (no fullscreen, or unsupported). Ignore.
  }
};

/** Releases a previously acquired lock so leaving fullscreen frees the screen. */
export const releaseOrientationLock = (): void => {
  if (typeof window === 'undefined') return;
  const orientation = window.screen?.orientation as LockableOrientation | undefined;
  try {
    orientation?.unlock?.();
  } catch {
    // Nothing held a lock. Ignore.
  }
};

interface OrientationGateProps {
  /** Notifies the app so the simulation can be paused while the gate is up. */
  onBlockedChange?: (blocked: boolean) => void;
}

/**
 * Full-screen "rotate your device" gate. The game is authored as a 9:16 portrait
 * experience — in landscape the frame shrinks to a sliver — so rather than
 * letting it render unplayably small, sideways play is blocked outright on touch
 * devices and the simulation is paused until the device is turned upright.
 */
export const OrientationGate: React.FC<OrientationGateProps> = ({ onBlockedChange }) => {
  const [blocked, setBlocked] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(LANDSCAPE_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(LANDSCAPE_QUERY);
    const sync = () => setBlocked(mq.matches);
    sync();
    // addEventListener on MediaQueryList is unsupported on older WebKit, which
    // still only offers the deprecated addListener.
    if (mq.addEventListener) {
      mq.addEventListener('change', sync);
      return () => mq.removeEventListener('change', sync);
    }
    mq.addListener(sync);
    return () => mq.removeListener(sync);
  }, []);

  useEffect(() => {
    onBlockedChange?.(blocked);
  }, [blocked, onBlockedChange]);

  // While sideways, try to talk the browser into rotating back on its own. This
  // only ever succeeds in fullscreen on supporting browsers; harmless otherwise.
  useEffect(() => {
    if (blocked) void requestPortraitLock();
  }, [blocked]);

  if (!blocked) return null;

  return (
    <div className="orientation-gate" role="alertdialog" aria-modal="true" aria-live="assertive">
      <div className="orientation-gate-card">
        <div className="orientation-gate-icon" aria-hidden="true">
          📱
        </div>
        <h2 className="orientation-gate-title">ROTATE YOUR DEVICE</h2>
        <p className="orientation-gate-text">
          Hover Spaceship flies in portrait only. Turn your device upright to resume the run.
        </p>
      </div>
    </div>
  );
};
