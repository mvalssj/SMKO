// Minimal SNES picture processor (modes 0 and 1, 8x8 background tiles, sprites, one window), used to draw
// the original menu screens from graphics, tilemaps and palettes read out of the user's ROM.
// Verified against snes9x captures of the title, character select and cup select screens.

export interface BgLayer {
  /** Tilemap base, VRAM byte address. */
  map: number;
  /** Character (tile graphics) base, VRAM byte address. */
  chr: number;
  /** 0 = 32x32, 1 = 64x32, 2 = 32x64, 3 = 64x64 tiles. */
  size: number;
  h: number;
  v: number;
  enabled: boolean;
}

export interface Screen {
  /** 64 KB of VRAM. */
  vram: Uint8Array;
  /** 256 colors as 15-bit BGR. */
  cgram: Uint16Array;
  mode: 0 | 1;
  bg3Priority: boolean;
  layers: BgLayer[];
  /** Sprites: 544 bytes of OAM and the OBSEL register; null = no sprites. */
  oam: Uint8Array | null;
  obsel: number;
  /** Window 1: BG1/BG2 are hidden inside it (how the title menu box shows the black BG3 behind). */
  window: { x0: number; x1: number; y0: number; y1: number } | null;
}

export const SCREEN_W = 256;
export const SCREEN_H = 224;

export function createScreen(): Screen {
  return {
    vram: new Uint8Array(0x10000), cgram: new Uint16Array(256), mode: 1, bg3Priority: false,
    layers: [0, 1, 2, 3].map(() => ({ map: 0, chr: 0, size: 0, h: 0, v: 0, enabled: false })),
    oam: null, obsel: 0, window: null,
  };
}

/** Empty OAM: every sprite parked off screen (y = 224). */
export function createOam(): Uint8Array {
  const oam = new Uint8Array(544);
  for (let i = 0; i < 128; i++) oam[i * 4 + 1] = 224;
  return oam;
}

/** Writes one 8x8 (or big) sprite into OAM slot `i`. */
export function setSprite(oam: Uint8Array, i: number, x: number, y: number, tile: number, palette: number, priority = 3, big = false, flipX = false, flipY = false) {
  const e = i * 4;
  oam[e] = x & 255;
  oam[e + 1] = y & 255;
  oam[e + 2] = tile & 255;
  oam[e + 3] = ((tile >> 8) & 1) | ((palette & 7) << 1) | ((priority & 3) << 4) | (flipX ? 0x40 : 0) | (flipY ? 0x80 : 0);
  const hiByte = 512 + (i >> 2), shift = (i & 3) * 2;
  oam[hiByte] = (oam[hiByte] & ~(3 << shift)) | ((((x >> 8) & 1) | (big ? 2 : 0)) << shift);
}

export function bgr15ToRgb(c: number): [number, number, number] {
  const r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
  return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)];
}

/** Renders one background layer into `out`: CGRAM index | 0x100 if high priority, 0 = transparent. */
function renderLayer(s: Screen, n: number, out: Uint16Array) {
  out.fill(0);
  const L = s.layers[n];
  if (!L.enabled || (s.mode === 1 && n === 3)) return;
  const bpp = s.mode === 0 ? 2 : n < 2 ? 4 : 2;
  const bytes = bpp * 8;
  const wide = L.size & 1, tall = L.size & 2;
  const v = s.vram;
  for (let y = 0; y < SCREEN_H; y++) {
    // The SNES shows background line 1 on the first visible scanline.
    const py = (y + 1 + L.v) & 1023;
    let ty = (py >> 3) & 63;
    if (!tall) ty &= 31;
    const screenY = ty >= 32 ? (wide ? 2 : 1) : 0;
    ty &= 31;
    for (let x = 0; x < SCREEN_W; x++) {
      const px = (x + L.h) & 1023;
      let tx = (px >> 3) & 63;
      if (!wide) tx &= 31;
      const screen = screenY + (tx >= 32 ? 1 : 0);
      tx &= 31;
      const at = (L.map + screen * 2048 + (ty * 32 + tx) * 2) & 0xffff;
      const entry = v[at] | (v[(at + 1) & 0xffff] << 8);
      let fx = px & 7, fy = py & 7;
      if (entry & 0x4000) fx = 7 - fx;
      if (entry & 0x8000) fy = 7 - fy;
      const base = L.chr + (entry & 0x3ff) * bytes;
      const bit = 7 - fx;
      let o = (base + fy * 2) & 0xffff;
      let ci = ((v[o] >> bit) & 1) | (((v[o + 1] >> bit) & 1) << 1);
      if (bpp === 4) {
        o = (o + 16) & 0xffff;
        ci |= (((v[o] >> bit) & 1) << 2) | (((v[o + 1] >> bit) & 1) << 3);
      }
      if (!ci) continue;
      const pal = (entry >> 10) & 7;
      const color = bpp === 4 ? pal * 16 + ci : s.mode === 0 ? n * 32 + pal * 4 + ci : pal * 4 + ci;
      out[y * SCREEN_W + x] = color | (entry & 0x2000 ? 0x100 : 0) | 0x200;
    }
  }
}

const OBJ_SIZES: [number, number][][] = [
  [[8, 8], [16, 16]], [[8, 8], [32, 32]], [[8, 8], [64, 64]], [[16, 16], [32, 32]],
  [[16, 16], [64, 64]], [[32, 32], [64, 64]], [[16, 32], [32, 64]], [[16, 32], [32, 32]],
];

/** Sprites into `out`: CGRAM index | priority << 9 | 0x800, 0 = none. Lower OAM index wins. */
function renderSprites(s: Screen, out: Uint16Array) {
  out.fill(0);
  const oam = s.oam;
  if (!oam) return;
  const v = s.vram;
  const base = (s.obsel & 7) << 14;
  const gap = (((s.obsel >> 3) & 3) + 1) << 13;
  const sizes = OBJ_SIZES[s.obsel >> 5];
  for (let i = 127; i >= 0; i--) {
    const e = i * 4;
    const hi = (oam[512 + (i >> 2)] >> ((i & 3) * 2)) & 3;
    let x = oam[e] | ((hi & 1) << 8);
    if (x >= 256) x -= 512;
    const y = oam[e + 1];
    const attr = oam[e + 3];
    const tile = oam[e + 2] | ((attr & 1) << 8);
    const pal = (attr >> 1) & 7, pr = (attr >> 4) & 3;
    const [w, h] = sizes[(hi >> 1) & 1];
    for (let py = 0; py < h; py++) {
      const sy = (y + py) & 255;
      if (sy >= SCREEN_H) continue;
      const ty = attr & 0x80 ? h - 1 - py : py;
      for (let px = 0; px < w; px++) {
        const sx = x + px;
        if (sx < 0 || sx >= SCREEN_W) continue;
        const tx = attr & 0x40 ? w - 1 - px : px;
        const t = (tile & 0x100) | ((((tile >> 4) + (ty >> 3)) & 15) << 4) | (((tile & 15) + (tx >> 3)) & 15);
        const addr = (base + (t & 0x100 ? gap : 0) + (t & 0xff) * 32 + (ty & 7) * 2) & 0xffff;
        const bit = 7 - (tx & 7);
        const ci = ((v[addr] >> bit) & 1) | (((v[addr + 1] >> bit) & 1) << 1) |
          (((v[addr + 16] >> bit) & 1) << 2) | (((v[addr + 17] >> bit) & 1) << 3);
        if (ci) out[sy * SCREEN_W + sx] = (128 + pal * 16 + ci) | (pr << 9) | 0x800;
      }
    }
  }
}

const layerBufs = [0, 1, 2, 3].map(() => new Uint16Array(SCREEN_W * SCREEN_H));
const objBuf = new Uint16Array(SCREEN_W * SCREEN_H);

/** Renders the whole frame (backgrounds + sprites, SNES priority rules) into RGBA. */
export function renderFrame(s: Screen, out = new Uint8Array(SCREEN_W * SCREEN_H * 4)): Uint8Array {
  for (let n = 0; n < 4; n++) renderLayer(s, n, layerBufs[n]);
  renderSprites(s, objBuf);
  const rgb = Array.from(s.cgram, bgr15ToRgb);
  const [b1, b2, b3, b4] = layerBufs;
  const win = s.window;
  for (let y = 0; y < SCREEN_H; y++) {
    const inWinY = win && y >= win.y0 && y <= win.y1;
    for (let x = 0; x < SCREEN_W; x++) {
      const p = y * SCREEN_W + x;
      const masked = inWinY && x >= win!.x0 && x <= win!.x1;
      const l1 = masked ? 0 : b1[p], l2 = masked ? 0 : b2[p], l3 = b3[p], l4 = b4[p], o = objBuf[p];
      const op = o ? (o >> 9) & 3 : -1;
      let c = 0;
      // Front to back, as on the SNES.
      if (s.mode === 1 && s.bg3Priority && l3 & 0x100) c = l3;
      else if (op === 3) c = o;
      else if (l1 & 0x100) c = l1;
      else if (l2 & 0x100) c = l2;
      else if (op === 2) c = o;
      else if (l1) c = l1;
      else if (l2) c = l2;
      else if (op === 1) c = o;
      else if (s.mode === 0) {
        if (l3 & 0x100) c = l3; else if (l4 & 0x100) c = l4; else if (op === 0) c = o; else if (l3) c = l3; else if (l4) c = l4;
      } else if (l3 & 0x100 && !s.bg3Priority) c = l3;
      else if (op === 0) c = o;
      else if (l3) c = l3;
      const col = rgb[c & 0xff];
      out[p * 4] = col[0]; out[p * 4 + 1] = col[1]; out[p * 4 + 2] = col[2]; out[p * 4 + 3] = 255;
    }
  }
  return out;
}

/** 2bpp tiles (16 bytes each) -> 4bpp VRAM tiles with empty upper planes, as the game does for menu graphics. */
export function expand2bpp(src: Uint8Array, vram: Uint8Array, at: number, tiles = src.length >> 4) {
  for (let t = 0; t < tiles; t++) {
    const d = at + t * 32;
    vram.set(src.subarray(t * 16, t * 16 + 16), d);
    vram.fill(0, d + 16, d + 32);
  }
}
