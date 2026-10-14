// CPU drivers: steer with the ROM's own AI data (while inside area i, aim at target i),
// go around pipes and plants, back up when stuck.

import type { Track } from '../rom/rom';
import { aiAreaAt, terrainAt, type Input, type Kart } from './physics';

const NO_START: Input = { accel: false, brake: false, left: false, right: false, drift: false };

export class CpuDriver {
  private area: number;
  private stuck = 0;
  private stuckFrom = { x: 0, y: 0 };
  private reverse = 0;
  private nextDrop: number;
  private bestProgress = -Infinity;
  private noProgress = 0;

  /** `skill` 0..1 sets the CPU's top speed (see Kart.speedScale). */
  constructor(private track: Track, k: Kart, readonly skill = 1, private random: () => number = Math.random) {
    this.area = k.pathIndex;
    this.nextDrop = 600 + Math.floor(this.random() * 900);
  }

  input(k: Kart): Input {
    this.rescueIfLost(k);
    this.area = aiAreaAt(this.track, k.x, k.y, this.area);
    const target = this.track.path[this.area];
    const aim = Math.atan2(target.x - k.x, -(target.y - k.y));
    let d = aim - k.angle;
    d = Math.atan2(Math.sin(d), Math.cos(d));

    // Swerve around static obstacles just ahead, toward whichever side is clear.
    const fx = Math.sin(k.angle), fy = -Math.cos(k.angle);
    for (const o of this.track.objects) {
      if (o.kind !== 'pipe' && o.kind !== 'plant' && o.kind !== 'pillar') continue;
      const ox = o.x - k.x, oy = o.y - k.y;
      const ahead = ox * fx + oy * fy;
      const side = ox * -fy + oy * fx; // > 0: object to the right
      if (!(ahead > 0 && ahead < 30 + k.speed * 16 && Math.abs(side) < 13)) continue;
      const clear = (dir: number) => {
        const x = o.x - fy * dir * 18, y = o.y + fx * dir * 18;
        const t = terrainAt(this.track, x, y);
        const free = this.track.objects.every((p) => p === o || Math.hypot(p.x - x, p.y - y) > 14);
        return free && (t === 'road' || t === 'slow' || t === 'boost');
      };
      const preferred = side > 0 ? -1 : 1;
      if (clear(preferred)) d = preferred * 0.5;
      else if (clear(-preferred)) d = -preferred * 0.5;
    }

    // Stuck = barely moved in the last second while on the ground (speed alone builds up slowly from a stop).
    if (k.fall === 0 && k.air === 0 && this.reverse === 0) {
      this.stuck++;
      if (Math.hypot(k.x - this.stuckFrom.x, k.y - this.stuckFrom.y) > 12) { this.stuck = 0; this.stuckFrom = { x: k.x, y: k.y }; }
    } else this.stuckFrom = { x: k.x, y: k.y };
    if (this.stuck > 60) { this.reverse = 40; this.stuck = 0; }
    if (this.reverse > 0) {
      this.reverse--;
      return { accel: false, brake: true, left: d > 0, right: d <= 0, drift: false };
    }
    // The turn rate builds up and dies down over several frames: steer toward the rate that closes the
    // angle gap (game angle units per frame), not just toward the target, so the CPU doesn't weave.
    const want = Math.max(-352, Math.min(352, d * 1400));
    const left = k.turnRate > want + 20, right = k.turnRate < want - 20;
    // Sharp bend at speed: lift off and power slide through it.
    const sharp = Math.abs(d) > 0.9;
    return { accel: !(sharp && k.speed > 2.4), brake: false, left, right, drift: Math.abs(d) > 0.5 && (left || right) };
  }

  /**
   * Like the original game does with CPUs that get lost: if the kart hasn't made progress for 6 s
   * (stuck, or falling over and over), Lakitu puts it back on the course at the next AI target.
   */
  private rescueIfLost(k: Kart) {
    if (k.progress > this.bestProgress) {
      this.bestProgress = k.progress;
      this.noProgress = 0;
      return;
    }
    if (++this.noProgress < 360) return;
    this.noProgress = 0;
    const n = this.track.path.length;
    const at = this.track.path[(this.area + 1) % n];
    const next = this.track.path[(this.area + 2) % n];
    k.x = at.x;
    k.y = at.y;
    k.angle = Math.atan2(next.x - at.x, -(next.y - at.y));
    k.vx = k.vy = k.speed = 0;
    k.fall = k.air = k.spin = 0;
    k.safe = { x: k.x, y: k.y, angle: k.angle };
  }

  /**
   * Countdown: CPUs press accelerate in the start-boost window about half the time, like a good player
   * (the original's CPUs shoot off the line too).
   */
  startInput(frame: number): Input {
    this.startAt ??= this.random() < 0.5 ? -126 : -60;
    return { ...NO_START, accel: frame >= this.startAt };
  }
  private startAt: number | null = null;

  /** True when the CPU wants to use its special item this frame (every 10-25 s). */
  wantsDrop(): boolean {
    if (--this.nextDrop > 0) return false;
    this.nextDrop = 600 + Math.floor(this.random() * 900);
    return true;
  }
}

/**
 * Keeps CPUs in the race: slower when far ahead of the best human, a bit faster when far behind.
 * `gap` = CPU progress minus the leading human's progress, in AI areas.
 */
export function rubberBand(skill: number, gap: number): number {
  const base = 0.9 + skill * 0.08;
  if (gap > 8) return base * 0.88;
  if (gap < -8) return Math.min(1.02, base * 1.06);
  return base;
}
