// Race sprites and HUD graphics (US ROM), rebuilt the way the game lays them out in VRAM.
// Found by running a race in snes9x (analysis copy without the DSP-1), capturing VRAM and tracing every
// byte back to the ROM: Lakitu, traffic light, lap signs, coins, digits and map heads are 4bpp sprite
// tiles; the timer, lap box and their font are 2bpp BG3 tiles.

import { decompress } from './decompress';
import type { SmkRom } from './rom';

/** Sprite tiles 0x000-0x1FF, 32 bytes each (tile 0x100 = what the game puts at VRAM 0xC000). */
export const OBJ_TILES = 512;
/** BG3 HUD tiles 0x00-0xFF, 16 bytes each (2bpp). */
export const HUD_TILES = 256;

export interface RaceGfx {
  obj: Uint8Array;
  hud: Uint8Array;
}

/** [block offset, bytes from, bytes to, destination byte in `obj`] */
const OBJ_COPIES: [number, number, number, number][] = [
  [0x00903, 0x0000, 0x0800, 0x0000], // tiles 00-3F: smoke, sparks, dust
  [0x10000, 0x0200, 0x1200, 0x0800], // tiles 40-BF: Lakitu, cloud, coins, signs, digits, flag
  [0x10000, 0x0120, 0x0180, 0x1d60], // tiles EB-ED: Lakitu's shadow
  [0x10000, 0x0180, 0x0210, 0x1f60], // tiles FB-FF: traffic light bulbs
  [0x30000, 0x0800, 0x0c00, 0x2400], // tiles 120-13F: map heads, place digits 1-4
  [0x30000, 0x0c80, 0x0f00, 0x2800], // tiles 140-15B: place digits 5-8
  [0x10000, 0x1200, 0x12c0, 0x2d00], // tiles 168-16D: sparkles
  [0x10000, 0x12c0, 0x1380, 0x2f00],
];

/** The HUD font and frames (timer digits, lap box), placed at BG3 tile 0x80. */
const HUD_BLOCK = 0x112f8;

export function loadRaceGfx(rom: SmkRom): RaceGfx | null {
  if (rom.region !== 'US') return null;
  const obj = new Uint8Array(OBJ_TILES * 32);
  const blocks = new Map<number, Uint8Array>();
  for (const [block, from, to, dst] of OBJ_COPIES) {
    if (!blocks.has(block)) blocks.set(block, decompress(rom.data, block));
    obj.set(blocks.get(block)!.subarray(from, to), dst);
  }
  const hud = new Uint8Array(HUD_TILES * 16);
  hud.set(decompress(rom.data, HUD_BLOCK).subarray(0, 0x700), 0x80 * 16);
  return { obj, hud };
}
