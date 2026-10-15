// Drawing helpers for the original menus: sprite text (small menu font), BG text (big 2-tile font),
// and the tilemap edits the game makes on the character and cup select screens.

import { setSprite, type Screen } from '../snes/ppu';

/** Small menu font (sprites, title screen): digits 0-9, letters A-Z, then a few symbols. */
export function smallGlyph(ch: string): number {
  const c = ch.toUpperCase();
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return 10 + c.charCodeAt(0) - 65;
  if (c === '?') return 0x24;
  if (c === '¢') return 0x2a; // "cc"
  return 0x2f; // space
}

/** Writes sprite text; returns the next free OAM slot. */
export function spriteText(oam: Uint8Array, slot: number, x: number, y: number, text: string, palette: number, priority = 0): number {
  for (const ch of text) {
    if (ch !== ' ') setSprite(oam, slot++, x, y, smallGlyph(ch), palette, priority);
    x += 8;
  }
  return slot;
}

/** Big font (cup/course screens): letter top tile = 0x80 + 2 * index, bottom tile = top + 1; digits from 0x108. */
export function bigGlyph(ch: string): number | null {
  const c = ch.toUpperCase();
  if (c >= 'A' && c <= 'Z') return 0x80 + 2 * (c.charCodeAt(0) - 65);
  if (c >= '0' && c <= '9') return 0x108 + 2 * (c.charCodeAt(0) - 48);
  return null;
}

export function setMapEntry(s: Screen, map: number, x: number, y: number, entry: number) {
  const at = map + (y * 32 + x) * 2;
  s.vram[at] = entry & 0xff;
  s.vram[at + 1] = entry >> 8;
}

export function getMapEntry(s: Screen, map: number, x: number, y: number): number {
  const at = map + (y * 32 + x) * 2;
  return s.vram[at] | (s.vram[at + 1] << 8);
}

/** Big font text on a BG map (2 rows tall). */
export function bigText(s: Screen, map: number, col: number, row: number, text: string, palette: number) {
  for (let i = 0; i < text.length; i++) {
    const g = bigGlyph(text[i]);
    const top = g === null ? 0x00e5 : g | (palette << 10);
    const bottom = g === null ? 0x00e5 : (g + 1) | (palette << 10);
    setMapEntry(s, map, col + i, row, top);
    setMapEntry(s, map, col + i, row + 1, bottom);
  }
}

// ---------- Cup / course screen ----------

export const CUP_MAP = 0x4800;
const CUP_FILL = 0xf46f;
const CUP_BORDER = 0x00e3;

/** The red checkered frame with the black panel (as the game builds it), then the given lines of text. */
export function buildCupMap(s: Screen, lines: string[], selected: number, firstRow = 9, spacing = 4) {
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      let e = CUP_FILL;
      if (y === 2 || y === 3) e = x < 10 || x > 21 ? CUP_BORDER : CUP_FILL;
      else if (y >= 4 && y <= 23) e = x < 2 || x > 29 ? CUP_BORDER : CUP_FILL;
      else if (y === 24 || y === 25) e = CUP_BORDER;
      setMapEntry(s, CUP_MAP, x, y, e);
    }
  }
  lines.forEach((text, i) => bigText(s, CUP_MAP, 8, firstRow + i * spacing, text, i === selected ? 0 : 5));
}

/** Big font as sprites (the cup screen has no small font); spaces are skipped. Returns the next free OAM slot. */
export function bigSpriteText(oam: Uint8Array, slot: number, x: number, y: number, text: string, palette: number): number {
  for (const ch of text) {
    const g = bigGlyph(ch);
    if (g !== null) {
      setSprite(oam, slot++, x, y, g, palette, 3);
      setSprite(oam, slot++, x, y + 8, g + 1, palette, 3);
    }
    x += 8;
  }
  return slot;
}

/** "50cc CLASS" title at the top of the cup screen (sprites, big font). */
export function cupTitle(oam: Uint8Array, slot: number, cc: number): number {
  const digits = String(cc);
  let x = 112 - digits.length * 8;
  for (const d of digits) {
    const g = bigGlyph(d)!;
    setSprite(oam, slot++, x, 16, g, 3, 3);
    setSprite(oam, slot++, x, 24, g + 1, 3, 3);
    x += 8;
  }
  setSprite(oam, slot++, 112, 24, 0x6a, 3, 3); // small "cc"
  x = 128;
  for (const ch of 'CLASS') {
    const g = bigGlyph(ch)!;
    setSprite(oam, slot++, x, 16, g, 3, 3);
    setSprite(oam, slot++, x, 24, g + 1, 3, 3);
    x += 8;
  }
  return slot;
}

/** 40 icons going round the frame clockwise, 16 px apart, half a pixel per frame. */
export function cupBorder(oam: Uint8Array, slot: number, frame: number, tile = 0x46): number {
  const W = 192, H = 128, P = 2 * (W + H);
  for (let i = 0; i < 40; i++) {
    let d = (i * 16 + frame * 0.5) % P;
    let x: number, y: number;
    if (d < W) { x = 24 + d; y = 40; }
    else if ((d -= W) < H) { x = 216; y = 40 + d; }
    else if ((d -= H) < W) { x = 216 - d; y = 168; }
    else { d -= W; x = 24; y = 168 - d; }
    setSprite(oam, slot++, Math.round(x), Math.round(y), tile, 3, 3, true);
  }
  return slot;
}

// ---------- Character select ----------

export const SELECT_BG1 = 0x4800;
export const SELECT_BG4 = 0x7000;
/** TV order on screen (left to right, top row first) -> character index (Mario, Luigi, Bowser, Peach, DK, Koopa, Toad, Yoshi). */
export const TV_CHARACTERS = [0, 3, 2, 5, 1, 7, 4, 6];
/** Top-left of each TV's 32x32 driver sprite. */
export const TV_SPRITE_POS = TV_CHARACTERS.map((_, i) => ({ x: 40 + (i % 4) * 48, y: 80 + Math.floor(i / 4) * 64 }));

/**
 * Puts the player marker above a TV. The original 1P and 2P labels are actual
 * character-select BG tiles from the ROM (15/16 and 17/18 respectively), not
 * menu-font sprites. SMK only ever needs those two labels, so 3P..8P extend
 * that same framed marker with tiles generated in the unused part of the
 * character-select BG set.
 */
export function tvMarker(s: Screen, tv: number, player: number | null) {
  const col = 6 + (tv % 4) * 6, row = 8 + Math.floor(tv / 4) * 8;
  if (player === null) {
    setMapEntry(s, SELECT_BG1, col, row, 0x0802);
    setMapEntry(s, SELECT_BG1, col + 1, row, 0x0803);
    return;
  }
  const digit = player === 1 ? 0x15 : player === 2 ? 0x17 : onlineDigitTile(s, player);
  setMapEntry(s, SELECT_BG1, col, row, 0x1800 | digit);
  setMapEntry(s, SELECT_BG1, col + 1, row, player === 2 ? 0x1818 : 0x1816);
}

/** Extra online-player digits in the same 8x8 framed-label style as the ROM's 1P/2P tiles. */
const ONLINE_DIGITS: Record<number, readonly string[]> = {
  3: ['.....', '.XXX.', '....X', '..XX.', '....X', '.XXX.'],
  4: ['...X.', '..XX.', '.X.X.', 'XXXXX', '...X.', '...X.'],
  5: ['.XXXX', '.X...', '.XXX.', '....X', '....X', '.XXX.'],
  6: ['..XXX', '.X...', '.XXXX', '.X..X', '.X..X', '..XX.'],
  7: ['.XXXX', '....X', '...X.', '..X..', '..X..', '..X..'],
  8: ['..XXX', '.X..X', '..XX.', '.X..X', '.X..X', '..XX.'],
};

function onlineDigitTile(s: Screen, player: number): number {
  const tile = 0x50 + player - 3;
  const at = 0x6000 + tile * 16;
  // Tile 02 is the left half of the original empty marker: retain its frame,
  // then draw a compact, one-colour digit with the original marker palette.
  s.vram.copyWithin(at, 0x6000 + 0x02 * 16, 0x6000 + 0x03 * 16);
  const rows = ONLINE_DIGITS[player];
  if (!rows) return tile;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      if (rows[y][x] === 'X') s.vram[at + (y + 2) * 2] |= 1 << (7 - (x + 2));
    }
  }
  return tile;
}

/** The "1P OK?" box at the bottom right. */
export function okPrompt(s: Screen, on: boolean) {
  for (let i = 0; i < 4; i++) setMapEntry(s, SELECT_BG1, 19 + i, 24, on ? 0x1840 + i : 0x0805);
}

/** Lights up a TV screen once its driver is chosen (BG4). */
export function tvChosen(s: Screen, tv: number, on: boolean) {
  const c0 = 4 + (tv % 4) * 6, r0 = 9 + Math.floor(tv / 4) * 8;
  for (let y = r0; y < r0 + 7; y++) {
    for (let x = c0; x < c0 + 6; x++) setMapEntry(s, SELECT_BG4, x, y, on ? (y < r0 + 4 ? 0x281c : 0x2410) : 0x3014);
  }
}
