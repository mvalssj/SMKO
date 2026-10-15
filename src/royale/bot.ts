// Battle Royale computer drivers. They find their way across the world with a distance map to the safe
// area (worked out once per circle over the whole floor, which wraps round), steer round walls and holes with
// feelers, pick up item boxes, hunt the nearest rivals and use their items the way the game's items work.
// Every direction and distance is taken the short way round the world (wrapDX / wrapDY).

import type { ItemKind } from '../../shared/protocol';
import { insideZone, wrapDX, wrapDY, wrapX, wrapY, type Circle } from '../../shared/royale';
import { TILE, aiAreaContains, type AiArea } from '../rom/rom';
import { NO_INPUT, terrainAt, terrainOf, type Input, type Kart } from '../game/physics';
import type { WorldTrack } from './world';

/** Cost of driving over each kind of floor (x10 per tile; diagonals x1.4); walls and holes can't be crossed. */
const COST: Record<string, number> = { road: 10, boost: 8, jump: 12, ice: 14, bump: 16, slow: 26, oil: 40 };

/** Distance map (in cost units) from every tile to the safe area, for finding the way there. */
export class NavField {
  readonly dist: Float32Array;
  readonly cols: number;
  readonly rows: number;
  private cost: Uint8Array;

  constructor(private track: WorldTrack) {
    this.cols = track.world.cols;
    this.rows = track.world.rows;
    this.dist = new Float32Array(this.cols * this.rows).fill(Infinity);
    this.cost = new Uint8Array(this.cols * this.rows);
    for (let i = 0; i < this.cost.length; i++) this.cost[i] = COST[terrainOf(track.genres[i])] ?? 0;
    // Keep off the edges: tiles next to a wall or a hole cost more, so the way runs down the middle.
    const base = this.cost.slice();
    const { cols, rows } = this;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!base[i]) continue;
      let edge = 0;
      for (let dy = -2; dy <= 2 && edge < 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = (x + dx + cols) % cols, ny = (y + dy + rows) % rows;
        if (!base[ny * cols + nx]) { edge = Math.max(edge, Math.abs(dx) <= 1 && Math.abs(dy) <= 1 ? 2 : 1); }
      }
      this.cost[i] = Math.min(60, base[i] + edge * 12);
    }
  }

  /** Re-reads the floor's terrain (broken blocks change it). */
  refresh(tiles: number[]) {
    for (const i of tiles) this.cost[i] = COST[terrainOf(this.track.genres[i])] ?? 0;
  }

  /** Distances to the tiles inside `goal`, all at once. */
  compute(goal: Circle) {
    this.begin(goal);
    while (!this.work(Infinity));
  }

  /** The next map, being worked out a little each frame (the bots use the old one meanwhile). */
  private job: { dist: Float32Array; buckets: number[][]; d: number; pending: number } | null = null;

  /** Starts working out the distances to `goal` (or near it, if it has no floor inside). */
  begin(goal: Circle) {
    const { cols, rows, cost } = this;
    const dist = new Float32Array(cols * rows).fill(Infinity);
    // Dial's algorithm: buckets by distance (edge costs are small integers, at most 6).
    const buckets: number[][] = Array.from({ length: 8 }, () => []);
    let pending = 0;
    const seed = (radius: number) => {
      // (Round the goal, either way across the world's edges; each tile once.)
      const sx = Math.min(cols, Math.ceil((2 * radius) / TILE) + 1), sy = Math.min(rows, Math.ceil((2 * radius) / TILE) + 1);
      const x0 = Math.floor((goal.x - radius) / TILE), y0 = Math.floor((goal.y - radius) / TILE);
      for (let v = 0; v < sy; v++) for (let u = 0; u < sx; u++) {
        const x = (((x0 + u) % cols) + cols) % cols, y = (((y0 + v) % rows) + rows) % rows;
        const i = y * cols + x;
        if (!cost[i] || dist[i] === 0 || Math.hypot(wrapDX((x + 0.5) * TILE - goal.x), wrapDY((y + 0.5) * TILE - goal.y)) > radius) continue;
        dist[i] = 0;
        buckets[0].push(i);
        pending++;
      }
    };
    const r = Math.max(goal.r * 0.6, 48);
    seed(r);
    if (!pending) seed(r + 400);
    this.job = { dist, buckets, d: 0, pending };
  }

  /** Carries on for up to `budgetMs`; true once the new map is in use. */
  work(budgetMs: number): boolean {
    const job = this.job;
    if (!job) return true;
    const { cols, rows, cost } = this;
    const { dist, buckets } = job;
    const size = buckets.length;
    const t0 = performance.now();
    let n = 0;
    while (job.pending > 0) {
      const bucket = buckets[job.d % size];
      if (!bucket.length) { job.d++; continue; }
      const i = bucket.pop()!;
      job.pending--;
      const d = job.d;
      if (dist[i] < d) continue;
      const x = i % cols, y = (i - x) / cols;
      for (let k = 0; k < 8; k++) {
        const nx = (x + NB_X[k] + cols) % cols, ny = (y + NB_Y[k] + rows) % rows;
        const j = ny * cols + nx;
        const c = cost[j];
        if (!c) continue;
        const nd = d + Math.max(1, Math.round((c * NB_STEP[k]) / 100));
        if (nd < dist[j]) {
          dist[j] = nd;
          buckets[nd % size].push(j);
          job.pending++;
        }
      }
      if ((++n & 4095) === 0 && performance.now() - t0 > budgetMs) return false;
    }
    this.dist.set(dist);
    this.job = null;
    return true;
  }

  /** A point a few tiles further along the way to the safe area, from (x, y). */
  ahead(x: number, y: number, steps = 6): { x: number; y: number } | null {
    const { cols, rows, dist } = this;
    let tx = Math.floor(wrapX(x) / TILE) % cols, ty = Math.floor(wrapY(y) / TILE) % rows;
    for (let s = 0; s < steps; s++) {
      let best = dist[ty * cols + tx], bx = tx, by = ty;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = (tx + dx + cols) % cols, ny = (ty + dy + rows) % rows;
        const d = dist[ny * cols + nx];
        if (d < best) { best = d; bx = nx; by = ny; }
      }
      if (bx === tx && by === ty) break;
      tx = bx; ty = by;
    }
    if (!Number.isFinite(dist[ty * cols + tx])) return null;
    return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
  }
}

const NB_X = [1, -1, 0, 0, 1, 1, -1, -1];
const NB_Y = [0, 0, 1, -1, 1, -1, 1, -1];
const NB_STEP = [10, 10, 10, 10, 14, 14, 14, 14];

export interface Rival { id: number; x: number; y: number; a: number; star: boolean }

export interface BotView {
  frame: number;
  /** The safe area now and the one it closes on next. */
  zone: Circle;
  next: Circle;
  nav: NavField;
  rivals: Rival[];
  boxes: { x: number; y: number }[];
  spawns: { x: number; y: number; angle: number }[];
  item: ItemKind | null;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Heading from the kart to a point, the short way round the world. */
const heading = (k: { x: number; y: number }, p: { x: number; y: number }) => Math.atan2(wrapDX(p.x - k.x), -wrapDY(p.y - k.y));
const FEELERS = [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.4, -1.4];

/**
 * What a bot is doing: racing round the course it is on (the ROM's racing line, as the CPUs drive), finding
 * its way (distance map) into the safe area or to another course, or going for something close by.
 */
type Plan = { kind: 'race' } | { kind: 'nav' } | { kind: 'seek'; x: number; y: number };

export class BotDriver {
  private plan: Plan = { kind: 'race' };
  /** Course whose racing line we follow, and the AI area we're in. */
  private course = -1;
  private area = 0;
  private lastPos = { x: 0, y: 0, frame: 0 };
  private reverseUntil = 0;
  private reverseSteer = 1;
  private useItem = false;
  private useBack = false;
  private itemSince = 0;
  private heldItem: ItemKind | null = null;
  /** Frames left racing round this course before moving on to another (a bot doesn't stay put forever). */
  private roamAt: number;
  /** The racing line's target is behind something (a wall): steer round with the feelers. */
  private blocked = false;
  private lastAim = 0;
  private rescued = false;
  /** Stuck again and again: follow the distance map for a while instead of the racing line. */
  private stuckCount = 0;
  private navUntil = 0;

  constructor(private track: WorldTrack, readonly id: number, readonly skill: number, private rand: () => number) {
    this.roamAt = 60 * (20 + Math.floor(rand() * 40));
  }

  /** Item to use this frame (and whether to throw it backwards). */
  wantsItem(): { back: boolean } | null {
    if (!this.useItem) return null;
    this.useItem = false;
    return { back: this.useBack };
  }

  input(k: Kart, v: BotView): Input {
    if (k.fall > 0) {
      // Lakitu puts a fallen bot back on the nearest stretch of racing line, facing along it (not on the
      // edge it went over).
      if (!this.rescued) {
        this.rescued = true;
        let best = k.safe, bestD = Infinity;
        for (const p of v.spawns) {
          const d = wrapDX(p.x - k.x) ** 2 + wrapDY(p.y - k.y) ** 2;
          if (d < bestD) { bestD = d; best = p as typeof best; }
        }
        k.safe = { x: best.x, y: best.y, angle: best.angle };
      }
      this.lastPos.frame = v.frame;
      return NO_INPUT;
    }
    this.rescued = false;
    // Every few frames (spread over the bots): where to go, what to do with the item.
    if ((v.frame + this.id) % 8 === 0) this.think(k, v);

    // Stuck against something: back off, turning the other way.
    // (Checked every 1.5 s, counted from the end of the last back-off: a kart needs a moment to get going.)
    if (v.frame < this.reverseUntil) this.lastPos = { x: k.x, y: k.y, frame: v.frame };
    else if (v.frame - this.lastPos.frame >= 90) {
      if (Math.hypot(wrapDX(k.x - this.lastPos.x), wrapDY(k.y - this.lastPos.y)) < 12 && v.frame >= this.reverseUntil && k.air === 0) {
        this.reverseUntil = v.frame + 60;
        // Backing up turns the nose the opposite way to the wheel: steer so it ends up pointing where we want.
        this.reverseSteer = wrap(this.lastAim - k.angle) > 0 ? -1 : 1;
        if (++this.stuckCount >= 2) { this.navUntil = v.frame + 240; this.stuckCount = 0; this.plan = { kind: 'nav' }; }
      } else if (v.frame >= this.reverseUntil) this.stuckCount = 0;
      this.lastPos = { x: k.x, y: k.y, frame: v.frame };
    }
    if (v.frame < this.reverseUntil) {
      return { accel: false, brake: true, left: this.reverseSteer < 0, right: this.reverseSteer > 0, drift: false, item: false };
    }

    let aim: number | null = null;
    if (this.plan.kind === 'race') {
      const c = this.track.world.courses[this.course];
      if (c) {
        this.area = areaAt(c.ai, k.x, k.y, this.area);
        const t = c.path[this.area];
        if (t) aim = heading(k, t);
        if (aim !== null && this.blocked) aim = this.clearHeading(k, aim);
      }
    }
    if (aim === null) {
      const wp = this.plan.kind === 'seek' ? this.plan : v.nav.ahead(k.x, k.y, 8);
      if (!wp) return { ...NO_INPUT, accel: true };
      aim = this.clearHeading(k, heading(k, wp));
    }
    this.lastAim = aim;
    return this.steer(k, wrap(this.avoidObjects(k, aim) - k.angle));
  }

  /**
   * The CPUs' steering: the turn rate builds up and dies down over several frames, so steer toward the rate
   * that closes the gap (game angle units a frame); lift off and power slide through sharp bends.
   */
  private steer(k: Kart, d: number): Input {
    const want = Math.max(-352, Math.min(352, d * 1400));
    const left = k.turnRate > want + 20, right = k.turnRate < want - 20;
    const sharp = Math.abs(d) > 0.9;
    return { accel: !(sharp && k.speed > 2.4), brake: Math.abs(d) > 2.2 && k.speed > 1.5, left, right, drift: Math.abs(d) > 0.5 && (left || right), item: false };
  }

  /** Pipes, plants and pillars within reach (picked every few frames from the whole world's). */
  private obstacles: { x: number; y: number }[] = [];
  private findObstacles(k: Kart) {
    this.obstacles = this.track.objects.filter((o) => (o.kind === 'pipe' || o.kind === 'plant' || o.kind === 'pillar')
      && Math.abs(wrapDX(o.x - k.x)) < 160 && Math.abs(wrapDY(o.y - k.y)) < 160);
  }

  /** Swerve round pipes, plants and pillars just ahead (as the CPUs do). */
  private avoidObjects(k: Kart, aim: number): number {
    const fx = Math.sin(k.angle), fy = -Math.cos(k.angle);
    for (const o of this.obstacles) {
      const ox = wrapDX(o.x - k.x), oy = wrapDY(o.y - k.y);
      const ahead = ox * fx + oy * fy, side = ox * -fy + oy * fx;
      if (ahead > 0 && ahead < 30 + k.speed * 16 && Math.abs(side) < 13) return k.angle + (side > 0 ? -0.5 : 0.5);
    }
    return aim;
  }

  /** The heading closest to `want` that has floor ahead (no wall, no hole) for a while. */
  private clearHeading(k: Kart, want: number): number {
    let best = want, bestClear = -1;
    for (const off of FEELERS) {
      const a = want + off;
      let clear = 0;
      for (let d = 12; d <= 48; d += 12) {
        const t = terrainAt(this.track, k.x + Math.sin(a) * d, k.y - Math.cos(a) * d);
        if (t === 'wall' || t === 'fall') break;
        clear = d;
      }
      if (clear >= 48) return a;
      if (clear > bestClear) { bestClear = clear; best = a; }
    }
    return best;
  }

  /** The course whose racing line passes here (an AI area containing the point), or -1. */
  private courseAt(x: number, y: number): number {
    const w = this.track.world;
    const tx = x / TILE, ty = y / TILE;
    for (let i = 0; i < w.regions.length; i++) {
      const r = w.regions[i];
      if (tx < r.x0 || ty < r.y0 || tx >= r.x0 + 128 || ty >= r.y0 + 128) continue;
      return w.courses[i].ai.some((a) => aiAreaContains(a, x, y)) ? i : -1;
    }
    return -1;
  }

  private think(k: Kart, v: BotView) {
    const dist = (p: { x: number; y: number }) => Math.hypot(wrapDX(p.x - k.x), wrapDY(p.y - k.y));
    this.findObstacles(k);
    if (v.item !== this.heldItem) { this.heldItem = v.item; this.itemSince = v.frame; }

    let near: Rival | null = null, nearD = Infinity;
    for (const r of v.rivals) {
      const d = dist(r);
      if (d < nearD) { nearD = d; near = r; }
    }
    this.decideItem(k, v, near, nearD);

    // Outside the safe area (or the next one, once it's getting small), or time to move on: find the way.
    const margin = 64;
    const outside = !insideZone({ ...v.zone, r: Math.max(0, v.zone.r - margin) }, k.x, k.y)
      || (v.zone.r < 1400 && !insideZone(v.next, k.x, k.y));
    const roam = v.frame >= this.roamAt;
    if (roam && v.frame >= this.roamAt + 60 * 15) this.roamAt = v.frame + 60 * (20 + Math.floor(this.rand() * 40));
    // A rival with a star coming: get out of its way.
    if (near && near.star && nearD < 120) {
      this.plan = { kind: 'seek', x: wrapX(k.x - wrapDX(near.x - k.x) * 2), y: wrapY(k.y - wrapDY(near.y - k.y) * 2) };
      return;
    }
    // Close by and in sight: an item box (no item), or a rival to hit (an item to throw).
    if (!outside) {
      if (!v.item) {
        let box: { x: number; y: number } | null = null, boxD = 200;
        for (const b of v.boxes) {
          if (Math.abs(wrapDX(b.x - k.x)) > 200 || Math.abs(wrapDY(b.y - k.y)) > 200) continue;
          const d = dist(b);
          if (d < boxD && this.ahead(k, b, 1.2) && this.inSight(k, b)) { boxD = d; box = b; }
        }
        if (box) { this.plan = { kind: 'seek', ...box }; return; }
      } else if (near && nearD < 220 && (v.item === 'greenShell' || v.item === 'redShell' || v.item === 'star') && this.inSight(k, near)) {
        this.plan = { kind: 'seek', x: near.x, y: near.y };
        return;
      }
    }
    const here = v.frame < this.navUntil ? -1 : this.courseAt(k.x, k.y);
    // On a course, inside the safe area: race round it (until it's time to roam to the next one).
    if (here >= 0 && !outside && !(roam && v.frame < this.roamAt + 60 * 15)) {
      if (here !== this.course) { this.course = here; this.area = areaAt(this.track.world.courses[here].ai, k.x, k.y, 0); }
      // Stay inside the safe area: if the line heads out of it, find the way instead.
      const t = this.track.world.courses[here].path[this.area];
      if (!t || insideZone(v.zone, t.x, t.y)) {
        this.plan = { kind: 'race' };
        this.blocked = !!t && !this.inSight(k, t);
        return;
      }
    }
    this.plan = { kind: 'nav' };
    // Roaming: aim for a random point a long way off inside the safe area (the map takes us there).
    if (roam && !outside && this.roamGoal === null) {
      const choices = v.spawns.filter((s) => insideZone(v.zone, s.x, s.y) && dist(s) > 900);
      this.roamGoal = choices.length ? choices[Math.floor(this.rand() * choices.length)] : null;
    }
    if (!roam) this.roamGoal = null;
    if (this.roamGoal && !outside) this.plan = { kind: 'seek', ...this.roamGoal };
    if (this.plan.kind === 'seek' && !this.inSight(k, this.plan)) {
      // Too far to see: head there along the map's way as long as the map leads roughly that way.
      this.plan = { kind: 'nav' };
    }
  }
  private roamGoal: { x: number; y: number } | null = null;

  /** Within `cone` radians of straight ahead. */
  private ahead(k: Kart, p: { x: number; y: number }, cone: number): boolean {
    return Math.abs(wrap(heading(k, p) - k.angle)) < cone;
  }

  /** Straight line with floor all the way (sampled). */
  private inSight(k: Kart, p: { x: number; y: number }): boolean {
    const dx = wrapDX(p.x - k.x), dy = wrapDY(p.y - k.y);
    const d = Math.hypot(dx, dy), n = Math.ceil(d / 12);
    for (let i = 1; i < n; i++) {
      const t = terrainAt(this.track, k.x + (dx * i) / n, k.y + (dy * i) / n);
      if (t === 'wall' || t === 'fall') return false;
    }
    return true;
  }

  private decideItem(k: Kart, v: BotView, near: Rival | null, nearD: number) {
    const item = v.item;
    if (!item || this.useItem) return;
    const held = v.frame - this.itemSince;
    if (held < 20 + (1 - this.skill) * 60) return;
    const ahead = near ? Math.abs(wrap(heading(k, near) - k.angle)) : Math.PI;
    const use = (back = false) => { this.useItem = true; this.useBack = back; };
    switch (item) {
      case 'greenShell':
      case 'redShell':
        if (near && nearD < 260 && ahead < 0.22 + this.skill * 0.1) use();
        else if (near && nearD < 110 && ahead > 2.6) use(true);
        else if (held > 60 * 20) use();
        break;
      case 'banana':
        if ((near && nearD < 150 && ahead > 2.3) || held > 60 * 12) use();
        break;
      case 'mushroom':
        if ((near && nearD < 260 && ahead < 0.3) || !insideZone(v.zone, k.x, k.y) || held > 60 * 10) use();
        break;
      case 'star':
        if ((near && nearD < 220) || held > 60 * 15) use();
        break;
      case 'feather':
        if (!insideZone(v.zone, k.x, k.y) || held > 60 * 8) use();
        break;
      default:
        // Boo, lightning, coins: straight away.
        use();
    }
  }
}

/** AI area containing (x, y), searched near `around` first (like aiAreaAt, for a course in the world). */
function areaAt(ai: AiArea[], x: number, y: number, around: number): number {
  const n = ai.length;
  if (!n) return 0;
  for (const off of [0, 1, 2, 3, 4, 5, 6, -1, -2, -3]) {
    const i = (((around + off) % n) + n) % n;
    if (aiAreaContains(ai[i], x, y)) return i;
  }
  for (let i = 0; i < n; i++) if (aiAreaContains(ai[i], x, y)) return i;
  return around;
}
