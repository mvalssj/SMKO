// Items on the track (bananas, shells), simulated identically on every client from their spawn frame.

import type { NetEntity } from '../../shared/protocol';
import type { Track } from '../rom/rom';
import { terrainAt } from './physics';

const SHELL_SPEED = 4.6;
const RED_TURN = 0.09;
const GREEN_LIFE = 60 * 10;
const RED_LIFE = 60 * 12;
/** Distance between a kart and an item that counts as a hit. */
export const ITEM_HIT_DISTANCE = 8;
/** The thrower can't hit their own shell right after throwing it. */
export const OWNER_GRACE_FRAMES = 30;

export interface Entity extends NetEntity {
  vx: number;
  vy: number;
  /** Last simulated race frame. */
  at: number;
  dead: boolean;
}

export function createEntity(e: NetEntity): Entity {
  const speed = e.kind === 'banana' ? 0 : SHELL_SPEED;
  return { ...e, vx: Math.sin(e.a) * speed, vy: -Math.cos(e.a) * speed, at: e.frame, dead: false };
}

/** Advances an entity to `frame`. `targetPos` finds where a red shell's target is. */
export function advanceEntity(e: Entity, track: Track, frame: number, targetPos: (id: number) => { x: number; y: number } | null) {
  while (!e.dead && e.at < frame) {
    e.at++;
    if (e.kind === 'banana') return;
    const age = e.at - e.frame;
    if (age > (e.kind === 'redShell' ? RED_LIFE : GREEN_LIFE)) { e.dead = true; return; }

    if (e.kind === 'redShell' && e.target !== null && age > 6) {
      const t = targetPos(e.target);
      if (t) {
        const want = Math.atan2(t.x - e.x, -(t.y - e.y));
        let cur = Math.atan2(e.vx, -e.vy);
        let d = want - cur;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        cur += Math.max(-RED_TURN, Math.min(RED_TURN, d));
        e.vx = Math.sin(cur) * SHELL_SPEED;
        e.vy = -Math.cos(cur) * SHELL_SPEED;
      }
    }

    // Bounce off walls, one axis at a time.
    if (terrainAt(track, e.x + e.vx, e.y) === 'wall') e.vx = -e.vx;
    else e.x += e.vx;
    if (terrainAt(track, e.x, e.y + e.vy) === 'wall') e.vy = -e.vy;
    else e.y += e.vy;
    if (terrainAt(track, e.x, e.y) === 'fall') e.dead = true;
  }
}
