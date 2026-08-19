import React, { useEffect, useState } from 'react';

interface SplashScreenProps {
  isVisible: boolean;
  onFinish: () => void;
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
  durationMs = 3000
}) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (!isVisible) return;

    // Begin the fade-out slightly before the hard cut so it blends into the menu
    const exitDelay = Math.max(0, durationMs - 800);
    const exitTimer = window.setTimeout(() => setIsExiting(true), exitDelay);
    const finishTimer = window.setTimeout(() => onFinish(), durationMs);

    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(finishTimer);
    };
  }, [isVisible, durationMs, onFinish]);

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
        <div className="splash-ship">🚀</div>
        <h1 className="splash-title">HOVER SPACESHIP</h1>
        <p className="splash-tagline">INITIALIZING FLIGHT SYSTEMS</p>
        <div className="splash-loader">
          <span className="splash-loader-bar" />
        </div>
      </div>
    </div>
  );
};
