// Battle Royale rules, shared by the browser (solo) and the server (online): balloons as in Battle Mode
// (3 each, a hit pops one, none left = out), the safe area that closes in over the world, and the last one
// with balloons wins. Nothing here needs the ROM: the zone is worked out from the world's layout alone.

import type { ServerMsg } from './protocol';

export const ROYALE_PLAYERS = 100;
export const ROYALE_BALLOONS = 3;
/** Outside the safe area a balloon pops every few seconds (Lakitu shows his reverse sign meanwhile). */
export const ZONE_POP_MS = 4000;

/**
 * World layout (tiles of 8 px): 6 x 4 course maps of 128 tiles, 24 tiles between them, 12 round. The world
 * wraps round like a little planet: drive off the east edge and you come in from the west, off the south and
 * you come in from the north; the 12 tiles at each edge make, with the other side's, one more 24-tile gap.
 */
export const TILE_PX = 8;
export const COURSE_TILES = 128;
export const GAP_TILES = 24;
export const MARGIN_TILES = 12;
export const GRID_COLS = 6;
export const GRID_ROWS = 4;
export const WORLD_COLS = 2 * MARGIN_TILES + GRID_COLS * COURSE_TILES + (GRID_COLS - 1) * GAP_TILES;
export const WORLD_ROWS = 2 * MARGIN_TILES + GRID_ROWS * COURSE_TILES + (GRID_ROWS - 1) * GAP_TILES;
export const WORLD_W = WORLD_COLS * TILE_PX;
export const WORLD_H = WORLD_ROWS * TILE_PX;

/** Shortest difference between two positions across the world (it wraps round), each way. */
export const wrapDX = (d: number) => d - WORLD_W * Math.round(d / WORLD_W);
export const wrapDY = (d: number) => d - WORLD_H * Math.round(d / WORLD_H);
/** A position brought back into the world (0 <= x < WORLD_W). */
export const wrapX = (x: number) => x - WORLD_W * Math.floor(x / WORLD_W);
export const wrapY = (y: number) => y - WORLD_H * Math.floor(y / WORLD_H);
/** Distance between two points the short way round. (On one course, under half the world: plain distance.) */
export const wrapDist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(wrapDX(bx - ax), wrapDY(by - ay));

/**
 * The world's regions: the courses of one kind of land side by side, with no road between them (their own
 * ground fills the gaps), and Mario Circuit roads only between regions. Courses are indices into COURSE_NAMES
 * (shared/names.ts). The final circles of the safe area keep off the deadly regions (void and lava).
 */
export const WORLD_REGIONS: { name: string; courses: number[]; deadly: boolean }[] = [
  { name: 'Vanilla Lake', courses: [12, 18, 22], deadly: false },
  { name: 'Ghost Valley', courses: [2, 6, 17], deadly: true },
  { name: 'Donut Plains', courses: [1, 7, 15, 20], deadly: false },
  { name: 'Mario Circuit', courses: [0, 4, 9, 14, 23], deadly: false },
  { name: 'Bowser Castle', courses: [3, 8, 13], deadly: true },
  { name: 'Koopa Beach', courses: [10, 16, 21], deadly: false },
  { name: 'Choco Island', courses: [5, 11], deadly: false },
  { name: 'Rainbow Road', courses: [19], deadly: true },
];
/** The course on each cell of the grid, by row (indices into COURSE_NAMES). */
export const WORLD_LAYOUT: number[][] = [
  [12, 18, 22, 2, 6, 17],
  [1, 7, 0, 4, 9, 3],
  [15, 20, 14, 23, 8, 13],
  [10, 16, 21, 5, 11, 19],
];
/** Region (index into WORLD_REGIONS) of a grid cell; -1 outside the grid. */
export function cellRegion(row: number, col: number): number {
  if (row < 0 || col < 0 || row >= GRID_ROWS || col >= GRID_COLS) return -1;
  const course = WORLD_LAYOUT[row][col];
  return WORLD_REGIONS.findIndex((r) => r.courses.includes(course));
}

/**
 * Places the safe area can close on: the middle of each course and of each gap between courses. Safe ones
 * aren't wholly in a deadly region (a gap between a deadly region and another is a road: safe).
 */
export function zoneAnchors(): { x: number; y: number; safe: boolean }[] {
  const out: { x: number; y: number; safe: boolean }[] = [];
  const step = (COURSE_TILES + GAP_TILES) * TILE_PX, m = MARGIN_TILES * TILE_PX, half = (COURSE_TILES * TILE_PX) / 2;
  const safe = (...cells: [number, number][]) => cells.some(([r, c]) => !WORLD_REGIONS[cellRegion(r, c)].deadly);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const x = m + c * step + half, y = m + r * step + half;
      out.push({ x, y, safe: safe([r, c]) });
      // (The gaps after the last column and row are the ones across the world's edge.)
      out.push({ x: wrapX(x + step / 2), y, safe: safe([r, c], [r, (c + 1) % GRID_COLS]) });
      out.push({ x, y: wrapY(y + step / 2), safe: safe([r, c], [(r + 1) % GRID_ROWS, c]) });
    }
  }
  return out;
}

/** The safe area closes in steps: wait, then shrink to the next circle. */
const PHASES: { wait: number; shrink: number; r: number }[] = [
  { wait: 45_000, shrink: 40_000, r: 3000 },
  { wait: 35_000, shrink: 35_000, r: 1800 },
  { wait: 30_000, shrink: 30_000, r: 1000 },
  { wait: 25_000, shrink: 25_000, r: 560 },
  { wait: 20_000, shrink: 20_000, r: 260 },
  { wait: 20_000, shrink: 60_000, r: 0 },
];

export interface Circle { x: number; y: number; r: number }

export interface ZoneNow {
  /** Where the safe area is now (shrinking from `from` to `to`). */
  now: Circle;
  /** The circle it is closing on next. */
  next: Circle;
  /** Phase number, and whether it is shrinking. */
  phase: number;
  shrinking: boolean;
}

/** The whole schedule of circles for a match (same seed = same circles everywhere). */
export function zoneCircles(seed: number): Circle[] {
  const rand = mulberry32(seed);
  const anchors = zoneAnchors();
  // The first covers everything (nowhere is further than half the world each way).
  const first: Circle = { x: WORLD_W / 2, y: WORLD_H / 2, r: Math.hypot(WORLD_W, WORLD_H) / 2 + 64 };
  const circles = [first];
  let prev = first;
  for (const p of PHASES) {
    // The next circle lies wholly inside the current one, centred on a course or a gap; the small ones keep
    // off the void and the lava when they can.
    let fits = anchors.filter((a) => wrapDist(a.x, a.y, prev.x, prev.y) + p.r <= prev.r);
    if (p.r <= 1000 && fits.some((a) => a.safe)) fits = fits.filter((a) => a.safe);
    const pick = fits.length ? fits[Math.floor(rand() * fits.length)] : prev;
    prev = { x: pick.x, y: pick.y, r: p.r };
    circles.push(prev);
  }
  return circles;
}

/** The safe area `ms` after the start; `scale` stretches every wait and shrink (2 = twice as slow). */
export function zoneAt(circles: Circle[], ms: number, scale = 1): ZoneNow {
  let t = Math.max(0, ms) / scale;
  for (let i = 0; i < PHASES.length; i++) {
    const p = PHASES[i], from = circles[i], to = circles[i + 1];
    if (t < p.wait) return { now: from, next: to, phase: i, shrinking: false };
    t -= p.wait;
    if (t < p.shrink) {
      const u = t / p.shrink;
      // Moving the short way round.
      const x = wrapX(from.x + wrapDX(to.x - from.x) * u), y = wrapY(from.y + wrapDY(to.y - from.y) * u);
      return { now: { x, y, r: from.r + (to.r - from.r) * u }, next: to, phase: i, shrinking: true };
    }
    t -= p.shrink;
  }
  const last = circles[circles.length - 1];
  return { now: last, next: last, phase: PHASES.length, shrinking: false };
}

/** Which course (index into COURSE_NAMES, shared/names.ts) is at a world position; -1 on the roads. */
export function worldCourseAt(x: number, y: number): number {
  const step = COURSE_TILES + GAP_TILES;
  const tx = wrapX(x) / TILE_PX - MARGIN_TILES, ty = wrapY(y) / TILE_PX - MARGIN_TILES;
  const c = Math.floor(tx / step), r = Math.floor(ty / step);
  if (c < 0 || r < 0 || c >= GRID_COLS || r >= GRID_ROWS || tx - c * step >= COURSE_TILES || ty - r * step >= COURSE_TILES) return -1;
  return WORLD_LAYOUT[r][c];
}

export function insideZone(z: Circle, x: number, y: number): boolean {
  return wrapDist(x, y, z.x, z.y) <= z.r;
}

type Send = (to: number | 'all', msg: ServerMsg) => void;

/**
 * Balloons, eliminations and the winner. Hits are reported (with the item authority's say-so) through pop();
 * positions come from the karts' state messages, for the safe area.
 */
export class RoyaleAuthority {
  readonly balloons = new Map<number, number>();
  /** Out, in the order they went out. */
  readonly outOrder: number[] = [];
  private pos = new Map<number, { x: number; y: number }>();
  private outsideSince = new Map<number, number>();
  readonly circles: Circle[];
  winner: number | null = null;

  constructor(
    readonly seed: number,
    private startMs: number,
    private send: Send,
    private now: () => number = Date.now,
    /** How slowly the safe area closes (1 = normal; set by the server's administrator). */
    readonly zoneScale = 1,
  ) {
    this.circles = zoneCircles(seed);
  }

  addPlayer(id: number) {
    if (!this.balloons.has(id)) this.balloons.set(id, ROYALE_BALLOONS);
  }

  /** A player who takes over another's kart (a person replacing a bot) carries on with its balloons. */
  rename(from: number, to: number) {
    const n = this.balloons.get(from);
    if (n === undefined) return;
    this.balloons.delete(from);
    this.balloons.set(to, n);
    const p = this.pos.get(from);
    if (p) { this.pos.delete(from); this.pos.set(to, p); }
  }

  removePlayer(id: number) {
    // Leaving counts as going out.
    if ((this.balloons.get(id) ?? 0) > 0) this.knockOut(id);
  }

  alive(): number[] {
    return [...this.balloons].filter(([, n]) => n > 0).map(([id]) => id);
  }

  updatePos(id: number, x: number, y: number) {
    if (Number.isFinite(x) && Number.isFinite(y)) this.pos.set(id, { x, y });
  }

  /** One balloon less (hit by an item, a star, or the safe area). */
  pop(id: number) {
    const n = this.balloons.get(id);
    if (!n || this.winner !== null) return;
    this.balloons.set(id, n - 1);
    this.send('all', { t: 'balloons', id, n: n - 1 });
    if (n - 1 === 0) this.knockOut(id);
  }

  private knockOut(id: number) {
    this.balloons.set(id, 0);
    if (this.outOrder.includes(id)) return;
    this.outOrder.push(id);
    const place = this.alive().length + 1;
    this.send('all', { t: 'royaleOut', id, place });
    this.checkOver();
  }

  private checkOver() {
    if (this.winner !== null) return;
    const alive = this.alive();
    if (alive.length > 1) return;
    this.winner = alive[0] ?? this.outOrder[this.outOrder.length - 1] ?? -1;
    this.send('all', { t: 'royaleOver', winner: this.winner });
  }

  /** Call regularly: the safe area pops balloons of whoever stays outside. */
  tick() {
    if (this.winner !== null) return;
    const now = this.now();
    const zone = zoneAt(this.circles, now - this.startMs, this.zoneScale).now;
    for (const [id, n] of this.balloons) {
      if (n <= 0) continue;
      const p = this.pos.get(id);
      if (!p || insideZone(zone, p.x, p.y)) { this.outsideSince.delete(id); continue; }
      const since = this.outsideSince.get(id);
      if (since === undefined) this.outsideSince.set(id, now);
      else if (now - since >= ZONE_POP_MS) { this.outsideSince.set(id, now); this.pop(id); }
    }
  }
}

/** Small deterministic random generator (the same circles on every client and the server). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
