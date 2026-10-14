// Track object behaviour (pipes, Thwomps, moles, piranha plants, fish).
// Animation is a pure function of the race frame, so every client sees the same thing without syncing.
// Timings are approximations of the original game.

import type { ObjectKind } from '../rom/rom';

export interface ObjectState {
  visible: boolean;
  /** Height above the floor, in world pixels (Thwomps in the air, jumping fish). */
  height: number;
  /** Karts bounce off it. */
  solid: boolean;
  /** Karts touching it spin out. */
  harmful: boolean;
}

// Collision distance between a kart center and an object center (both sprites are ~7-8 world px wide).
export const OBJECT_HIT_DISTANCE = 8;

export function objectState(kind: ObjectKind, index: number, frame: number): ObjectState {
  // Stagger objects so they don't all move together.
  const t = Math.max(0, frame) + index * 47;
  switch (kind) {
    case 'pipe':
    case 'pillar':
      return { visible: true, height: 0, solid: true, harmful: false };
    case 'plant': {
      // Piranha plants sit in a pipe and lunge every few seconds.
      const p = t % 150;
      return { visible: true, height: 0, solid: true, harmful: p > 110 };
    }
    case 'thwomp': {
      // Up high, then slam down, stay down, rise again.
      const p = t % 240;
      let height: number;
      if (p < 140) height = 28;
      else if (p < 150) height = 28 * (1 - (p - 140) / 10);
      else if (p < 200) height = 0;
      else height = 28 * ((p - 200) / 40);
      return { visible: true, height, solid: height < 4, harmful: p >= 146 && p < 152 };
    }
    case 'mole': {
      // Hidden in the ground most of the time, pops out for a moment.
      const p = t % 200;
      const up = p >= 140;
      const height = up ? Math.sin(((p - 140) / 60) * Math.PI) * 6 : 0;
      return { visible: up, height, solid: false, harmful: up };
    }
    case 'fish': {
      // Leaps out of the water in an arc.
      const p = t % 180;
      const up = p >= 120;
      const height = up ? Math.sin(((p - 120) / 60) * Math.PI) * 26 : 0;
      return { visible: up, height, solid: false, harmful: up && height < 8 };
    }
  }
}
