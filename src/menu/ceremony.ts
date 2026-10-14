// Award ceremony after the last race of a Grand Prix: the top three on the podium, the trophy brought down,
// confetti, and the closing line ("MARIO WINS THE GOLD."). Sky and scenery are the last course's (from the ROM);
// drivers, Lakitu, sparkles and the font are the race's own graphics.
// The original draws the podium and the course floor in Mode 7: here they are simple shapes (approximation).

import { decompress } from '../rom/decompress';
import { BG_BACK_W, BG_FRONT_W, BG_HEIGHT, type DriverSprites, type SmkRom, type Track } from '../rom/rom';
import type { RaceGfx } from '../rom/race-gfx';
import { Layer } from '../game/layer';
import { BOARD_NAMES, CUP_NAMES } from './results';

const W = 256;
const H = 224;
const SELECT_BLOCK = 0x70b29;
/** The trophy: 16x16 cup icon of the select screen bundle (2bpp, 4 tiles from this byte). */
const TROPHY_AT = 0x3d00 + 0x04 * 16;

type Rgb = readonly [number, number, number];

/** Where the course meets the sky, and the podium's foot. */
const HORIZON = 150;
const PODIUM_BASE = 206;
/** Podium blocks: 2nd (left), 1st (middle, highest), 3rd (right). */
const PODIUM = [
  { place: 2, x: 72, h: 22 },
  { place: 1, x: 112, h: 30 },
  { place: 3, x: 152, h: 18 },
];
const STONE: Rgb = [200, 200, 208];
const STONE_DARK: Rgb = [120, 120, 136];
const ROAD: Rgb = [104, 104, 104];

export class Ceremony {
  private select: Uint8Array;
  private ctx: CanvasRenderingContext2D;
  private image = new ImageData(W, H);
  private raf = 0;
  private unlisten: (() => void) | null = null;

  constructor(rom: SmkRom, private canvas: HTMLCanvasElement, private gfx: RaceGfx) {
    this.select = decompress(rom.data, SELECT_BLOCK);
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext('2d')!;
  }

  /**
   * `top`: characters in 1st, 2nd, 3rd place; `self`: the player's character (named in the closing line).
   * `track`: the last course (its sky, scenery and palettes). Enter / X / Space ends it.
   */
  play(top: number[], self: number, cc: number, cup: number, drivers: Map<number, DriverSprites | null>, track: Track, done: () => void) {
    this.stop();
    this.canvas.hidden = false;
    const layer = new Layer(this.gfx.obj, this.gfx.hud, track.colors);
    const place = top.indexOf(self) + 1;
    const medal = ['GOLD', 'SILVER', 'BRONZE'][place - 1];
    const lines = [
      `${cc}CC ${CUP_NAMES[cup] ?? ''} RACE`,
      medal ? `${BOARD_NAMES[self]} WINS THE ${medal}.` : `${BOARD_NAMES[top[0]] ?? ''} WINS THE GOLD.`,
      medal ? 'GREAT RACE!' : 'BETTER LUCK NEXT TIME!',
    ];
    let frame = 0;
    const confetti = Array.from({ length: 40 }, (_, i) => ({ x: (i * 53) % W, y: -((i * 37) % 200), v: 0.5 + ((i * 7) % 5) / 6, p: i % 8 }));
    const key = (e: KeyboardEvent) => {
      if (frame > 120 && ['Enter', 'Space', 'KeyX'].includes(e.code)) { e.preventDefault(); this.stop(); done(); }
    };
    addEventListener('keydown', key);
    this.unlisten = () => removeEventListener('keydown', key);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      frame++;
      this.sky(track, frame);
      layer.clear();
      this.scene(layer, top, drivers, frame, confetti, lines);
      const out = this.image.data, px = layer.px;
      for (let i = 0; i < out.length; i += 4) {
        if (px[i + 3]) { out[i] = px[i]; out[i + 1] = px[i + 1]; out[i + 2] = px[i + 2]; }
      }
      this.ctx.putImageData(this.image, 0, 0);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.unlisten?.();
    this.unlisten = null;
    this.canvas.hidden = true;
  }

  /** The course's sky color with its two scenery layers along the horizon, drifting slowly. */
  private sky(track: Track, frame: number) {
    const out = this.image.data, [r, g, b] = track.backColor;
    for (let i = 0; i < out.length; i += 4) { out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; }
    const top = HORIZON - BG_HEIGHT;
    for (const [bg, w, speed] of [[track.background.back, BG_BACK_W, 0.125], [track.background.front, BG_FRONT_W, 0.25]] as const) {
      for (let y = 0; y < BG_HEIGHT; y++) {
        for (let x = 0; x < W; x++) {
          const sx = Math.floor(x + frame * speed) % w, p = (y * w + sx) * 4;
          if (!bg[p + 3]) continue;
          const o = ((top + y) * W + x) * 4;
          out[o] = bg[p]; out[o + 1] = bg[p + 1]; out[o + 2] = bg[p + 2];
        }
      }
    }
  }

  private scene(L: Layer, top: number[], drivers: Map<number, DriverSprites | null>, frame: number,
    confetti: { x: number; y: number; v: number; p: number }[], lines: string[]) {
    // The course floor in front of the hills.
    L.rect(0, HORIZON, W, H - HORIZON, ROAD);
    // Podium and its numbers (the timer's big digits), drivers standing on it facing us.
    for (const b of PODIUM) {
      const y = PODIUM_BASE - b.h;
      L.rect(b.x, y, 32, b.h, STONE);
      L.rect(b.x, y, 32, 3, [232, 232, 240]);
      L.rect(b.x + 29, y + 3, 3, b.h - 3, STONE_DARK);
      const white: Rgb[] = [[0, 0, 0], [40, 40, 56], [120, 120, 136], [0, 0, 0]];
      L.hudTile(0x80 + b.place, b.x + 12, y + 4, white);
      L.hudTile(0x90 + b.place, b.x + 12, y + 12, white);
      const c = top[b.place - 1];
      const f = c === undefined ? null : drivers.get(c)?.rows[0]?.[15];
      if (!f) continue;
      // The winner hops for joy.
      const hop = b.place === 1 && frame > 200 ? Math.abs(Math.sin(frame / 10)) * 6 : 0;
      L.frame(f, b.x + 16 - Math.floor(f.w / 2), Math.round(y - f.h - hop));
    }
    // Lakitu flies down with the trophy and leaves it with the winner.
    if (frame < 320) {
      const t = Math.min(frame, 200);
      const ly = -40 + t * 0.55;
      const lx = 40 + t * 0.4;
      L.sprite(0x42, lx, ly, 5, true, true); L.sprite(0x40, lx + 16, ly, 5, true, true);
      L.sprite(0x46, lx, ly + 16, 5, true, true); L.sprite(0x44, lx + 16, ly + 16, 5, true, true);
      if (frame < 200) this.trophy(L, lx + 30, ly + 30);
    }
    if (frame >= 200) this.trophy(L, 120, PODIUM_BASE - 28 - 52 - (frame > 200 ? Math.abs(Math.sin(frame / 10)) * 6 : 0));
    // Confetti: the race's sparkle sprites in every palette, falling and drifting.
    if (frame > 160) {
      for (const c of confetti) {
        c.y += c.v;
        if (c.y > H) c.y -= H + 20;
        const x = (c.x + Math.sin((frame + c.x) / 20) * 6 + W) % W;
        L.sprite(0x168 + ((frame >> 3) + c.p) % 4, Math.round(x), Math.round(c.y), c.p);
      }
    }
    // Closing lines in the menu font.
    if (frame > 300) {
      const c: Rgb[] = [[0, 0, 0], [248, 252, 248], [168, 168, 224], [0, 0, 0]];
      lines.forEach((text, i) => {
        const x0 = 16 + 8 * 2;
        [...text].forEach((ch, j) => L.fontTile(this.gfx.font, menuGlyph(ch), x0 + j * 8, 64 + i * 16, c));
      });
    }
  }

  /** The trophy (the cup icon of the menus) in gold. */
  private trophy(L: Layer, x: number, y: number) {
    const gold: Rgb[] = [[0, 0, 0], [248, 216, 64], [192, 128, 0], [64, 32, 0]];
    for (let t = 0; t < 4; t++) {
      const tile = this.select.subarray(TROPHY_AT + [0, 1, 16, 17][t] * 16);
      for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) {
        const ci = ((tile[py * 2] >> (7 - px)) & 1) | (((tile[py * 2 + 1] >> (7 - px)) & 1) << 1);
        if (ci) L.rect(Math.round(x) + (t & 1) * 8 + px, Math.round(y) + (t >> 1) * 8 + py, 1, 1, gold[ci]);
      }
    }
  }
}

/** Menu font tile for a character (digits, letters, '.', '!', space). */
function menuGlyph(ch: string): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return 10 + ch.charCodeAt(0) - 65;
  if (ch === '.') return 0x25;
  if (ch === '!') return 0x27;
  return 0x2f;
}
