// Kart physics on the SMK tile genre map, at a fixed 60 Hz like the original.
// Speeds, acceleration tables, turning, hop, mini-turbo and the start boost were measured frame by frame
// in the original game (kart RAM: speed $10EA, heading $102A, slide $10AA, mini-turbo $10CA), per
// character class. The game's speed unit is 1/256 px per frame; here speeds are in px per frame.

import { Genre, MAP_PX, MAP_SIZE, TILE, aiAreaContains, type Track } from '../rom/rom';
import { wrapDX, wrapDY } from '../../shared/royale';
import { OBJECT_HIT_DISTANCE, objectState } from './objects';

export const STEP_MS = 1000 / 60;

export interface Input {
  accel: boolean;
  brake: boolean;
  left: boolean;
  right: boolean;
  /** L / R: hop, and power slide while held in a turn. */
  drift: boolean;
  item?: boolean;
  /** Up on a pad's D-pad (not the keyboard's): up + item throws a banana forward. */
  up?: boolean;
}

/** Game speed units (1/256 px per frame) per px per frame. */
const U = 256;
/** Game angle units (65536 per turn) to radians. */
const ANG = (Math.PI * 2) / 65536;

/**
 * The four kinds of kart (Mario/Luigi, Bowser/DK, Peach/Yoshi, Koopa/Toad), measured in the original.
 * accel: speed gained per frame while accelerating, by speed / 64 (game units).
 */
export interface KartClass {
  accel: number[];
  /** 100cc top speed with no coins (the game's table at ROM 0x18000, per driver), and on dirt / grass / sand. */
  top: number;
  offroad: number;
  /** Turning: rate added per frame and its limit (angle units per frame), normal and power slide. */
  turnAcc: number;
  turnMax: number;
  /** Rate taken off per frame once the pad is let go (the turn unwinds slower than it builds up). */
  turnRelease: number;
  slideAcc: number;
  slideMax: number;
  /**
   * How far the kart body swings out in a fast turn and in a power slide (angle units): where it settles,
   * shaking a step either side every frame as in the original (8352 / 8640, 10240 / 10752).
   */
  skid: number;
  driftSkid: number;
  /** Frames into a fast turn (or a power slide) before the body starts to swing out. */
  skidDelay: number;
  /** With a star: speed gained per frame at 100cc (game units; 0.25 less at 50cc, measured). */
  starAccel: number;
  /** Kart-to-kart bumps: heavier karts push lighter ones. */
  weight: number;
}

export const KART_CLASSES: KartClass[] = [
  { // Mario, Luigi
    accel: [2, 6, 4, 8, 12, 12, 12, 8, 8, 4, 2, 1.5, 1, 0.5, 0.5, 0.5],
    top: 912, offroad: 580, turnAcc: 13, turnMax: 306, turnRelease: 14, slideAcc: 17, slideMax: 352, skid: 8496, driftSkid: 10496, skidDelay: 5, starAccel: 2.25, weight: 2,
  },
  { // Bowser, DK Jr.
    accel: [2, 2, 2, 2, 4, 4, 6, 6, 8, 8, 10, 10, 1, 0.5, 0.5, 0.5],
    top: 944, offroad: 610, turnAcc: 11, turnMax: 288, turnRelease: 17, slideAcc: 15, slideMax: 344, skid: 8496, driftSkid: 10496, skidDelay: 2, starAccel: 2.5, weight: 3,
  },
  { // Peach, Yoshi
    accel: [4, 12, 16, 16, 12, 12, 12, 8, 8, 4, 4, 2, 0.5, 0.25, 0.25, 0.25],
    top: 880, offroad: 620, turnAcc: 11, turnMax: 306, turnRelease: 16, slideAcc: 14, slideMax: 352, skid: 8496, driftSkid: 10496, skidDelay: 2, starAccel: 2.25, weight: 1,
  },
  { // Koopa, Toad
    accel: [4, 4, 6, 8, 8, 12, 12, 8, 8, 4, 2, 1.5, 1, 0.64, 0.5, 0.5],
    top: 864, offroad: 635, turnAcc: 14, turnMax: 288, turnRelease: 18, slideAcc: 18, slideMax: 344, skid: 4464, driftSkid: 10496, skidDelay: 3, starAccel: 2.5, weight: 1,
  },
];

/** Class of each driver, in the game's character order (Mario, Luigi, Bowser, Peach, DK Jr., Koopa, Toad, Yoshi). */
export const CHARACTER_CLASS = [0, 0, 1, 2, 1, 3, 3, 2];

/**
 * Top speed change per engine class: the game's own (code at $C1:F026, HiROM: the driver's table value, -$80 at
 * 50cc, +$A0 at 150cc; the time trial runs at 100cc), and measured so in the original.
 */
export const CC_TOP: Record<50 | 100 | 150, number> = { 50: -128, 100: 0, 150: 160 };
/** Each coin adds this much top speed (not off-road). */
const COIN_TOP = 8;
/** Start boost: accelerate pressed in this window (frames before the green light) shoots the kart off. */
export const START_BOOST_WINDOW = [-129, -122];
const START_BOOST_SPEED = 1200;
/** Mini-turbo: charge needed, frames going straight before it fires, its length and push. */
const MT_CHARGE = 128;
const MT_DELAY = 48;
const MT_FRAMES = 46;
const MT_ACCEL = 2.25;
const HOP_FRAMES = 17;
/**
 * Measured in the original (kart RAM, the item put in the held slot and used): a mushroom pushes the speed up
 * 50 a frame on top of the kart's own acceleration for 33 frames (its timer, 31, and the 2 frames it takes to
 * start), to 2016 at most (Bowser, DK, Peach and Yoshi go up to 100 over it on its last 2 frames: not done
 * here, the rule isn't known); with a star the kart climbs a little each frame to 1312 and drops back 32 each
 * time it passes it (1280-1314, whatever the kart); above top speed it slows down by at most 56
 * a frame; the feather's jump is a 36-frame arc (rising 454 a frame at first, 26 less each frame: 16 px high).
 */
export const DASH_FRAMES = 33;
const DASH_ACCEL = 50;
const DASH_MAX = 2016;
const STAR_TOP = 1312;
const STAR_DROP = 32;
const EXCESS_MAX_DROP = 56;
export const FEATHER_FRAMES = 36;
const FEATHER_RISE = 454;
const FEATHER_FALL = 26;
/** Speed above which a held turn makes the kart body swing out (skid). */
const SKID_SPEED = 600;

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
  /** A shell's hit: the heading it spins round from (6 turns, back to it). */
  spinFrom: number | null;
  /**
   * Spun round by a banana or the lightning (with spinFrom: the way it went, which it keeps going): it slows
   * down while it spins, each its own way (measured).
   */
  slip: '' | 'banana' | 'lightning' | 'star';
  /** Mushroom push frames left (zipper panels still use `boost`). */
  dash: number;
  /** In the air from a feather (its own arc). */
  feather: boolean;
  ghost: number;
  shrink: number;
  /** 0-10; each coin raises top speed a little. */
  coins: number;
  /** Top speed multiplier (CPU skill / rubber banding); 1 for players. */
  speedScale: number;
  /** Index into KART_CLASSES, and the engine class' top speed change (game units). */
  cls: number;
  ccTop: number;
  /** Heading change this frame (game angle units, signed) and the kart body's swing out of it (radians). */
  turnRate: number;
  slide: number;
  /** The body's swing as drawn: last frame's (the original draws the kart a frame behind its swing). */
  shownSlide: number;
  /** Frames into a turn held at speed (the skid starts after a few). */
  turnFrames: number;
  /** Hop (L / R) frames left; whether L / R was down last frame. */
  hop: number;
  driftHeld: boolean;
  /** Mini-turbo: charge, armed (fires once straight), frames straight, frames of push left. */
  mtCharge: number;
  mtArmed: boolean;
  mtStraight: number;
  mtBoost: number;
  /** Countdown: race frame accelerate was pressed (null = not held); then start boost / bad start frames left. */
  startPress: number | null;
  startBoost: boolean;
  badStart: number;
  safe: { x: number; y: number; angle: number };
  safeTimer: number;
  lap: number; // 0 before crossing the start line
  armed: boolean; // has gone far enough around the track to count the next lap
  pathIndex: number;
  progress: number;
}

type Terrain = 'road' | 'slow' | 'wall' | 'fall' | 'boost' | 'oil' | 'ice' | 'jump' | 'bump';

const REVERSE_MAX = -0.8;
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

/** Floor size in tiles (a course is 128 x 128; the Battle Royale world is bigger). */
export const floorCols = (t: Track) => t.world?.cols ?? MAP_SIZE;
export const floorRows = (t: Track) => t.world?.rows ?? MAP_SIZE;

export function terrainAt(track: Track, x: number, y: number): Terrain {
  if (!track.world && (x < 0 || y < 0 || x >= floorCols(track) * TILE || y >= floorRows(track) * TILE)) return 'wall';
  return terrainOf(genreAt(track, x, y));
}

/**
 * Genre of the tile under a position (0 outside a course); the Battle Royale world
 * wraps round (off one edge is the other side).
 */
export function genreAt(track: Track, x: number, y: number): number {
  const cols = floorCols(track), rows = floorRows(track);
  let tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  if (track.world) {
    tx -= cols * Math.floor(tx / cols);
    ty -= rows * Math.floor(ty / rows);
  } else if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return 0;
  return track.genres[ty * cols + tx];
}

/** Brings a kart that drove off the world's edge back in on the other side (Battle Royale). */
function wrapKart(k: Kart, track: Track) {
  if (!track.world) return;
  const w = floorCols(track) * TILE, h = floorRows(track) * TILE;
  k.x -= w * Math.floor(k.x / w);
  k.y -= h * Math.floor(k.y / h);
}

/** Copies tile `src` over tile `dst` (terrain and picture). */
function copyTile(track: Track, dst: number, src: number) {
  track.genres[dst] = track.genres[src];
  if (track.world) { track.world.ids[dst] = track.world.ids[src]; return; }
  const sx = (src % MAP_SIZE) * TILE, sy = Math.floor(src / MAP_SIZE) * TILE;
  const tx = (dst % MAP_SIZE) * TILE, ty = Math.floor(dst / MAP_SIZE) * TILE;
  for (let py = 0; py < TILE; py++) {
    const from = ((sy + py) * MAP_PX + sx) * 4;
    track.pixels.copyWithin(((ty + py) * MAP_PX + tx) * 4, from, from + TILE * 4);
  }
}

/** The nearest drivable tile around tile `i` (up to 4 tiles away) that `ok` accepts, or -1. */
function nearbyFloor(track: Track, i: number, ok: (genre: number) => boolean): number {
  const cols = floorCols(track), rows = floorRows(track);
  const tx = i % cols, ty = Math.floor(i / cols);
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const g = track.genres[y * cols + x];
        const t = terrainOf(g);
        if ((t === 'road' || t === 'slow' || t === 'ice') && ok(g)) return y * cols + x;
      }
    }
  }
  return -1;
}

/** Start grid slot -> position. Slot 0 is pole position. */
export function gridPosition(track: Track, slot: number): { x: number; y: number; angle: number } {
  if (track.start) {
    return { x: track.start.x + (slot % 2) * track.start.secondRowOffset, y: track.start.y + slot * 24, angle: 0 };
  }
  // Battle courses have no GP grid: spread karts around the AI path, each facing along it.
  const n = track.path.length;
  if (n === 0) return { x: 512, y: 512, angle: 0 };
  const i = Math.floor((slot * n) / 8) % n;
  const p = track.path[i], q = track.path[(i + 1) % n];
  return { x: p.x, y: p.y, angle: Math.atan2(q.x - p.x, -(q.y - p.y)) };
}

export function createKart(track: Track, slot: number, character = 0, cc: 50 | 100 | 150 = 100): Kart {
  const g = gridPosition(track, slot);
  const kart: Kart = {
    x: g.x, y: g.y, angle: g.angle, vx: 0, vy: 0, speed: 0, boost: 0, spin: 0, fall: 0, air: 0, airTotal: 0, star: 0, spinFrom: null, slip: '', dash: 0, feather: false, ghost: 0, shrink: 0, coins: 0, speedScale: 1,
    cls: CHARACTER_CLASS[character] ?? 0, ccTop: CC_TOP[cc], turnRate: 0, slide: 0, shownSlide: 0, turnFrames: 0, hop: 0, driftHeld: false,
    mtCharge: 0, mtArmed: false, mtStraight: 0, mtBoost: 0, startPress: null, startBoost: false, badStart: 0,
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
  /** Hit a wall at speed (the bump sound). */
  bump: boolean;
  /** Hop started / the kart came down from a hop or jump (sounds). */
  hop: boolean;
  land: boolean;
  /** Map tiles destroyed this step (Ghost Valley fences, Vanilla Lake ice blocks). */
  broken: number[];
}

const BREAKABLE: number[] = [Genre.FrailBlock, Genre.IceBlock];

/**
 * Breaks the block tiles around (tx, ty) and replaces them with nearby floor.
 * Returns the tile indices, in the order they were replaced (replay them with applyBreak).
 */
function breakBlocks(track: Track, tx: number, ty: number): number[] {
  const cols = floorCols(track), rows = floorRows(track);
  const g = track.genres[ty * cols + tx];
  const tiles: number[] = [];
  const seen = new Set<number>();
  const queue = [[tx, ty]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    const i = y * cols + x;
    if (x < 0 || y < 0 || x >= cols || y >= rows || seen.has(i)) continue;
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
    if (!BREAKABLE.includes(track.genres[i])) continue;
    // Copy the closest drivable tile (genre + picture).
    const src = nearbyFloor(track, i, () => true);
    if (src >= 0) copyTile(track, i, src);
  }
}

/** `frame` = frames since the start signal; drives track object animation. */
/** Another kart to bump into; `w` = its class weight. */
export interface Bumper { x: number; y: number; w?: number }

/**
 * During the countdown: remembers when accelerate went down. At the green light (frame 0) a press in the
 * start-boost window shoots the kart off; holding it from earlier bogs the engine down.
 */
export function countdownInput(k: Kart, input: Input, frame: number) {
  if (!input.accel) { k.startPress = null; return; }
  k.startPress ??= frame;
  if (frame === -1) {
    const [from, to] = START_BOOST_WINDOW;
    if (k.startPress >= from && k.startPress <= to) k.startBoost = true;
    else if (k.startPress < from) k.badStart = 36;
  }
}

/** Mushroom, zipper, mini-turbo or start boost under way (sparks behind the kart). */
export function isBoosting(k: Pick<Kart, 'boost' | 'mtBoost' | 'startBoost'> & { dash?: number }): boolean {
  return (k.dash ?? 0) > 0 || k.boost > 0 || k.mtBoost > 0 || k.startBoost;
}

/** Where the kart body points (heading plus its swing in a skid), for drawing. */
export function kartFacing(k: Pick<Kart, 'angle' | 'slide'> & { shownSlide?: number }): number {
  return k.angle + (k.shownSlide ?? k.slide);
}

export function stepKart(k: Kart, input: Input, track: Track, geo: RaceGeometry, others: Bumper[], frame = 0): StepEvents {
  const events: StepEvents = { lapCompleted: false, bump: false, hop: false, land: false, broken: [] };

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

  const cls = KART_CLASSES[k.cls] ?? KART_CLASSES[0];
  const steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const units = k.speed * U;

  // Hop on pressing L / R (on the ground); holding it through a turn is a power slide.
  const hopPress = input.drift && !k.driftHeld;
  k.driftHeld = input.drift;
  if (hopPress && !airborne && k.hop === 0 && k.spin === 0) { k.hop = HOP_FRAMES; events.hop = true; }
  if (k.hop > 0 && --k.hop === 0) events.land = true;
  const sliding = input.drift && steer !== 0;

  // Steering: the turn rate builds up frame by frame to the class' limit (needs a little speed; mirrored in reverse).
  const grip = Math.min(1, Math.abs(units) / 64) * Math.sign(k.speed || 1);
  if (steer !== 0 && k.spin === 0) {
    const max = sliding ? cls.slideMax : cls.turnMax, acc = sliding ? cls.slideAcc : cls.turnAcc;
    // Turning the other way first unwinds the current turn quickly.
    const step = Math.sign(k.turnRate) === -steer ? acc * 3 : acc;
    k.turnRate += Math.max(-step, Math.min(step, steer * max - k.turnRate));
    k.turnFrames++;
  } else {
    k.turnRate -= Math.sign(k.turnRate) * Math.min(Math.abs(k.turnRate), cls.turnRelease);
    k.turnFrames = 0;
  }
  k.angle += k.turnRate * ANG * grip;
  if (k.spin > 0 && k.spinFrom !== null && k.slip === 'lightning') {
    // Struck by the lightning (measured, a CPU): 4032 a frame and 64 less each frame, then a little back,
    // nearly 2 turns; it ends facing wherever that leaves it.
    const t = ZAP_FRAMES - k.spin;
    k.spin--;
    k.turnRate = 0; k.slide = 0;
    k.angle += (t < 60 ? 4032 - 64 * t : t < 68 ? -192 : t === 68 ? -129 : 0) * ANG;
    if (k.spin === 0) { k.spinFrom = null; k.slip = ''; }
  } else if (k.spin > 0 && k.spinFrom !== null && k.slip === 'banana') {
    // On a banana (measured): 2560 a frame the other way for 77 frames (3 turns and a bit), then still until
    // it ends, facing the way it was.
    const t = SLIP_FRAMES - k.spin;
    k.spin--;
    k.turnRate = 0; k.slide = 0;
    k.angle = t < SLIP_TURN_FRAMES ? k.angle - 2560 * ANG : k.spinFrom - 512 * ANG;
    if (k.spin === 0) { k.angle = k.spinFrom; k.spinFrom = null; k.slip = ''; }
  } else if (k.spin > 0 && k.spinFrom !== null) {
    // Hit by a shell or touched by a star (measured): 4097 a frame for 64 frames (a star's touch 65), then 64 a
    // frame less, then a little back and forth, nearly 6 turns; it drives on facing about the way it was.
    const full = k.slip === 'star' ? 65 : 64, t = full + SHELL_SPIN_FRAMES - 64 - k.spin;
    k.spin--;
    k.angle += (t < full ? 4097 : t < full + 60 ? 4096 - 64 * (t - full + 1) : t < full + 69 ? -192 : t === full + 69 ? -1 : 320) * ANG;
    if (k.spin === 0) { k.spinFrom = null; k.slip = ''; }
  } else if (k.spin > 0) { k.spin--; k.angle += 0.35; }

  // The body swings out in a fast turn (more in a power slide) and swings back when straightened.
  k.shownSlide = k.slide;
  const skidTarget = steer !== 0 && k.spin === 0 && units > SKID_SPEED && k.turnFrames >= cls.skidDelay
    ? steer * (sliding ? cls.driftSkid : cls.skid) * ANG : 0;
  // It moves a step a frame; swung out, it keeps stepping across where it settles (the body shakes), and
  // swinging back it stops straight.
  const swing = (sliding ? 512 : 288) * ANG;
  if (skidTarget === 0) k.slide += Math.max(-swing, Math.min(swing, -k.slide));
  else k.slide += k.slide < skidTarget ? swing : -swing;

  // Mini-turbo: charge with L / R + direction + accelerate; released at 128+, it fires once the kart runs straight.
  if (input.drift && steer !== 0 && input.accel && !airborne) {
    k.mtCharge += k.mtCharge < 20 ? 1 : 2;
  } else if (k.mtCharge > 0) {
    if (k.mtCharge >= MT_CHARGE) { k.mtArmed = true; k.mtStraight = 0; }
    k.mtCharge = 0;
  }
  if (k.mtArmed) {
    if (k.slide === 0 && steer === 0 && !input.drift) k.mtStraight++;
    if (k.mtStraight >= MT_DELAY) { k.mtArmed = false; k.mtBoost = MT_FRAMES; }
  }
  if (k.mtBoost > 0 && (hopPress || k.spin > 0)) k.mtBoost = 0;

  if (airborne) {
    // Ballistic: keep the take-off velocity, ignore walls and holes until landing.
    if (track.world) {
      k.x += k.vx;
      k.y += k.vy;
      wrapKart(k, track);
    } else {
      k.x = Math.min(floorCols(track) * TILE - 1, Math.max(0, k.x + k.vx));
      k.y = Math.min(floorRows(track) * TILE - 1, Math.max(0, k.y + k.vy));
    }
    k.air--;
    // Never land inside a wall: stay up a bit longer.
    if (k.air === 0 && terrainAt(track, k.x, k.y) === 'wall') k.air = 1;
    if (k.air === 0) { events.land = true; k.feather = false; }
    countLaps(k, track, startY, events);
    trackProgress(k, track, geo);
    return events;
  }

  // Throttle, in game units. A hop keeps the surface it started on.
  const surface = k.hop > 0 && k.hop < HOP_FRAMES - 1 ? 'road' : here;
  const offroad = surface === 'slow' && k.star === 0;
  let top = (offroad ? cls.offroad : cls.top + k.ccTop + k.coins * COIN_TOP) * k.speedScale;
  if (k.shrink > 0) top *= 0.6;
  let v = units;
  if (k.badStart > 0) {
    // Accelerate held too early: the engine bogs down for a moment.
    k.badStart--;
    if (input.accel) v += 0.78;
  } else if (k.startBoost) {
    v += 50;
    if (v >= START_BOOST_SPEED) { v = START_BOOST_SPEED; k.startBoost = false; }
  } else if ((k.slip === 'banana' || k.slip === 'lightning') && k.spin > 0) {
    // Slipping on a banana: 8 a frame slower, the accelerator or not; struck by the lightning, 56.
    v = Math.max(0, v - (k.slip === 'lightning' ? ZAP_DECEL : SLIP_DECEL));
  } else if (input.accel && k.spin === 0 && k.star > 0) {
    // A star: on up to its own top speed, whatever the kart's.
    v = v > STAR_TOP ? v - STAR_DROP : v + cls.starAccel + (k.ccTop < 0 ? -0.25 : k.ccTop > 0 ? 0.25 : 0);
  } else if (input.accel && k.spin === 0) {
    if (v < top) v = Math.min(top, v + cls.accel[Math.max(0, Math.min(15, Math.floor(v / 64)))]);
  } else if (input.brake) {
    v = v > 0 ? Math.max(0, v - [4, 7, 9, 12][Math.min(3, Math.floor(v / 256))]) : Math.max(REVERSE_MAX * U, v - 2);
  } else if (v > 0) {
    // (Over 1024, after a mushroom or at 150cc: 16.)
    v = Math.max(0, v - (v >= 1024 ? 16 : 4 + 2 * Math.min(3, Math.floor(v / 256))));
  } else {
    v = Math.min(0, v + 4);
  }
  if (k.mtBoost > 0) { k.mtBoost--; v += MT_ACCEL; }
  // Zipper boosts: pushed up to start-boost speed while they last. A mushroom: its own, bigger push.
  if (k.boost > 0) { k.boost--; v = Math.min(Math.max(v, top) + 50, top + 289); }
  if (k.dash > 0) {
    k.dash--;
    const own = input.accel && v >= top ? cls.accel[Math.max(0, Math.min(15, Math.floor(v / 64)))] : 0;
    v = Math.min(Math.max(v, 0) + DASH_ACCEL + own, DASH_MAX);
  }
  // Above top speed (boosts, a star running out, onto dirt) with the accelerator held: slows down faster the
  // bigger the excess, up to EXCESS_MAX_DROP a frame (let go, only the ordinary slowing down above applies).
  const excess = v - (k.star > 0 && input.accel ? STAR_TOP + STAR_DROP : top);
  if (excess > 0 && input.accel && k.boost === 0 && k.dash === 0 && k.mtBoost === 0 && !k.startBoost) {
    v -= Math.min(excess, EXCESS_MAX_DROP, Math.max(1.75, Math.floor(excess / 64) * 8));
  }
  k.speed = v / U;

  // Velocity follows the heading; on ice it slides. In a skid the kart drifts a little to the outside.
  const traction = surface === 'ice' ? 0.04 : 0.5;
  // (Slipping on a banana: on the way it went, whichever way it faces.)
  const dir = k.slip && k.slip !== 'star' && k.spin > 0 && k.spinFrom !== null ? k.spinFrom : k.angle - k.slide * 0.12;
  const fx = Math.sin(dir), fy = -Math.cos(dir);
  k.vx += (fx * k.speed - k.vx) * traction;
  k.vy += (fy * k.speed - k.vy) * traction;

  // Move with per-axis wall collision so karts slide along walls. Breakable blocks shatter instead.
  const blocked = (x: number, y: number) => {
    if (terrainAt(track, x, y) !== 'wall') return false;
    const cols = floorCols(track), rows = floorRows(track);
    let tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (track.world) { tx -= cols * Math.floor(tx / cols); ty -= rows * Math.floor(ty / rows); }
    if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return true;
    if (!BREAKABLE.includes(track.genres[ty * cols + tx]) || Math.abs(k.speed) < 0.8) return true;
    events.broken.push(...breakBlocks(track, tx, ty));
    k.speed *= 0.5;
    return false;
  };
  const wallHit = () => { if (Math.abs(k.speed) > 0.5) { k.speed *= 0.6; events.bump = true; } };
  // Hitting a wall knocks speed off; pushing against it at a crawl does not (so the kart can still turn away).
  // Fast (a mushroom: up to 8 px a frame) the move is taken in steps of at most 4 px, so it can't jump a wall
  // one tile thick.
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(k.vx), Math.abs(k.vy)) / 4));
  for (let i = 0, hitX = false, hitY = false; i < steps; i++) {
    if (!hitX) {
      const nx = k.x + k.vx / steps;
      if (blocked(nx + Math.sign(k.vx) * KART_RADIUS, k.y)) { hitX = true; k.vx *= -0.5; wallHit(); }
      else k.x = nx;
    }
    if (!hitY) {
      const ny = k.y + k.vy / steps;
      if (blocked(k.x, ny + Math.sign(k.vy) * KART_RADIUS)) { hitY = true; k.vy *= -0.5; wallHit(); }
      else k.y = ny;
    }
  }

  // Bump into other karts: the lighter kart takes most of the push (both sides move, each in its own simulation).
  for (const o of others) {
    const dx = wrapDX(k.x - o.x), dy = wrapDY(k.y - o.y);
    const d = Math.hypot(dx, dy);
    if (d > 0 && d < KART_RADIUS * 2) {
      const mine = cls.weight, theirs = o.w ?? 2;
      const share = theirs / (mine + theirs);
      const push = ((KART_RADIUS * 2 - d) / d) * share * 2;
      if (terrainAt(track, k.x + dx * push, k.y + dy * push) !== 'wall') { k.x += dx * push; k.y += dy * push; }
      k.speed *= 1 - 0.15 * share;
    }
  }

  // Track objects (in the Battle Royale world, only those in the cells round the kart: there are hundreds).
  const objs = track.world ? objectsNear(track, k.x, k.y) : null;
  for (let j = 0, n = objs ? objs.length : track.objects.length; j < n; j++) {
    const i = objs ? objs[j] : j;
    const o = track.objects[i];
    const dx = wrapDX(k.x - o.x), dy = wrapDY(k.y - o.y);
    if (dx > OBJECT_HIT_DISTANCE || dx < -OBJECT_HIT_DISTANCE || dy > OBJECT_HIT_DISTANCE || dy < -OBJECT_HIT_DISTANCE) continue;
    const d = Math.hypot(dx, dy);
    if (d >= OBJECT_HIT_DISTANCE) continue;
    const st = objectState(o.kind, i, frame);
    if (st.harmful && k.spin === 0 && !isInvincible(k)) {
      k.spin = 40; k.spinFrom = null;
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

  wrapKart(k, track);
  const now = terrainAt(track, k.x, k.y);
  if (now === 'fall' && here !== 'fall' && k.speed >= 2) {
    // Driving off an edge at speed carries the kart forward through the air for a moment
    // (lets karts clear the broken bridge on Donut Plains 3); it still drops if there's no ground ahead.
    k.air = k.airTotal = Math.round(k.speed * 6);
  } else if (now === 'fall') {
    k.fall = FALL_FRAMES;
    k.boost = k.dash = k.spin = 0;
  } else if (now === 'boost') {
    k.boost = 45;
    k.mtBoost = 0;
  } else if (now === 'oil' && k.spin === 0 && k.speed > 1) {
    // (Driving onto it at speed: a kart sitting in the oil after a spin can drive off.)
    k.spin = 36; k.spinFrom = null;
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
export function kartHeight(k: Pick<Kart, 'air' | 'airTotal'> & { hop?: number; feather?: boolean }): number {
  if (k.hop && k.air <= 0) return Math.sin((Math.PI * k.hop) / HOP_FRAMES) * 4;
  if (k.air <= 0 || k.airTotal <= 0) return 0;
  if (k.feather) {
    const t = k.airTotal - k.air;
    return Math.max(0, FEATHER_RISE * t - (FEATHER_FALL / 2) * t * (t - 1)) / U;
  }
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

/** The Battle Royale world's objects by 64 px cell (built once per world). */
const OBJECT_CELL = 64;
const objectGrids = new WeakMap<Track['objects'], { cols: number; rows: number; cells: Map<number, number[]> }>();
function objectsNear(track: Track, x: number, y: number): number[] {
  let g = objectGrids.get(track.objects);
  const w = track.world!;
  if (!g) {
    g = { cols: Math.ceil((w.cols * 8) / OBJECT_CELL), rows: Math.ceil((w.rows * 8) / OBJECT_CELL), cells: new Map() };
    track.objects.forEach((o, i) => {
      const key = Math.floor(o.x / OBJECT_CELL) * 4096 + Math.floor(o.y / OBJECT_CELL);
      const list = g!.cells.get(key);
      if (list) list.push(i); else g!.cells.set(key, [i]);
    });
    objectGrids.set(track.objects, g);
  }
  const out: number[] = [];
  const cx = Math.floor(x / OBJECT_CELL), cy = Math.floor(y / OBJECT_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const gx = (((cx + dx) % g.cols) + g.cols) % g.cols, gy = (((cy + dy) % g.rows) + g.rows) % g.rows;
    const list = g.cells.get(gx * 4096 + gy);
    if (list) for (const i of list) out.push(i);
  }
  return out;
}

export function isInvincible(k: Pick<Kart, 'star' | 'ghost'>): boolean {
  return k.star > 0 || k.ghost > 0;
}

/** Spin out (hit by an item or a star kart). */
/** A shell's hit (or a star's touch) spins the kart this long before it drives on (measured in the original). */
export const SHELL_SPIN_FRAMES = 138;

/**
 * A banana: the kart spins round for this long (measured in the original, the same at any speed): it turns for
 * SLIP_TURN_FRAMES, sits still facing nearly the way it was, then drives on.
 */
export const SLIP_FRAMES = 105;
export const SLIP_TURN_FRAMES = 77;
/** Slowing down while slipping on a banana (game units a frame). */
export const SLIP_DECEL = 8;
/** The lightning: the karts it strikes spin this long and slow down this much a frame (measured, CPUs). */
export const ZAP_FRAMES = 70;
export const ZAP_DECEL = 56;

/**
 * Spun round: a shell stops the kart dead for SHELL_SPIN_FRAMES, and a banana spins it while it slides on
 * (SLIP_FRAMES), as in the original; the rest (lightning, a star's touch...) not measured yet.
 */
export function spinOut(k: Kart, shell: boolean | 'banana' | 'lightning' | 'star' = false) {
  if (isInvincible(k) || k.fall > 0) return;
  if (shell === 'banana' || shell === 'lightning') {
    if (k.spin > 0 && k.spinFrom !== null && shell === 'banana') return;
    k.spinFrom = k.spin > 0 && k.spinFrom !== null ? k.spinFrom : k.angle;
    k.spin = shell === 'banana' ? SLIP_FRAMES : ZAP_FRAMES;
    k.slip = shell;
    k.boost = k.dash = k.mtBoost = k.turnRate = 0;
    k.startBoost = false;
    k.mtArmed = false;
    return;
  }
  if (shell) {
    k.spinFrom = k.spin > 0 && k.spinFrom !== null ? k.spinFrom : k.angle;
    k.spin = SHELL_SPIN_FRAMES + (shell === 'star' ? 1 : 0);
    k.slip = shell === 'star' ? 'star' : '';
    k.speed = 0; k.vx = 0; k.vy = 0;
    k.boost = k.dash = k.mtBoost = k.turnRate = 0;
    k.mtArmed = false;
    return;
  }
  k.slip = '';
  k.spinFrom = null;
  k.spin = 50;
  k.speed *= 0.2;
  k.boost = k.dash = k.mtBoost = k.turnRate = 0;
  k.mtArmed = false;
}

/** Feather: a big jump that can clear walls. */
export function featherJump(k: Kart) {
  const v = Math.max(1.8, Math.hypot(k.vx, k.vy));
  k.vx = Math.sin(k.angle) * v;
  k.vy = -Math.cos(k.angle) * v;
  k.air = k.airTotal = FEATHER_FRAMES;
  k.feather = true;
}

export interface SavedTile {
  genre: number;
  /** The tile's picture (a course), or its atlas tile (the Battle Royale world). */
  pixels?: Uint8Array;
  id?: number;
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
    const src = nearbyFloor(track, i, (g) => !pickup(g));
    if (src < 0) continue;
    saved.set(i, saveTile(track, i));
    copyTile(track, i, src);
  }
  return saved;
}

export function restoreTiles(track: Track, saved: Map<number, SavedTile>, tiles: number[]) {
  for (const i of tiles) {
    const s = saved.get(i);
    if (!s) continue;
    track.genres[i] = s.genre;
    if (track.world) track.world.ids[i] = s.id ?? track.world.ids[i];
    else if (s.pixels) {
      const tx = i % MAP_SIZE, ty = Math.floor(i / MAP_SIZE);
      for (let py = 0; py < TILE; py++) {
        track.pixels.set(s.pixels.subarray(py * TILE * 4, (py + 1) * TILE * 4), ((ty * TILE + py) * MAP_PX + tx * TILE) * 4);
      }
    }
    saved.delete(i);
  }
}

function saveTile(track: Track, i: number): SavedTile {
  if (track.world) return { genre: track.genres[i], id: track.world.ids[i] };
  const pixels = new Uint8Array(TILE * TILE * 4);
  const tx = i % MAP_SIZE, ty = Math.floor(i / MAP_SIZE);
  for (let py = 0; py < TILE; py++) {
    const at = ((ty * TILE + py) * MAP_PX + tx * TILE) * 4;
    pixels.set(track.pixels.subarray(at, at + TILE * 4), py * TILE * 4);
  }
  return { genre: track.genres[i], pixels };
}

/** Connected tiles of the given genre around (tx, ty), within `radius` tiles. */
export function tileCluster(track: Track, tx: number, ty: number, genre: number, radius: number): number[] {
  const cols = floorCols(track), rows = floorRows(track);
  const out: number[] = [];
  const seen = new Set<number>();
  const queue = [[tx, ty]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    const i = y * cols + x;
    if (x < 0 || y < 0 || x >= cols || y >= rows || seen.has(i)) continue;
    seen.add(i);
    if (track.genres[i] !== genre || Math.max(Math.abs(x - tx), Math.abs(y - ty)) > radius) continue;
    out.push(i);
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}
