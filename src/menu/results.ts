// The Grand Prix "RESULTS" and "STANDINGS" boards shown after each race, rebuilt from the user's ROM (US).
// Found by finishing a race in snes9x and capturing VRAM/CGRAM/OAM/PPU state: mode 1, BG2 = the title
// screen's hills (night palette), BG3 = the board text in the menu font, sprites = cup icons and karts.

import { decompress } from '../rom/decompress';
import type { SmkRom } from '../rom/rom';
import { createOam, createScreen, expand2bpp, setSprite, type Screen } from '../snes/ppu';

const TITLE_BLOCK = 0x71996;
const SELECT_BLOCK = 0x70b29;
const MENU_FONT_BLOCK = 0x70000;
/** Sprite palettes 0-3 of the board (the karts). */
const OBJ_PAL_BLOCK = 0x31f7f;

/** VRAM layout of the board, as the game sets it up. */
const BG2_MAP = 0x2800;
const BG2_CHR = 0x4000;
const BG3_MAP = 0x3800;
const BG3_CHR = 0x0000;
/** Sprite tiles 0x100-: the cup icons (2bpp, from the select screen bundle). */
const OBJ_CUPS = 0xa000;

/** BG3 tiles (menu font): digits 0x00-0x09, letters 0x0A-0x23. */
const T_BLANK = 0x2f;
const T_MINUTE = 0x28;
const T_SECOND = 0x29;
const T_CC = 0x2a;
const T_DOTS = 0xa4;
const T_DASH = 0x9c;
const T_RULE = 0x9e;
const T_PAREN = 0x7d;
const T_PLUS = 0x7e;
const T_BORDER = 0x3ca3;
/** Tilemap attribute bits: priority, palette << 10, horizontal flip. */
const PRI = 0x2000;
const FLIP_X = 0x4000;

/** Driver names as the boards print them, in the game's character order. */
export const BOARD_NAMES = ['MARIO', 'LUIGI', 'BOWSER', 'PRINCESS', 'DONKEY KONG JR', 'KOOPA TROOPA', 'TOAD', 'YOSHI'];
export const CUP_NAMES = ['MUSHROOM CUP', 'FLOWER CUP', 'STAR CUP', 'SPECIAL CUP'];

export interface BoardRow {
  character: number;
  /** Race time (results) or points (standings). */
  timeMs?: number | null;
  points?: number;
  /** Points just won, shown as "(+9)". */
  gained?: number;
  /** Place shown at the left (standings share places on ties). */
  place: number;
  /** This player's own line (standings: highlighted). */
  self?: boolean;
}

export interface Board {
  kind: 'results' | 'standings';
  cc: number;
  cup: number;
  round: number;
  rows: BoardRow[];
}

export class ResultsBoards {
  private title: Uint8Array;
  private select: Uint8Array;
  private font: Uint8Array;
  private objPal: Uint8Array;

  constructor(rom: SmkRom) {
    if (rom.region !== 'US') throw new Error('As telas originais só foram mapeadas na ROM americana.');
    this.title = decompress(rom.data, TITLE_BLOCK);
    this.select = decompress(rom.data, SELECT_BLOCK);
    this.font = decompress(rom.data, MENU_FONT_BLOCK);
    this.objPal = decompress(rom.data, OBJ_PAL_BLOCK);
  }

  /** The board as a PPU screen; `frame` scrolls the hills (they drift left, as in the original). */
  screen(b: Board, frame: number): Screen {
    const s = createScreen();
    s.vram.set(this.font.subarray(0, 0x1000), BG3_CHR);
    s.vram.set(this.title.subarray(0x2800, 0x3800), BG2_MAP);
    s.vram.set(this.title.subarray(0, 0x2800), BG2_CHR);
    expand2bpp(this.select.subarray(0x3d00, 0x3f00), s.vram, OBJ_CUPS);
    this.text(s, b);
    s.cgram = this.palettes();
    s.mode = 1;
    s.bg3Priority = true;
    s.layers[1] = { map: BG2_MAP, chr: BG2_CHR, size: 1, h: (65394 - frame) & 0xffff, v: 0, enabled: true };
    s.layers[2] = { map: BG3_MAP, chr: BG3_CHR, size: 0, h: 0, v: 0, enabled: true };
    s.oam = createOam();
    // Name base 0x8000, second table at 0xA000 (the cup icons).
    s.obsel = 0x02;
    // Three cup icons each side of the title.
    const icon = CUP_ICONS[b.cup] ?? CUP_ICONS[0];
    [48, 64, 80, 168, 184, 200].forEach((x, i) => setSprite(s.oam!, i, x, 24, icon, 5, 2, true));
    return s;
  }

  private palettes(): Uint16Array {
    const t = this.title, p = this.objPal;
    const word = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
    return new Uint16Array(256).map((_, i) => {
      if (i < 128) return word(t, 0x4200 + i * 2);
      if (i < 192) return word(p, (i - 128) * 2);
      return word(t, 0x4380 + (i - 192) * 2);
    });
  }

  private put(s: Screen, col: number, row: number, entry: number) {
    const at = BG3_MAP + (row * 32 + col) * 2;
    s.vram[at] = entry & 0xff;
    s.vram[at + 1] = entry >> 8;
  }

  private write(s: Screen, col: number, row: number, text: string, pal: number) {
    for (const ch of text) this.put(s, col++, row, glyph(ch) | (pal << 10) | PRI);
  }

  private text(s: Screen, b: Board) {
    // Checkered border, then the dark board.
    for (let r = 0; r < 28; r++) {
      for (let c = 0; c < 32; c++) {
        const edge = r < 2 || r === 27 || c === 0 || c === 31;
        this.put(s, c, r, edge ? T_BORDER : T_BLANK);
      }
    }
    const results = b.kind === 'results';
    const pal = results ? 2 : 0;
    // Title in the big two-line font, ending at column 19.
    const title = results ? 'RESULTS' : 'STANDINGS';
    const titlePal = results ? 5 : 0;
    [...title].forEach((ch, i) => {
      const top = BIG_FONT[ch];
      this.put(s, 20 - title.length + i, 3, top | (titlePal << 10) | PRI);
      this.put(s, 20 - title.length + i, 4, (ch === 'L' ? 0x57 : top + 1) | (titlePal << 10) | PRI);
    });
    // Rules around "50cc  MUSHROOM CUP  ROUND 1".
    for (let c = 2; c < 30; c++) {
      this.put(s, c, 6, T_RULE | (pal << 10) | PRI);
      this.put(s, c, 8, T_RULE | (pal << 10) | PRI);
    }
    this.write(s, 3, 7, `${b.cc}`, pal);
    this.put(s, 3 + `${b.cc}`.length, 7, T_CC | (pal << 10) | PRI);
    this.write(s, 8, 7, CUP_NAMES[b.cup] ?? 'BATTLE MODE', pal);
    this.write(s, 22, 7, 'ROUND', pal);
    this.write(s, 28, 7, `${b.round}`, pal);

    b.rows.slice(0, 8).forEach((row, i) => {
      const r = 10 + i * 2;
      const name = BOARD_NAMES[row.character] ?? '?';
      if (results) {
        // 1st blue, 2nd green, 3rd orange, 4th and below red.
        const p = [0, 4, 6, 5][row.place - 1] ?? 2;
        this.write(s, 3, r, `${row.place}`, p);
        this.write(s, 5, r, name, p);
        for (let c = 6 + name.length; c <= 20; c++) this.put(s, c, r, T_DOTS | (p << 10) | PRI);
        this.write(s, 22, r, row.timeMs == null ? "-'--\"--" : boardTime(row.timeMs), p);
      } else {
        const p = row.self ? 3 : 0;
        this.write(s, 4, r, `${row.place}`, p);
        this.write(s, 6, r, name, p);
        for (let c = 7 + name.length; c <= 23; c++) this.put(s, c, r, T_DOTS | (p << 10) | PRI);
        this.write(s, 24, r, String(Math.min(99, row.points ?? 0)).padStart(2, '0'), p);
        if (row.gained) {
          this.put(s, 26, r, T_PAREN | (p << 10) | PRI);
          this.put(s, 27, r, T_PLUS | (p << 10) | PRI);
          this.write(s, 28, r, `${row.gained}`, p);
          this.put(s, 29, r, T_PAREN | FLIP_X | (p << 10) | PRI);
        }
      }
    });
  }
}

/** Sprite tile of each cup's icon: mushroom, fire flower, star, and the Special Cup's. */
const CUP_ICONS = [0x106, 0x10a, 0x108, 0x110];

/** Big two-line font of the boards: top tile (bottom = top + 1). */
const BIG_FONT: Record<string, number> = {
  A: 0x40, D: 0x46, E: 0x48, G: 0x4c, I: 0x50, L: 0x7c, N: 0x5a, R: 0x62, S: 0x64, T: 0x66, U: 0x68,
};

function glyph(ch: string): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return 10 + ch.charCodeAt(0) - 65;
  if (ch === "'") return T_MINUTE;
  if (ch === '"') return T_SECOND;
  if (ch === '-') return T_DASH;
  return T_BLANK;
}

/** m'ss"cc, one minute digit, as on the board. */
export function boardTime(ms: number): string {
  const t = Math.min(Math.floor(ms / 10), 9 * 6000 + 5999);
  const m = Math.floor(t / 6000), sec = Math.floor(t / 100) % 60, cs = t % 100;
  return `${m}'${String(sec).padStart(2, '0')}"${String(cs).padStart(2, '0')}`;
}
