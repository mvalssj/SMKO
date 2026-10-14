// The race HUD and Lakitu, drawn like the original 1P screen (positions, tiles and timings measured from
// the game running in snes9x): timer and lap box on the sky band, coins and place in the race view,
// Lakitu with the start lights, lap signs, the finish flag, the wrong-way sign and the rescue.

import type { SpriteFrame } from '../rom/rom';
import type { Layer } from './layer';

type Rgb = readonly [number, number, number];

/** Screen bands of the 1P race screen (SNES lines). */
export const SKY_TOP = 3;
export const HORIZON = 24;
export const VIEW_BOTTOM = 107;
export const MAP_TOP = 115;
export const MAP_BOTTOM = 219;

/** BG3 HUD colors (set by the game mid-frame, so they're not in the track palette): white, light blue, black. */
const HUD_COLORS: Rgb[] = [[0, 0, 0], [248, 248, 248], [80, 208, 248], [0, 0, 0]];

/** Sprite palettes (0-7) used by the game for these sprites. */
const PAL_LAKITU = 5;
const PAL_HUD = 4;

/** Frames (60 Hz) of the start sequence, relative to the green light. */
const START_APPEARS = -306;
const RED_1 = -130;
const RED_2 = -65;
const LEAVES = 66;

export type LakituShow =
  | { kind: 'start'; t: number }
  | { kind: 'lap'; lap: number; t: number }
  | { kind: 'finish'; t: number }
  | { kind: 'reverse'; t: number }
  | { kind: 'rescue'; t: number; x: number; y: number };

export class RaceHud {
  constructor(private layer: Layer) {}

  // ---------- Timer and lap box (BG3, top right) ----------

  /** Lap box (left) and timer "00'00"00" in the big HUD font, on the sky band. */
  timer(lap: number, ms: number) {
    const L = this.layer, c = HUD_COLORS;
    const x0 = 144, y0 = -1; // map columns 18.. at rows 24-26 (measured: one line up)
    // Lap box: top border, sides, number.
    L.hudTile(0xd0, x0, y0, c); L.hudTile(0xd1, x0 + 8, y0, c); L.hudTile(0xd1, x0 + 16, y0, c); L.hudTile(0xd0, x0 + 24, y0, c, true);
    L.hudTile(0xd2, x0, y0 + 8, c); L.hudTile(0xd2, x0 + 24, y0 + 8, c, true);
    L.hudTile(0xd3, x0, y0 + 16, c); L.hudTile(0xd3, x0 + 24, y0 + 16, c, true);
    this.lapDigit(Math.max(1, Math.min(9, lap)), x0 + 8, y0 + 8);
    // Timer digits: top half 0x80 + d, bottom half 0x90 + d; ' = 0x8A, " = 0x8B.
    const total = Math.min(Math.floor(ms / 10), 99 * 6000 + 5999);
    const m = Math.floor(total / 6000), s = Math.floor(total / 100) % 60, cs = total % 100;
    const glyphs = [Math.floor(m / 10), m % 10, 10, Math.floor(s / 10), s % 10, 11, Math.floor(cs / 10), cs % 10];
    glyphs.forEach((g, i) => {
      const x = x0 + 32 + i * 8;
      L.hudTile(0x80 + g, x, y0 + 8, c);
      if (g < 10) L.hudTile(0x90 + g, x, y0 + 16, c);
    });
  }

  /** Number inside the lap box: the game's own tiles for "1"; other laps use the timer font in the box's colors. */
  private lapDigit(lap: number, x: number, y: number) {
    const L = this.layer;
    if (lap === 1) {
      L.hudTile(0xcc, x, y, HUD_COLORS); L.hudTile(0xcd, x + 8, y, HUD_COLORS);
      L.hudTile(0xea, x, y + 8, HUD_COLORS); L.hudTile(0xeb, x + 8, y + 8, HUD_COLORS);
      return;
    }
    // Black box background, digit in light blue.
    const box: Rgb[] = [[0, 0, 0], [80, 208, 248], [80, 208, 248], [0, 0, 0]];
    L.hudTile(0xcd, x + 8, y, HUD_COLORS); L.hudTile(0xeb, x + 8, y + 8, HUD_COLORS);
    L.hudTile(0xcd, x, y, HUD_COLORS, true); L.hudTile(0xeb, x, y + 8, HUD_COLORS, true);
    L.hudTile(0x80 + lap, x + 4, y, box); L.hudTile(0x90 + lap, x + 4, y + 8, box);
  }

  // ---------- Sprites in the race view ----------

  /** Coins: icon, "x", two digits (small digits: 0-4 = tiles A7-AB, 5-9 = B7-BB). */
  coins(n: number) {
    const L = this.layer, y = 92;
    L.sprite(0x4f, 190, y, PAL_HUD);
    L.sprite(0x4e, 198, y, PAL_HUD);
    const digit = (d: number) => (d < 5 ? 0xa7 + d : 0xb7 + d - 5);
    L.sprite(digit(Math.floor(n / 10) % 10), 206, y, PAL_HUD);
    L.sprite(digit(n % 10), 214, y, PAL_HUD);
  }

  /** Place, big and gray at the right of the race view: the timer font's digit fill, pixel-doubled. */
  place(n: number) {
    if (n < 1 || n > 9) return;
    const L = this.layer;
    const color: Rgb = [208, 212, 208]; // as measured on the original screen
    // 2x wide, 1.5x tall (24 lines), as big as the original number.
    for (let oy = 0; oy < 24; oy++) {
      const y = Math.floor(oy / 1.5), t = (y < 8 ? 0x80 : 0x90) + n;
      for (let x = 0; x < 8; x++) {
        if (L.hudPixel(t, x, y & 7) === 1) L.rect(222 + x * 2, 79 + oy, 2, 1, color);
      }
    }
  }

  /** Held item (HUD icon with its box) at the top center of the sky band. */
  itemIcon(f: SpriteFrame) {
    this.layer.frame(f, 128 - (f.w >> 1) - 8, 4);
  }

  /** A driver's head on the course map (its square backdrop, color 1 joined to the border, left out). */
  head(character: number, x: number, y: number, palette: number) {
    const L = this.layer, t0 = 0x120 + character * 2;
    const ci = (px: number, py: number) => L.tilePixel(t0 + (py >> 3) * 16 + (px >> 3), px & 7, py & 7);
    const backdrop = new Uint8Array(256);
    const stack: number[] = [];
    for (let i = 0; i < 16; i++) stack.push(i, 240 + i, i * 16, i * 16 + 15);
    while (stack.length) {
      const p = stack.pop()!;
      if (backdrop[p]) continue;
      const v = ci(p & 15, p >> 4);
      if (v !== 0 && v !== 1) continue;
      backdrop[p] = 1;
      const px = p & 15, py = p >> 4;
      if (px > 0) stack.push(p - 1);
      if (px < 15) stack.push(p + 1);
      if (py > 0) stack.push(p - 16);
      if (py < 15) stack.push(p + 16);
    }
    const x0 = Math.round(x) - 7, y0 = Math.round(y) - 12;
    for (let p = 0; p < 256; p++) {
      if (backdrop[p]) continue;
      L.rect(x0 + (p & 15), y0 + (p >> 4), 1, 1, L.colors[(8 + palette) * 16 + ci(p & 15, p >> 4)]);
    }
  }

  // ---------- Lakitu ----------

  lakitu(show: LakituShow, frame: number) {
    switch (show.kind) {
      case 'start': return this.startLights(show.t, frame);
      case 'lap': return this.sign(show.t, frame, show.lap >= 5 ? 'final' : show.lap);
      case 'finish': return this.flag(show.t, frame);
      case 'reverse': return this.reverse(show.t, frame);
      case 'rescue': return this.rescue(show);
    }
  }

  /** Whether a show is still on screen. */
  static done(show: LakituShow): boolean {
    switch (show.kind) {
      case 'start': return show.t > 140;
      case 'lap': case 'finish': return show.t > SHOW_FRAMES;
      case 'reverse': return false;
      case 'rescue': return false;
    }
  }

  /** Lakitu on his cloud, facing right with the rod over his shoulder (4 big sprites, mirrored). */
  private body(x: number, y: number, happy = false) {
    const L = this.layer;
    L.sprite(happy ? 0x4a : 0x42, x, y, PAL_LAKITU, true, true);
    L.sprite(0x40, x + 16, y, PAL_LAKITU, true, true);
    L.sprite(happy ? 0x4c : 0x46, x, y + 16, PAL_LAKITU, true, true);
    L.sprite(0x44, x + 16, y + 16, PAL_LAKITU, true, true);
  }

  /** Shadow on the road under Lakitu: grows as he comes down; drawn every other frame (it flickers). */
  private shadow(y: number, frame: number) {
    if (frame & 1) return;
    const L = this.layer;
    if (y < -34) L.sprite(0xed, 44, 90, PAL_LAKITU);
    else if (y < 0) { L.sprite(0xeb, 41, 90, PAL_LAKITU); L.sprite(0xeb, 47, 90, PAL_LAKITU, false, true); }
    else { L.sprite(0xeb, 38, 90, PAL_LAKITU); L.sprite(0xec, 44, 90, PAL_LAKITU); L.sprite(0xeb, 50, 90, PAL_LAKITU, false, true); }
  }

  private startLights(t: number, frame: number) {
    if (t < START_APPEARS) return;
    const y = Math.round(startY(t));
    if (y < -48) return;
    this.body(36, y, t >= 0);
    // Three bulbs hanging from the rod: two reds, then green. Off: FD (red) / FB (green); lit: FE / FC.
    const L = this.layer;
    L.sprite(t >= RED_1 ? 0xfe : 0xfd, 63, y + 16, PAL_HUD);
    L.sprite(t >= RED_2 ? 0xfe : 0xfd, 63, y + 24, PAL_HUD);
    L.sprite(t >= 0 ? 0xfc : 0xfb, 63, y + 32, PAL_HUD);
    this.shadow(y, frame);
  }

  /** Lap 2-4: "LAP n" sign hanging from the rod; lap 5: "FINAL LAP". */
  private sign(t: number, frame: number, lap: number | 'final') {
    const y = Math.round(visitY(t));
    if (y < -64) return;
    this.body(36, y);
    const L = this.layer, sx = 58, sy = y + 18;
    // The sign: rope piece on top, then the text (16 px tall), in Lakitu's palette.
    L.sprite(0x90, sx, sy, PAL_LAKITU); L.sprite(0x91, sx + 8, sy, PAL_LAKITU);
    if (lap === 'final') {
      for (let i = 0; i < 4; i++) { L.sprite(0xac + i, sx + i * 8, sy + 8, PAL_LAKITU); L.sprite(0xbc + i, sx + i * 8, sy + 16, PAL_LAKITU); }
    } else {
      L.sprite(0xa0, sx, sy + 8, PAL_LAKITU); L.sprite(0xa1, sx + 8, sy + 8, PAL_LAKITU);
      L.sprite(0xb0, sx, sy + 16, PAL_LAKITU); L.sprite(0xb1, sx + 8, sy + 16, PAL_LAKITU);
      L.sprite(0xa4 + lap - 2, sx + 16, sy + 8, PAL_LAKITU); L.sprite(0xb4 + lap - 2, sx + 16, sy + 16, PAL_LAKITU);
    }
    this.shadow(y, frame);
  }

  /** Finish: Lakitu waves the checkered flag (two frames). */
  private flag(t: number, frame: number) {
    const y = Math.round(visitY(t));
    if (y < -64) return;
    this.body(36, y, true);
    const L = this.layer, f = (frame >> 3) & 1 ? 0x8c : 0x6c;
    L.sprite(f, 60, y + 4, PAL_LAKITU, true);
    L.sprite(f + 2, 76, y + 4, PAL_LAKITU, true);
    this.shadow(y, frame);
  }

  /** Going the wrong way: Lakitu holds up the yellow "reverse" sign. */
  private reverse(t: number, frame: number) {
    const y = Math.round(Math.min(5, -48 + t * 0.8));
    this.body(36, y);
    const L = this.layer, f = (frame >> 4) & 1 ? 0x88 : 0x68;
    L.sprite(f, 60, y + 8, PAL_LAKITU, true);
    L.sprite(f + 2, 76, y + 8, PAL_LAKITU, true);
    this.shadow(y, frame);
  }

  /** Fishing the kart back onto the track: Lakitu above the kart, lowering it on the line. */
  private rescue(s: Extract<LakituShow, { kind: 'rescue' }>) {
    const L = this.layer;
    const y = Math.round(Math.min(s.y - 44, -48 + s.t * 1.2));
    L.sprite(0x42, s.x - 16, y, PAL_LAKITU, true, true);
    L.sprite(0x40, s.x, y, PAL_LAKITU, true, true);
    L.sprite(0x46, s.x - 16, y + 16, PAL_LAKITU, true, true);
    L.sprite(0x44, s.x, y + 16, PAL_LAKITU, true, true);
  }
}

/** Frames a lap sign / the finish flag stays (down, hold, up). */
const SHOW_FRAMES = 240;

/** Start: comes down at 2/3 px per frame, overshoots to 7, settles at 5, leaves after the green, speeding up. */
export function startY(t: number): number {
  if (t < -243) return -48 + (t - START_APPEARS) * (48 / 63);
  if (t < -216) return (t + 243) * (7 / 27);
  if (t < -195) return 7 - (t + 216) * (2 / 21);
  if (t < LEAVES) return 5;
  const u = t - LEAVES;
  return 5 - 0.4 * u - 0.005 * u * u;
}

/** Lap signs and the flag: same descent and climb, around a hold. */
function visitY(t: number): number {
  if (t < 63) return -48 + t * (53 / 63);
  if (t < SHOW_FRAMES - 70) return 5;
  const u = t - (SHOW_FRAMES - 70);
  return 5 - 0.4 * u - 0.005 * u * u;
}
