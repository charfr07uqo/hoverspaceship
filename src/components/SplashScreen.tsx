import React, { useEffect, useRef, useState } from 'react';
import { SplashFleet } from './SplashFleet';

/** Length of the warp-out, matched by the `.splash-exiting` CSS transition. */
export const SPLASH_EXIT_MS = 1000;

interface SplashScreenProps {
  isVisible: boolean;
  onFinish: () => void;
  /** Fired when the 1s warp-out starts, so the menu can animate in underneath. */
  onExitStart?: () => void;
  durationMs?: number;
}

/**
 * Animated boot / splash screen shown once when the app loads.
 * Plays a warp-in title animation for ~3 seconds, then fades out and
 * signals the app to reveal the home screen.
 */
export const SplashScreen: React.FC<SplashScreenProps> = ({
  isVisible,
  onFinish,
  onExitStart,
  durationMs = 3000
}) => {
  const [isExiting, setIsExiting] = useState(false);

  // The callbacks are read through refs so a caller passing inline arrows cannot
  // re-trigger the effect. Restarting these timers on every App re-render was
  // what kept the splash alive and replayed the menu warp-in on a loop.
  const onFinishRef = useRef(onFinish);
  const onExitStartRef = useRef(onExitStart);
  onFinishRef.current = onFinish;
  onExitStartRef.current = onExitStart;

  useEffect(() => {
    if (!isVisible) return;

    // Begin the 1s warp-out before the hard cut so it blends into the menu
    const exitDelay = Math.max(0, durationMs - SPLASH_EXIT_MS);
    const exitTimer = window.setTimeout(() => {
      setIsExiting(true);
      onExitStartRef.current?.();
    }, exitDelay);
    const finishTimer = window.setTimeout(() => onFinishRef.current(), durationMs);

    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(finishTimer);
    };
  }, [isVisible, durationMs]);

  if (!isVisible) return null;

  // 24 warp streaks radiating from the center
  const streaks = Array.from({ length: 24 });

  return (
    <div className={`splash-screen ${isExiting ? 'splash-exiting' : ''}`}>
      <div className="splash-warp">
        {streaks.map((_, i) => (
          <span
            key={i}
            className="splash-streak"
            style={{
              transform: `rotate(${(360 / streaks.length) * i}deg)`,
              animationDelay: `${(i % 6) * 0.08}s`
            }}
          />
        ))}
      </div>

      <div className="splash-content">
        <SplashFleet />
        <h1 className="splash-title">HOVER SPACESHIP</h1>
        <p className="splash-tagline">INITIALIZING FLIGHT SYSTEMS</p>
        <div className="splash-loader">
          <span className="splash-loader-bar" />
        </div>
      </div>
    </div>
  );
};
