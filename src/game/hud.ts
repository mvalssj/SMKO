// The race HUD and Lakitu, drawn like the original 1P screen (positions, tiles and timings measured from
// the game running in snes9x): timer and lap box on the sky band, coins and place in the race view,
// Lakitu with the start lights, lap signs, the finish flag, the wrong-way sign and the rescue.

import type { SpriteFrame } from '../rom/rom';
import type { RaceGfx } from '../rom/race-gfx';
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

/** Menu font colors of the lap time list: white, lavender shade, black outline. */
const FONT_COLORS: Rgb[] = [[0, 0, 0], [248, 252, 248], [168, 168, 224], [0, 0, 0]];
/** Menu font tiles: digits 0x00-0x09, ' and ", dash, and the pre-drawn "LAP TIME" / "TOTAL" pieces. */
const F_MINUTE = 0x28;
const F_SECOND = 0x29;
const F_DASH = 0x9c;
const F_RULE = 0x9e;

/** What the big place number shows this frame (drawn by the renderer: it adds a color to the picture). */
export interface PlaceShow {
  n: number;
  add: Rgb;
}

/** Colors added to the picture inside the place number: red while racing, then a rainbow for a podium finish. */
export const PLACE_RED: Rgb = [144, 0, 0];
const PLACE_RAINBOW: Rgb[] = [[144, 0, 0], [144, 148, 0], [0, 148, 0], [0, 148, 144], [0, 0, 144], [144, 0, 144]];
export function placeRainbow(frame: number): Rgb {
  return PLACE_RAINBOW[Math.floor(frame / 4) % PLACE_RAINBOW.length];
}

export class RaceHud {
  /** Set by place(); the renderer draws it. */
  placeShow: PlaceShow | null = null;

  constructor(private layer: Layer, readonly gfx: RaceGfx | null = null) {}

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

  /** Place: the big italic number at the right of the race view (a color added to the picture). */
  place(n: number, add: Rgb = PLACE_RED) {
    if (n < 1 || n > 8) return;
    this.placeShow = { n, add };
  }

  /** Lives left in the Grand Prix: kart icon, "x", digit (above the coins). */
  lives(n: number) {
    const L = this.layer, y = 84;
    const digit = (d: number) => (d < 5 ? 0xa7 + d : 0xb7 + d - 5);
    L.sprite(0x5e, 182, y, PAL_HUD);
    L.sprite(0x5f, 190, y, PAL_HUD);
    L.sprite(0x4e, 198, y, PAL_HUD);
    L.sprite(digit(Math.max(0, Math.min(9, n))), 206, y, PAL_HUD);
  }

  /** Battle Royale: drivers still in (kart icon, "x", up to three digits), where a GP shows the lives. */
  alive(n: number) {
    const L = this.layer, y = 84;
    const digit = (d: number) => (d < 5 ? 0xa7 + d : 0xb7 + d - 5);
    const text = String(Math.max(0, Math.min(999, n)));
    const x = 214 - (text.length - 1) * 8;
    L.sprite(0x5e, x - 24, y, PAL_HUD);
    L.sprite(0x5f, x - 16, y, PAL_HUD);
    L.sprite(0x4e, x - 8, y, PAL_HUD);
    [...text].forEach((ch, i) => L.sprite(digit(+ch), x + i * 8, y, PAL_HUD));
  }

  /** A line in the race's menu font (digits and A-Z) on a black strip, centred on x. */
  text(str: string, cx: number, y: number) {
    const font = this.gfx?.font;
    if (!font) return;
    const L = this.layer, w = str.length * 8, x0 = Math.round(cx - w / 2);
    L.rect(x0 - 4, y - 2, w + 8, 12, [0, 0, 0]);
    [...str].forEach((ch, i) => {
      const c = ch.charCodeAt(0);
      const t = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 90 ? 0x0a + c - 65 : -1;
      if (t >= 0) L.fontTile(font, t, x0 + i * 8, y, FONT_COLORS);
    });
  }

  /** After the finish: each lap's time and the total, in the menu font, over the race view. */
  lapTimes(laps: (number | null)[], totalMs: number) {
    const font = this.gfx?.font;
    if (!font) return;
    const L = this.layer, c = FONT_COLORS;
    // Header: "LAP TIME" in its pre-drawn white-on-black tiles, in a black box.
    L.rect(100, 21, 64, 8, [0, 0, 0]);
    for (let i = 0; i < 5; i++) L.fontTile(font, 0x30 + i, 108 + i * 8, 21, c);
    L.fontTile(font, 0x35, 148, 21, c, 7);
    const time = (x: number, y: number, ms: number | null) => {
      const t = ms === null ? null : Math.min(Math.floor(ms / 10), 9 * 6000 + 5999);
      const sec = t === null ? 0 : Math.floor(t / 100) % 60;
      const d = t === null ? null : [Math.floor(t / 6000), Math.floor(sec / 10), sec % 10, Math.floor((t % 100) / 10), t % 10];
      const glyphs = d ? [d[0], F_MINUTE, d[1], d[2], F_SECOND, d[3], d[4]] : [F_DASH, F_MINUTE, F_DASH, F_DASH, F_SECOND, F_DASH, F_DASH];
      [0, 8, 16, 24, 32, 40, 48].forEach((dx, i) => L.fontTile(font, glyphs[i], x + dx, y, c));
    };
    laps.slice(0, 5).forEach((ms, i) => {
      const y = 37 + i * 9;
      L.fontTile(font, 0x15, 88, y, c); // L
      L.fontTile(font, 1 + i, 96, y, c);
      time(112, y, ms);
    });
    for (let x = 80; x < 176; x += 8) L.fontTile(font, F_RULE, x, 80, c);
    for (let i = 0; i < 3; i++) L.fontTile(font, 0xa0 + i, 80 + i * 8, 89, c);
    time(112, 89, totalMs);
  }

  /** Left edge after the finish: who finished in which place (box with the place, driver's head). */
  finishOrder(rows: { place: number; character: number; palette: number }[], frame = 0) {
    const L = this.layer;
    // Measured: the box cycles sprite palettes 1, 1, 1, 1, 5, 5, 6, 6 (teal, red, orange), one per frame;
    // the head switches pose every 8 frames.
    const boxPal = [1, 1, 1, 1, 5, 5, 6, 6][((frame % 8) + 8) % 8];
    const pose = Math.floor(frame / 8) % 2;
    rows.slice(0, 4).forEach((r, i) => {
      const y = 39 + i * 17;
      L.sprite(0x1c0 + r.place - 1, 8, y, boxPal);
      L.sprite(0x1d0 + r.place - 1, 8, y + 8, boxPal);
      L.sprite((pose ? 0x1e0 : 0x120) + r.character * 2, 16, y, r.palette, true);
    });
  }

  /** Held item (HUD icon with its box) at the top center of the sky band. */
  itemIcon(f: SpriteFrame) {
    this.layer.frame(f, 128 - (f.w >> 1) - 8, 4);
  }

  /**
   * A driver's head on the course map (its square backdrop, color 1 joined to the border, left out).
   * `small`: half size (Battle Royale's map of the whole world, where everyone else is).
   */
  head(character: number, x: number, y: number, palette: number, small = false) {
    const L = this.layer;
    const px = this.headPixels(character, small);
    const size = small ? 8 : 16;
    const x0 = Math.round(x) - (small ? 3 : 7), y0 = Math.round(y) - (small ? 6 : 12);
    const base = (8 + palette) * 16;
    for (let p = 0; p < px.length; p++) {
      if (px[p] >= 0) L.rect(x0 + (p % size), y0 + Math.floor(p / size), 1, 1, L.colors[base + px[p]]);
    }
  }

  private heads = new Map<number, Int8Array>();
  /** A head's color indices (-1 = left out), worked out once per driver and size. */
  private headPixels(character: number, small: boolean): Int8Array {
    const key = character * 2 + (small ? 1 : 0);
    let out = this.heads.get(key);
    if (out) return out;
    const full = this.headMask(character);
    if (!small) out = full;
    else {
      // Half size: each 2x2 block becomes its most common color, if at least half of it is drawn.
      out = new Int8Array(64).fill(-1);
      for (let p = 0; p < 64; p++) {
        const bx = (p & 7) * 2, by = (p >> 3) * 2;
        const block = [full[by * 16 + bx], full[by * 16 + bx + 1], full[(by + 1) * 16 + bx], full[(by + 1) * 16 + bx + 1]].filter((c) => c >= 0);
        if (block.length < 2) continue;
        out[p] = block.reduce((best, c) => (block.filter((d) => d === c).length > block.filter((d) => d === best).length ? c : best), block[0]);
      }
    }
    this.heads.set(key, out);
    return out;
  }

  private headMask(character: number): Int8Array {
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
    const out = new Int8Array(256);
    for (let p = 0; p < 256; p++) out[p] = backdrop[p] ? -1 : ci(p & 15, p >> 4);
    return out;
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
      case 'lap': return show.t > SIGN_FRAMES;
      case 'finish': return show.t > FLAG_FRAMES;
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
  private shadow(y: number, frame: number, x = 36) {
    if (frame & 1) return;
    const L = this.layer;
    if (y < -34) L.sprite(0xed, x + 8, 90, PAL_LAKITU);
    else if (y < 0) { L.sprite(0xeb, x + 5, 90, PAL_LAKITU); L.sprite(0xeb, x + 11, 90, PAL_LAKITU, false, true); }
    else { L.sprite(0xeb, x + 2, 90, PAL_LAKITU); L.sprite(0xec, x + 8, 90, PAL_LAKITU); L.sprite(0xeb, x + 14, 90, PAL_LAKITU, false, true); }
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
  /**
   * Lap 2-4: Lakitu holds up "LAP n" (lap 5: "FINAL LAP") in front of his face, swooping down from the top
   * left and back (measured in the original: the sign replaces his head row, the cloud stays below it).
   */
  private sign(t: number, frame: number, lap: number | 'final') {
    if (t < 0 || t > SIGN_FRAMES) return;
    const k = t / 3, i = Math.min(SIGN_PATH.length - 2, Math.floor(k)), u = k - i;
    const x = Math.round(SIGN_PATH[i][0] + (SIGN_PATH[i + 1][0] - SIGN_PATH[i][0]) * u);
    const y = Math.round(SIGN_PATH[i][1] + (SIGN_PATH[i + 1][1] - SIGN_PATH[i][1]) * u);
    const L = this.layer;
    L.sprite(0x46, x, y, PAL_LAKITU, true, true);
    L.sprite(0x44, x + 16, y, PAL_LAKITU, true, true);
    if (lap === 'final') {
      // The first sprite in OAM wins where they overlap: draw it last.
      L.sprite(0xae, x + 8, y - 16, PAL_LAKITU, true);
      L.sprite(0xac, x - 8, y - 16, PAL_LAKITU, true);
    } else {
      L.sprite(0xa3 + lap - 2, x + 7, y - 16, PAL_LAKITU, true);
      L.sprite(0xa0, x - 1, y - 16, PAL_LAKITU, true);
    }
    this.shadow(y - 16, frame, x);
  }

  /**
   * Finish: Lakitu swoops down from the top left, across the view and back up, waving the checkered flag
   * (path and poses measured frame by frame in the original: no flag, flag up, down, up, down, up...).
   */
  private flag(t: number, frame: number) {
    if (t < 0 || t > FLAG_FRAMES) return;
    const k = t / 6, i = Math.min(FLAG_PATH.length - 2, Math.floor(k)), u = k - i;
    const x = Math.round(FLAG_PATH[i][0] + (FLAG_PATH[i + 1][0] - FLAG_PATH[i][0]) * u);
    const y = Math.round(FLAG_PATH[i][1] + (FLAG_PATH[i + 1][1] - FLAG_PATH[i][1]) * u);
    const pose = FLAG_POSES[Math.floor(t / FLAG_POSE_FRAMES) % FLAG_POSES.length];
    const L = this.layer;
    L.sprite(0x4a, x, y, PAL_LAKITU, true, true);
    L.sprite([0x80, 0x6e, 0x8e][pose], x + 16, y, PAL_LAKITU, true, true);
    L.sprite(0x4c, x, y + 16, PAL_LAKITU, true, true);
    L.sprite(pose ? 0x44 : 0x82, x + 16, y + 16, PAL_LAKITU, true, true);
    if (pose) L.sprite(pose === 1 ? 0x6c : 0x8c, x + 24, y + 8, PAL_LAKITU, true, true);
    this.shadow(y, frame, x);
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
    // Comes down 1 px per frame (measured), rod and hook (0x48) under the cloud.
    const y = Math.round(Math.min(s.y - 44, -56 + s.t));
    L.sprite(0x48, s.x, y + 16, PAL_LAKITU, true, true);
    L.sprite(0x42, s.x - 16, y, PAL_LAKITU, true, true);
    L.sprite(0x40, s.x, y, PAL_LAKITU, true, true);
    L.sprite(0x46, s.x - 16, y + 16, PAL_LAKITU, true, true);
    L.sprite(0x44, s.x, y + 16, PAL_LAKITU, true, true);
  }
}

/** Lap signs: the cloud's position every 3 frames, and how long the sign stays (measured in the original). */
const SIGN_PATH: [number, number][] = [
  [6,-29], [6,-23], [12,-17], [17,-11], [23,-5], [28,1], [33,6], [38,12], [43,17], [48,22], [52,26], [56,30], [60,34], [64,38],
  [67,41], [70,44], [73,47], [76,50], [79,52], [81,54], [83,56], [85,57], [87,58], [89,59], [90,60], [91,60], [92,60], [93,60],
  [93,59], [94,58], [94,57], [94,56], [93,54], [93,52], [92,50], [91,47], [90,44], [89,41], [87,38], [85,34], [83,30], [81,26],
  [79,22], [76,17], [73,12], [70,6], [67,1], [64,-5], [60,-11], [57,-17], [54,-23], [51,-29], [48,-35],
];
const SIGN_FRAMES = 165;

/** Finish flag: Lakitu's path (a point every 6 frames), his poses and how long it lasts, measured in the original. */
const FLAG_PATH: [number, number][] = [
  [22,-48], [22,-48], [22,-47], [23,-46], [24,-44], [25,-42], [26,-39], [28,-35], [30,-31], [33,-26], [35,-21], [38,-15],
  [41,-9], [45,-4], [49,0], [53,4], [57,7], [62,10], [67,12], [72,14], [77,15], [83,15], [89,15], [95,15],
  [100,14], [105,12], [110,10], [115,7], [119,3], [123,-1], [127,-5], [130,-10], [133,-16], [136,-22], [139,-27], [141,-32],
  [143,-36], [145,-39], [146,-42], [148,-45], [148,-46], [149,-48], [149,-48], [149,-48], [149,-48], [149,-47], [148,-46], [147,-43],
  [146,-41], [144,-38], [142,-34], [140,-29], [137,-24], [135,-19], [132,-13], [128,-8], [125,-3], [121,1], [117,5], [112,8],
  [108,11], [103,13], [97,14], [92,15], [86,16], [80,15], [75,14], [69,13], [64,11], [59,9], [55,6], [51,2],
  [47,-2], [43,-7], [40,-12], [37,-18], [34,-24], [31,-29], [29,-33], [27,-37], [26,-40],
];
const FLAG_POSES = [0, 1, 2, 1, 2, 1];
const FLAG_POSE_FRAMES = 17;
const FLAG_FRAMES = 481;

/** Frames a lap sign stays (down, hold, up). */
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
