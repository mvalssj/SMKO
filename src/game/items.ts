// Items on the track (bananas, shells), simulated identically on every client from their spawn frame.

import type { NetEntity } from '../../shared/protocol';
import type { Track } from '../rom/rom';
import { terrainAt } from './physics';
import { wrapDX, wrapDY, wrapX, wrapY } from '../../shared/royale';

/** A shell spawned without its own speed (an older server). */
const SHELL_SPEED = 4.6;
/** Bowser's fireballs roll slowly and wander, then burn out. */
const FIREBALL_SPEED = 0.9;
const FIREBALL_LIFE = 60 * 8;
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
  const speed = e.kind === 'greenShell' || e.kind === 'redShell' ? e.s ?? SHELL_SPEED : e.kind === 'fireball' ? FIREBALL_SPEED : 0;
  return { ...e, vx: Math.sin(e.a) * speed, vy: -Math.cos(e.a) * speed, at: e.frame, dead: false };
}

/** Advances an entity to `frame`. `targetPos` finds where a red shell's target is. */
export function advanceEntity(e: Entity, track: Track, frame: number, targetPos: (id: number) => { x: number; y: number } | null) {
  while (!e.dead && e.at < frame) {
    e.at++;
    if (e.kind === 'banana' || e.kind === 'poison' || e.kind === 'egg') return;
    const age = e.at - e.frame;
    if (age > (e.kind === 'redShell' ? RED_LIFE : e.kind === 'fireball' ? FIREBALL_LIFE : GREEN_LIFE)) { e.dead = true; return; }
    if (e.kind === 'fireball' && age % 40 === 0) {
      // Wanders: a new direction every 40 frames, decided by its id and age so every client agrees.
      const a = e.a + Math.sin(e.id * 12.9898 + age * 0.37) * 1.2;
      e.vx = Math.sin(a) * FIREBALL_SPEED;
      e.vy = -Math.cos(a) * FIREBALL_SPEED;
    }

    if (e.kind === 'redShell' && e.target !== null && age > 6) {
      const t = targetPos(e.target);
      if (t) {
        const want = Math.atan2(wrapDX(t.x - e.x), -wrapDY(t.y - e.y));
        let cur = Math.atan2(e.vx, -e.vy);
        let d = want - cur;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        cur += Math.max(-RED_TURN, Math.min(RED_TURN, d));
        const v = e.s ?? SHELL_SPEED;
        e.vx = Math.sin(cur) * v;
        e.vy = -Math.cos(cur) * v;
      }
    }

    // Bounce off walls, one axis at a time (fast shells in steps of at most 4 px: no jumping thin walls).
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(e.vx), Math.abs(e.vy)) / 4));
    for (let i = 0; i < steps; i++) {
      if (terrainAt(track, e.x + e.vx / steps, e.y) === 'wall') e.vx = -e.vx;
      else e.x += e.vx / steps;
      if (terrainAt(track, e.x, e.y + e.vy / steps) === 'wall') e.vy = -e.vy;
      else e.y += e.vy / steps;
    }
    // The Battle Royale world wraps round: off one edge, in at the other.
    if (track.world) { e.x = wrapX(e.x); e.y = wrapY(e.y); }
    if (terrainAt(track, e.x, e.y) === 'fall') e.dead = true;
  }
}
