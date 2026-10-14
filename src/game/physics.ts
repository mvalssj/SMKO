// Arcade kart physics on the SMK tile genre map. Runs at a fixed 60 Hz like the original.
// Constants are hand-tuned approximations; Phase 4 replaces them with values recovered from the ROM.

import { Genre, MAP_PX, MAP_SIZE, TILE, aiAreaContains, type Track } from '../rom/rom';
import { OBJECT_HIT_DISTANCE, objectState } from './objects';

export const STEP_MS = 1000 / 60;

export interface Input {
  accel: boolean;
  brake: boolean;
  left: boolean;
  right: boolean;
  drift: boolean;
  item?: boolean;
}

export const NO_INPUT: Input = { accel: false, brake: false, left: false, right: false, drift: false, item: false };

export interface Kart {
  x: number;
  y: number;
  angle: number; // 0 = facing up (-y), clockwise positive
  vx: number;
  vy: number;
  speed: number;
  boost: number;
  spin: number;
  fall: number; // frames left of the fall/respawn animation
  air: number; // frames left in the air (jump bars, bumps)
  airTotal: number;
  /** Item effects, in frames left. */
  star: number;
  ghost: number;
  shrink: number;
  /** 0-10; each coin raises top speed a little. */
  coins: number;
  /** Top speed multiplier (CPU skill / rubber banding); 1 for players. */
  speedScale: number;
  safe: { x: number; y: number; angle: number };
  safeTimer: number;
  lap: number; // 0 before crossing the start line
  armed: boolean; // has gone far enough around the track to count the next lap
  pathIndex: number;
  progress: number;
}

type Terrain = 'road' | 'slow' | 'wall' | 'fall' | 'boost' | 'oil' | 'ice' | 'jump' | 'bump';

const MAX_SPEED = 2.6;
const SLOW_MAX = 1.1;
const REVERSE_MAX = -0.8;
const ACCEL = 0.035;
const BRAKE = 0.09;
const COAST = 0.985;
const TURN = 0.04;
const FALL_FRAMES = 70;
const KART_RADIUS = 5;

export function terrainOf(genre: number): Terrain {
  switch (genre) {
    case Genre.SolidBlock:
    case Genre.FrailBlock:
    case Genre.IceBlock:
      return 'wall';
    case Genre.Empty:
    case Genre.Water:
    case Genre.Lava:
    case Genre.OutOfBounds:
    case Genre.EmptyBorder:
      return 'fall';
    case Genre.OffRoad:
    case Genre.Grass:
    case Genre.Sand:
    case Genre.SoftSand:
    case Genre.Snow:
    case Genre.Mud:
    case Genre.RoughClay:
    case Genre.ShallowWater:
    case Genre.WetSand:
      return 'slow';
    case Genre.Zipper:
      return 'boost';
    case Genre.OilSlick:
      return 'oil';
    case Genre.SlipperyRoad:
      return 'ice';
    case Genre.JumpBar:
      return 'jump';
    case Genre.Bump:
    case Genre.BumpEdge:
      return 'bump';
    default:
      return 'road';
  }
}

export function terrainAt(track: Track, x: number, y: number): Terrain {
  if (x < 0 || y < 0 || x >= MAP_PX || y >= MAP_PX) return 'wall';
  return terrainOf(track.genres[Math.floor(y / TILE) * MAP_SIZE + Math.floor(x / TILE)]);
}

/** Start grid slot -> position. Slot 0 is pole position. */
export function gridPosition(track: Track, slot: number): { x: number; y: number; angle: number } {
  if (track.start) {
    return { x: track.start.x + (slot % 2) * track.start.secondRowOffset, y: track.start.y + slot * 24, angle: 0 };
  }
  // Battle courses have no GP grid: spread karts around the AI path.
  const p = track.path[Math.floor((slot * track.path.length) / 8) % track.path.length];
  return { x: p.x, y: p.y, angle: 0 };
}

export function createKart(track: Track, slot: number): Kart {
  const g = gridPosition(track, slot);
  const kart: Kart = {
    x: g.x, y: g.y, angle: g.angle, vx: 0, vy: 0, speed: 0, boost: 0, spin: 0, fall: 0, air: 0, airTotal: 0, star: 0, ghost: 0, shrink: 0, coins: 0, speedScale: 1,
    safe: { ...g }, safeTimer: 0, lap: 0, armed: false, pathIndex: 0, progress: 0,
  };
  kart.pathIndex = aiAreaAt(track, kart.x, kart.y);
  return kart;
}

export interface RaceGeometry {
  /** +1 if the AI path is stored in driving order, -1 if reversed. */
  dir: number;
  /** Path index right after the lap line. */
  lineIndex: number;
}

export function raceGeometry(track: Track): RaceGeometry {
  const n = track.path.length;
  if (!track.start || n < 3) return { dir: 1, lineIndex: 0 };
  // Karts leave the grid driving up (-y); the path neighbour that is further up is "forward".
  const s = aiAreaAt(track, track.start.x, track.start.y);
  const next = track.path[(s + 1) % n];
  const prev = track.path[(s - 1 + n) % n];
  const dir = next.y < prev.y ? 1 : -1;
  const line = track.lapLine!;
  const lineIndex = aiAreaAt(track, line.x + line.length / 2, line.y - 4);
  return { dir, lineIndex };
}

/**
 * Index of the AI area containing (x, y). Searches near `around` first (areas can overlap where
 * the track crosses itself), then everywhere; falls back to `around` or the nearest target.
 */
export function aiAreaAt(track: Track, x: number, y: number, around?: number): number {
  const n = track.ai.length;
  if (around !== undefined) {
    for (const off of [0, 1, 2, 3, 4, 5, 6, -1, -2, -3]) {
      const i = (((around + off) % n) + n) % n;
      if (aiAreaContains(track.ai[i], x, y)) return i;
    }
  }
  for (let i = 0; i < n; i++) if (aiAreaContains(track.ai[i], x, y)) return i;
  if (around !== undefined) return around;
  let best = 0, bestD = Infinity;
  track.path.forEach((p, i) => {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

export interface StepEvents {
  lapCompleted: boolean;
  /** Map tiles destroyed this step (Ghost Valley fences, Vanilla Lake ice blocks). */
  broken: number[];
}

const BREAKABLE: number[] = [Genre.FrailBlock, Genre.IceBlock];

/**
 * Breaks the block tiles around (tx, ty) and replaces them with nearby floor.
 * Returns the tile indices, in the order they were replaced (replay them with applyBreak).
 */
function breakBlocks(track: Track, tx: number, ty: number): number[] {
  const g = track.genres[ty * MAP_SIZE + tx];
  const tiles: number[] = [];
  const seen = new Set<number>();
  const queue = [[tx, ty]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    const i = y * MAP_SIZE + x;
    if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE || seen.has(i)) continue;
    seen.add(i);
    if (track.genres[i] !== g || Math.max(Math.abs(x - tx), Math.abs(y - ty)) > 1) continue;
    tiles.push(i);
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  applyBreak(track, tiles);
  return tiles;
}

export function applyBreak(track: Track, tiles: number[]) {
  for (const i of tiles) {
    const tx = i % MAP_SIZE, ty = Math.floor(i / MAP_SIZE);
    if (!BREAKABLE.includes(track.genres[i])) continue;
    // Copy the closest drivable tile (genre + pixels).
    let src = -1;
    for (let r = 1; r <= 4 && src < 0; r++) {
      for (let dy = -r; dy <= r && src < 0; dy++) {
        for (let dx = -r; dx <= r && src < 0; dx++) {
          const x = tx + dx, y = ty + dy;
          if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) continue;
          const t = terrainOf(track.genres[y * MAP_SIZE + x]);
          if (t === 'road' || t === 'slow' || t === 'ice') src = y * MAP_SIZE + x;
        }
      }
    }
    if (src < 0) continue;
    track.genres[i] = track.genres[src];
    const sx = (src % MAP_SIZE) * TILE, sy = Math.floor(src / MAP_SIZE) * TILE;
    for (let py = 0; py < TILE; py++) {
      const from = ((sy + py) * MAP_PX + sx) * 4;
      track.pixels.copyWithin(((ty * TILE + py) * MAP_PX + tx * TILE) * 4, from, from + TILE * 4);
    }
  }
}

/** `frame` = frames since the start signal; drives track object animation. */
export function stepKart(k: Kart, input: Input, track: Track, geo: RaceGeometry, others: { x: number; y: number }[], frame = 0): StepEvents {
  const events: StepEvents = { lapCompleted: false, broken: [] };

  if (k.star > 0) k.star--;
  if (k.ghost > 0) k.ghost--;
  if (k.shrink > 0) k.shrink--;

  if (k.fall > 0) {
    k.fall--;
    if (k.fall === 0) {
      k.x = k.safe.x; k.y = k.safe.y; k.angle = k.safe.angle;
      k.vx = k.vy = k.speed = 0;
    }
    return events;
  }

  const startY = k.y;
  const airborne = k.air > 0;
  const here = airborne ? 'road' : terrainAt(track, k.x, k.y);

  // Steering. Turning needs some speed, and is mirrored when reversing. Little control in the air.
  const steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const grip = Math.min(1, Math.abs(k.speed) / 0.8) * Math.sign(k.speed || 1);
  k.angle += steer * TURN * (input.drift ? 1.5 : 1) * grip * (airborne ? 0.3 : 1);
  if (k.spin > 0) { k.spin--; k.angle += 0.35; }

  if (airborne) {
    // Ballistic: keep the take-off velocity, ignore walls and holes until landing.
    k.x = Math.min(MAP_PX - 1, Math.max(0, k.x + k.vx));
    k.y = Math.min(MAP_PX - 1, Math.max(0, k.y + k.vy));
    k.air--;
    // Never land inside a wall: stay up a bit longer.
    if (k.air === 0 && terrainAt(track, k.x, k.y) === 'wall') k.air = 1;
    countLaps(k, track, startY, events);
    trackProgress(k, track, geo);
    return events;
  }

  // Throttle.
  // A star keeps full speed off-road; being shrunk by lightning slows you down.
  let top = k.boost > 0 ? MAX_SPEED * 1.5 : here === 'slow' && k.star === 0 ? SLOW_MAX : MAX_SPEED;
  top *= k.speedScale * (1 + k.coins * 0.01) * (k.star > 0 ? 1.15 : 1) * (k.shrink > 0 ? 0.6 : 1);
  if (input.accel && k.spin === 0) k.speed += ACCEL * (1 - Math.max(0, k.speed) / (top * 1.15));
  else if (input.brake) k.speed = Math.max(REVERSE_MAX, k.speed - BRAKE);
  else k.speed *= COAST;
  if (k.speed > top) k.speed = Math.max(top, k.speed - 0.06);
  if (input.drift) k.speed *= 0.997;
  if (k.boost > 0) { k.boost--; k.speed = Math.max(k.speed, MAX_SPEED * 1.4); }

  // Velocity follows the heading; lower grip = more sliding.
  const traction = here === 'ice' ? 0.04 : input.drift ? 0.09 : 0.22;
  const fx = Math.sin(k.angle), fy = -Math.cos(k.angle);
  k.vx += (fx * k.speed - k.vx) * traction;
  k.vy += (fy * k.speed - k.vy) * traction;

  // Move with per-axis wall collision so karts slide along walls. Breakable blocks shatter instead.
  const blocked = (x: number, y: number) => {
    if (terrainAt(track, x, y) !== 'wall') return false;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (!BREAKABLE.includes(track.genres[ty * MAP_SIZE + tx]) || Math.abs(k.speed) < 0.8) return true;
    events.broken.push(...breakBlocks(track, tx, ty));
    k.speed *= 0.5;
    return false;
  };
  const nx = k.x + k.vx;
  if (blocked(nx + Math.sign(k.vx) * KART_RADIUS, k.y)) { k.vx *= -0.5; k.speed *= 0.6; }
  else k.x = nx;
  const ny = k.y + k.vy;
  if (blocked(k.x, ny + Math.sign(k.vy) * KART_RADIUS)) { k.vy *= -0.5; k.speed *= 0.6; }
  else k.y = ny;

  // Bump into other karts.
  for (const o of others) {
    const dx = k.x - o.x, dy = k.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d > 0 && d < KART_RADIUS * 2) {
      const push = (KART_RADIUS * 2 - d) / d;
      if (terrainAt(track, k.x + dx * push, k.y + dy * push) !== 'wall') { k.x += dx * push; k.y += dy * push; }
      k.speed *= 0.9;
    }
  }

  // Track objects.
  for (let i = 0; i < track.objects.length; i++) {
    const o = track.objects[i];
    const dx = k.x - o.x, dy = k.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d >= OBJECT_HIT_DISTANCE) continue;
    const st = objectState(o.kind, i, frame);
    if (st.harmful && k.spin === 0 && !isInvincible(k)) {
      k.spin = 40;
      k.speed *= 0.3;
    }
    if (st.solid && d > 0) {
      // Push out of the object and bounce back.
      const push = (OBJECT_HIT_DISTANCE - d) / d;
      k.x += dx * push;
      k.y += dy * push;
      k.vx = (dx / d) * Math.abs(k.speed) * 0.5;
      k.vy = (dy / d) * Math.abs(k.speed) * 0.5;
      k.speed *= 0.4;
    }
  }

  const now = terrainAt(track, k.x, k.y);
  if (now === 'fall' && here !== 'fall' && k.speed >= 2) {
    // Driving off an edge at speed carries the kart forward through the air for a moment
    // (lets karts clear the broken bridge on Donut Plains 3); it still drops if there's no ground ahead.
    k.air = k.airTotal = Math.round(k.speed * 6);
  } else if (now === 'fall') {
    k.fall = FALL_FRAMES;
    k.boost = k.spin = 0;
  } else if (now === 'boost') {
    k.boost = 45;
  } else if (now === 'oil' && k.spin === 0) {
    k.spin = 36;
  } else if (now === 'jump' && k.speed > 0.3) {
    // Jump bars launch the kart over gaps and walls (Bowser Castle lava, Mario Circuit 2 wall).
    const v = Math.max(1.8, Math.hypot(k.vx, k.vy));
    k.vx = Math.sin(k.angle) * v;
    k.vy = -Math.cos(k.angle) * v;
    k.air = k.airTotal = 34;
  } else if (now === 'bump' && k.speed > 1) {
    k.air = k.airTotal = 8;
  }
  if (now === 'road' || now === 'slow') {
    if (++k.safeTimer > 20) {
      k.safe = { x: k.x, y: k.y, angle: k.angle };
      k.safeTimer = 0;
    }
  }

  countLaps(k, track, startY, events);
  trackProgress(k, track, geo);
  return events;
}

/** Height above the floor in world pixels, for drawing jumps. */
export function kartHeight(k: Pick<Kart, 'air' | 'airTotal'>): number {
  if (k.air <= 0 || k.airTotal <= 0) return 0;
  return Math.sin(Math.PI * (1 - k.air / k.airTotal)) * (k.airTotal > 10 ? 14 : 3);
}

function countLaps(k: Kart, track: Track, prevY: number, events: StepEvents) {
  // The lap line is horizontal; crossing it going up counts.
  const line = track.lapLine;
  if (line && k.x >= line.x && k.x <= line.x + line.length) {
    if (prevY > line.y && k.y <= line.y) {
      if (k.lap === 0 || k.armed) {
        k.lap++;
        k.armed = false;
        events.lapCompleted = k.lap > 1;
      }
    } else if (prevY <= line.y && k.y > line.y && k.lap > 0) {
      // Crossed backwards: undo, so driving back and forth over the line never counts.
      k.lap--;
      k.armed = true;
    }
  }
}

function trackProgress(k: Kart, track: Track, geo: RaceGeometry) {
  const n = track.path.length;
  if (n > 0) {
    k.pathIndex = aiAreaAt(track, k.x, k.y, k.pathIndex);
    const rel = (((k.pathIndex - geo.lineIndex) * geo.dir) % n + n) % n;
    if (rel > n / 2 && rel < n - 2) k.armed = true;
    // Before the first crossing everyone is "behind the line".
    k.progress = k.lap === 0 ? rel - n : (k.lap - 1) * n + rel;
  }
}

export function isInvincible(k: Pick<Kart, 'star' | 'ghost'>): boolean {
  return k.star > 0 || k.ghost > 0;
}

/** Spin out (hit by an item or a star kart). */
export function spinOut(k: Kart) {
  if (isInvincible(k) || k.fall > 0) return;
  k.spin = 50;
  k.speed *= 0.2;
  k.boost = 0;
}

/** Feather: a big jump that can clear walls. */
export function featherJump(k: Kart) {
  const v = Math.max(1.8, Math.hypot(k.vx, k.vy));
  k.vx = Math.sin(k.angle) * v;
  k.vy = -Math.cos(k.angle) * v;
  k.air = k.airTotal = 46;
}

export interface SavedTile {
  genre: number;
  pixels: Uint8Array;
}

/**
 * Covers item box / coin tiles with the nearest plain floor (genre + pixels) and returns the originals,
 * so a used box can come back later with restoreTiles.
 */
export function coverTiles(track: Track, tiles: number[]): Map<number, SavedTile> {
  const saved = new Map<number, SavedTile>();
  const pickup = (g: number) => g === Genre.ItemBlock || g === Genre.Coin;
  for (const i of tiles) {
    if (!pickup(track.genres[i])) continue;
    const tx = i % MAP_SIZE, ty = Math.floor(i / MAP_SIZE);
    let src = -1;
    for (let r = 1; r <= 4 && src < 0; r++) {
      for (let dy = -r; dy <= r && src < 0; dy++) {
        for (let dx = -r; dx <= r && src < 0; dx++) {
          const x = tx + dx, y = ty + dy;
          if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) continue;
          const g = track.genres[y * MAP_SIZE + x];
          const t = terrainOf(g);
          if ((t === 'road' || t === 'slow' || t === 'ice') && !pickup(g)) src = y * MAP_SIZE + x;
        }
      }
    }
    if (src < 0) continue;
    const pixels = new Uint8Array(TILE * TILE * 4);
    const sx = (src % MAP_SIZE) * TILE, sy = Math.floor(src / MAP_SIZE) * TILE;
    for (let py = 0; py < TILE; py++) {
      const dst = ((ty * TILE + py) * MAP_PX + tx * TILE) * 4;
      pixels.set(track.pixels.subarray(dst, dst + TILE * 4), py * TILE * 4);
      const from = ((sy + py) * MAP_PX + sx) * 4;
      track.pixels.copyWithin(dst, from, from + TILE * 4);
    }
    saved.set(i, { genre: track.genres[i], pixels });
    track.genres[i] = track.genres[src];
  }
  return saved;
}

export function restoreTiles(track: Track, saved: Map<number, SavedTile>, tiles: number[]) {
  for (const i of tiles) {
    const s = saved.get(i);
    if (!s) continue;
    track.genres[i] = s.genre;
    const tx = i % MAP_SIZE, ty = Math.floor(i / MAP_SIZE);
    for (let py = 0; py < TILE; py++) {
      track.pixels.set(s.pixels.subarray(py * TILE * 4, (py + 1) * TILE * 4), ((ty * TILE + py) * MAP_PX + tx * TILE) * 4);
    }
    saved.delete(i);
  }
}

/** Connected tiles of the given genre around (tx, ty), within `radius` tiles. */
export function tileCluster(track: Track, tx: number, ty: number, genre: number, radius: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const queue = [[tx, ty]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    const i = y * MAP_SIZE + x;
    if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE || seen.has(i)) continue;
    seen.add(i);
    if (track.genres[i] !== genre || Math.max(Math.abs(x - tx), Math.abs(y - ty)) > radius) continue;
    out.push(i);
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}
