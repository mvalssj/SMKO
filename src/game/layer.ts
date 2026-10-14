// A 256x224 RGBA picture the race's sprites and HUD are drawn into at the SNES resolution, one pixel per
// SNES pixel, in painter's order. Sprite tiles are 4bpp (palette = sprite palette 0-7), HUD tiles 2bpp.

import type { SpriteFrame } from '../rom/rom';

export const W = 256;
export const H = 224;

type Rgb = readonly [number, number, number];

export class Layer {
  readonly px = new Uint8ClampedArray(W * H * 4);
  /** Optional clip rectangle (rows), e.g. the race view or the map. */
  private clip = { y0: 0, y1: H };

  constructor(
    private obj: Uint8Array,
    private hud: Uint8Array,
    /** The track's 256 colors; sprite palette p is colors[(8 + p) * 16 + i]. */
    public colors: Rgb[],
  ) {}

  clear() {
    this.px.fill(0);
  }

  setClip(y0 = 0, y1 = H) {
    this.clip = { y0, y1 };
  }

  private put(x: number, y: number, c: Rgb, alpha = 1) {
    if (x < 0 || x >= W || y < this.clip.y0 || y >= this.clip.y1) return;
    const p = (y * W + x) * 4;
    if (alpha >= 1) {
      this.px[p] = c[0]; this.px[p + 1] = c[1]; this.px[p + 2] = c[2]; this.px[p + 3] = 255;
    } else {
      // Blend over what is already in the layer (the floor shows through where nothing was drawn).
      const a = this.px[p + 3] / 255;
      this.px[p] = c[0] * alpha + this.px[p] * (1 - alpha);
      this.px[p + 1] = c[1] * alpha + this.px[p + 1] * (1 - alpha);
      this.px[p + 2] = c[2] * alpha + this.px[p + 2] * (1 - alpha);
      this.px[p + 3] = Math.max(a, alpha) * 255;
    }
  }

  /** One 8x8 (or 16x16 when `big`) sprite, like an OAM entry. */
  sprite(tile: number, x: number, y: number, palette: number, big = false, flipX = false, flipY = false) {
    const n = big ? 2 : 1;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        // Big sprites: tiles N, N+1 on top, N+16, N+17 below; flipping swaps the halves.
        const t = tile + (flipY ? n - 1 - ty : ty) * 16 + (flipX ? n - 1 - tx : tx);
        this.tile4(t & 0x1ff, x + tx * 8, y + ty * 8, palette, flipX, flipY);
      }
    }
  }

  private tile4(t: number, x0: number, y0: number, palette: number, flipX: boolean, flipY: boolean) {
    const at = t * 32, d = this.obj;
    for (let y = 0; y < 8; y++) {
      const ry = flipY ? 7 - y : y;
      const b0 = d[at + ry * 2], b1 = d[at + ry * 2 + 1], b2 = d[at + 16 + ry * 2], b3 = d[at + 16 + ry * 2 + 1];
      for (let x = 0; x < 8; x++) {
        const bit = flipX ? x : 7 - x;
        const ci = ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1) | (((b2 >> bit) & 1) << 2) | (((b3 >> bit) & 1) << 3);
        if (ci) this.put(x0 + x, y0 + y, this.colors[(8 + palette) * 16 + ci]);
      }
    }
  }

  /** Color index (0-15) of pixel (x, y) of sprite tile `t`: for redrawing a glyph larger. */
  tilePixel(t: number, x: number, y: number): number {
    const at = t * 32, d = this.obj, bit = 7 - x;
    return ((d[at + y * 2] >> bit) & 1) | (((d[at + y * 2 + 1] >> bit) & 1) << 1) | (((d[at + 16 + y * 2] >> bit) & 1) << 2) | (((d[at + 16 + y * 2 + 1] >> bit) & 1) << 3);
  }

  /** Color index (0-3) of pixel (x, y) of 2bpp HUD tile `t`. */
  hudPixel(t: number, x: number, y: number): number {
    const at = t * 16, d = this.hud, bit = 7 - x;
    return ((d[at + y * 2] >> bit) & 1) | (((d[at + y * 2 + 1] >> bit) & 1) << 1);
  }

  /** One 2bpp HUD tile with its own 4 colors (index 0 transparent). */
  hudTile(t: number, x0: number, y0: number, colors: Rgb[], flipX = false, flipY = false) {
    const at = t * 16, d = this.hud;
    for (let y = 0; y < 8; y++) {
      const ry = flipY ? 7 - y : y;
      const b0 = d[at + ry * 2], b1 = d[at + ry * 2 + 1];
      for (let x = 0; x < 8; x++) {
        const bit = flipX ? x : 7 - x;
        const ci = ((b0 >> bit) & 1) | (((b1 >> bit) & 1) << 1);
        if (ci) this.put(x0 + x, y0 + y, colors[ci]);
      }
    }
  }

  /** A pre-colored frame (driver, track object), 1:1, optionally mirrored, see-through or flashing. */
  frame(f: SpriteFrame, x0: number, y0: number, mirror = false, alpha = 1, flash = false) {
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const q = (y * f.w + (mirror ? f.w - 1 - x : x)) * 4;
        if (!f.pixels[q + 3]) continue;
        let c: Rgb = [f.pixels[q], f.pixels[q + 1], f.pixels[q + 2]];
        if (flash) c = [255 - c[0] * 0.3, 255 - c[1] * 0.6, 160 + c[2] * 0.3];
        this.put(x0 + x, y0 + y, c, alpha);
      }
    }
  }

  /** A frame resampled (nearest neighbour) to w x h: track objects and items, which the game scales. */
  scaled(f: SpriteFrame, x0: number, y0: number, w: number, h: number) {
    if (w < 1 || h < 1) return;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(f.h - 1, Math.floor((y * f.h) / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(f.w - 1, Math.floor((x * f.w) / w));
        const q = (sy * f.w + sx) * 4;
        if (f.pixels[q + 3]) this.put(x0 + x, y0 + y, [f.pixels[q], f.pixels[q + 1], f.pixels[q + 2]]);
      }
    }
  }

  /** Solid rectangle (the map's kart dots when a head icon isn't available). */
  rect(x0: number, y0: number, w: number, h: number, c: Rgb) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.put(x0 + x, y0 + y, c);
  }
}
