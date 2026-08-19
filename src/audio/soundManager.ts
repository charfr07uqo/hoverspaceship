import { DifficultyKey } from '../types/game';

class SoundManager {
  private audioCtx: AudioContext | null = null;
  private lastFlySoundTime = 0;

  public init(): void {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  public playFlySound(): void {
    const now = Date.now();
    if (now - this.lastFlySoundTime < 150) return;
    this.lastFlySoundTime = now;

    if (!this.audioCtx) return;
    try {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(130, this.audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, this.audioCtx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.06, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.12);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.12);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  public playGemSound(): void {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.setValueAtTime(880.00, now + 0.08);

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.22);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  public playHitSound(): void {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(25, now + 0.35);

      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.35);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  public playDiffSwitchSound(diff: DifficultyKey): void {
    if (!this.audioCtx) return;
    try {
      const frequencies: Record<DifficultyKey, number> = {
        easy: 329.63,
        normal: 440.00,
        hard: 554.37,
        exhard: 739.99
      };
      const freq = frequencies[diff] || 440.00;
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.25, now + 0.12);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.14);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  /**
   * Short burst of filtered white noise used for explosions (enemy vaporized,
   * asteroid smashed, player destroyed). `intensity` scales the volume and
   * duration so bigger blasts sound heftier.
   */
  public playExplosionSound(intensity = 1): void {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      const duration = 0.35 + 0.25 * intensity;

      // White-noise buffer
      const bufferSize = Math.floor(this.audioCtx.sampleRate * duration);
      const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        // Decaying noise so the tail fades naturally.
        const decay = 1 - i / bufferSize;
        data[i] = (Math.random() * 2 - 1) * decay * decay;
      }

      const noise = this.audioCtx.createBufferSource();
      noise.buffer = buffer;

      // Low-pass sweep from bright to dull for a "boom" character.
      const filter = this.audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1800, now);
      filter.frequency.exponentialRampToValueAtTime(120, now + duration);

      const gain = this.audioCtx.createGain();
      gain.gain.setValueAtTime(Math.min(0.5, 0.28 * intensity), now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.audioCtx.destination);

      noise.start(now);
      noise.stop(now + duration);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  /**
   * Distinct alert tone for each enemy variant as it spawns.
   * - standard: mid two-tone blip
   * - heavy: low, slow, menacing rumble
   * - scout: fast high-pitched chirp
   */
  public playEnemySpawnSound(variantKey: string): void {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      let startFreq = 300;
      let endFreq = 200;
      let type: OscillatorType = 'square';
      let dur = 0.18;
      let vol = 0.14;

      if (variantKey === 'heavy') {
        type = 'sawtooth';
        startFreq = 140;
        endFreq = 70;
        dur = 0.4;
        vol = 0.2;
      } else if (variantKey === 'scout') {
        type = 'square';
        startFreq = 720;
        endFreq = 1180;
        dur = 0.14;
        vol = 0.12;
      } else {
        // standard drone
        type = 'triangle';
        startFreq = 360;
        endFreq = 260;
        dur = 0.2;
        vol = 0.13;
      }

      osc.type = type;
      osc.frequency.setValueAtTime(startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(endFreq, now + dur);

      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + dur);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  /** Triumphant ascending arpeggio when a new sector/level begins. */
  public playLevelUpSound(): void {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      // C5 - E5 - G5 - C6 major arpeggio
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        const start = now + i * 0.09;
        const osc = this.audioCtx!.createOscillator();
        const gain = this.audioCtx!.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);

        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);

        osc.connect(gain);
        gain.connect(this.audioCtx!.destination);

        osc.start(start);
        osc.stop(start + 0.24);
      });
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  /** Descending "game over" fanfare played when the player is destroyed. */
  public playLoseSound(): void {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      // Descending minor tones: G4 - Eb4 - C4 - G3
      const notes = [392.0, 311.13, 261.63, 196.0];
      notes.forEach((freq, i) => {
        const start = now + 0.12 + i * 0.16;
        const osc = this.audioCtx!.createOscillator();
        const gain = this.audioCtx!.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, start);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.94, start + 0.3);

        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.2, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.32);

        osc.connect(gain);
        gain.connect(this.audioCtx!.destination);

        osc.start(start);
        osc.stop(start + 0.34);
      });
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  /** Whoosh used for the spacewarp transition between sectors. */
  public playWarpSound(): void {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.5);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.55);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }
}

export const soundManager = new SoundManager();
