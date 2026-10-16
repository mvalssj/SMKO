// Plays the RESULTS / STANDINGS boards on their own canvas over the race view: the board (PPU picture
// rebuilt from the ROM), the hills drifting, and the drivers' karts driving across the bottom.

import type { DriverSprites, SmkRom } from '../rom/rom';
import { renderFrame, type Screen } from '../snes/ppu';
import { ResultsBoards, type Board } from './results';
import { animationFrame } from './timing';

const W = 256;
const H = 224;
/** Karts drive along this line (bottom of the 32 px frames), in finishing order, the winner in front. */
const KART_GROUND = 192;
const KART_GAP = 40;
const KART_SPEED = 1.2;

export class BoardPlayer {
  private boards: ResultsBoards;
  private ctx: CanvasRenderingContext2D;
  private image = new ImageData(W, H);
  private raf = 0;
  private unlisten: (() => void) | null = null;

  constructor(rom: SmkRom, private canvas: HTMLCanvasElement) {
    this.boards = new ResultsBoards(rom);
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext('2d')!;
  }

  /**
   * Shows `seq` in turn. Each board stays `autoMs` (0 = until Enter / X / Space). After the last one,
   * `done` runs on a key press (or, with autoMs, the last board just stays until stop()).
   */
  play(seq: Board[], drivers: Map<number, DriverSprites | null>, autoMs: number, done: () => void) {
    this.stop();
    if (!seq.length) { done(); return; }
    this.canvas.hidden = false;
    const startedAt = performance.now();
    let index = 0, shownAt = startedAt, frame = 0;
    let screen = this.boards.screen(seq[0], 0);
    const next = () => {
      if (index < seq.length - 1) {
        index++;
        shownAt = performance.now();
        screen = this.boards.screen(seq[index], frame);
      } else if (!autoMs) {
        this.stop();
        done();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (['Enter', 'Space', 'KeyX'].includes(e.code)) { e.preventDefault(); next(); }
    };
    addEventListener('keydown', key);
    this.unlisten = () => removeEventListener('keydown', key);
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      frame = animationFrame(startedAt, now);
      if (autoMs && now - shownAt > autoMs && index < seq.length - 1) next();
      this.draw(screen, seq[index], drivers, frame);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.unlisten?.();
    this.unlisten = null;
    this.canvas.hidden = true;
  }

  private draw(screen: Screen, board: Board, drivers: Map<number, DriverSprites | null>, frame: number) {
    // The hills drift slowly to the left.
    screen.layers[1].h = (65394 + Math.floor(frame / 2)) & 0xffff;
    // Your own line (BG3 palette 3) flashes between blue and yellow-green.
    const flash = (frame >> 4) & 1 ? 0x17f5 : 0x7e06;
    screen.cgram[13] = screen.cgram[14] = flash;
    const px = renderFrame(screen);
    const out = this.image.data;
    out.set(px);
    // Karts: the side view of the nearest size, driving right.
    const loop = W + 8 * KART_GAP;
    board.rows.forEach((row, i) => {
      const f = drivers.get(row.character)?.rows[0]?.[8];
      if (!f) return;
      const x0 = Math.round(((frame * KART_SPEED - i * KART_GAP) % loop + loop) % loop) - KART_GAP;
      const y0 = KART_GROUND - f.h;
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          const sx = x0 + x, sy = y0 + y;
          if (sx < 8 || sx >= W - 8 || sy < 0 || sy >= H - 16) continue;
          const q = (y * f.w + x) * 4;
          if (!f.pixels[q + 3]) continue;
          const o = (sy * W + sx) * 4;
          out[o] = f.pixels[q]; out[o + 1] = f.pixels[q + 1]; out[o + 2] = f.pixels[q + 2]; out[o + 3] = 255;
        }
      }
    });
    this.ctx.putImageData(this.image, 0, 0);
  }
}
