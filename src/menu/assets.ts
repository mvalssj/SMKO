// The original menu screens, rebuilt from the user's ROM (US version): title, character select, cup select.
// Block offsets and VRAM layouts were found by running the game in snes9x, capturing VRAM/CGRAM/OAM on each
// screen and tracing every byte back to the ROM (see README, "Telas originais").

import { decompress } from '../rom/decompress';
import type { SmkRom } from '../rom/rom';
import { createOam, createScreen, expand2bpp, type Screen } from '../snes/ppu';

/** Title screen bundle: BG tiles + tilemaps in VRAM order (0x0000-0x37FF), then 16 palettes at +0x4000. */
const TITLE_BLOCK = 0x71996;
/** Character/cup select bundle: tilemaps, tiles and both screens' palettes. */
const SELECT_BLOCK = 0x70b29;
/** Menu sprite font, cursor and icons (2bpp, 256 tiles). */
const MENU_OBJ_BLOCK = 0x70000;

export class MenuAssets {
  private title: Uint8Array;
  private select: Uint8Array;
  readonly menuObj: Uint8Array;

  constructor(readonly rom: SmkRom) {
    if (rom.region !== 'US') throw new Error('As telas originais só foram mapeadas na ROM americana.');
    this.title = decompress(rom.data, TITLE_BLOCK);
    this.select = decompress(rom.data, SELECT_BLOCK);
    this.menuObj = decompress(rom.data, MENU_OBJ_BLOCK);
  }

  /** Title screen: BG1 logo, BG2 scrolling hills (64x32), BG3 = black layer shown through the menu box. */
  titleScreen(): Screen {
    const s = createScreen();
    s.vram.set(this.title.subarray(0, 0x3800), 0);
    // BG3: one solid tile (color 1) everywhere, palette 7 -> black.
    for (let r = 0; r < 8; r++) s.vram[0x4000 + r * 2] = 0xff;
    for (let i = 0; i < 1024; i++) { s.vram[0x3800 + i * 2] = 0x00; s.vram[0x3800 + i * 2 + 1] = 0x1c; }
    // Sprites: menu font/cursor at 0x8000.
    expand2bpp(this.menuObj, s.vram, 0x8000);
    s.cgram = palettes(this.title, 0x4000);
    s.mode = 1;
    s.layers[0] = { map: 0x2000, chr: 0x0000, size: 0, h: 0, v: 0, enabled: true };
    s.layers[1] = { map: 0x2800, chr: 0x0000, size: 1, h: 0, v: 0, enabled: true };
    s.layers[2] = { map: 0x3800, chr: 0x4000, size: 0, h: 0, v: 0, enabled: true };
    s.oam = createOam();
    s.obsel = 0x02;
    return s;
  }

  /** Character select: the 8 TVs (mode 0, four 2bpp layers). BG2 scrolls the LED sign. */
  selectScreen(): Screen {
    const s = createScreen();
    const d = this.select;
    s.vram.set(d.subarray(0x0000, 0x0800), 0x4800); // BG1 map: frame, TV boxes, 1P markers
    s.vram.set(d.subarray(0x0800, 0x1000), 0x5000); // BG2 map: LED sign
    s.vram.set(d.subarray(0x1800, 0x2000), 0x5800); // BG3 map
    s.vram.set(d.subarray(0x2a00, 0x2f00), 0x6000); // 2bpp tiles shared by all four layers (rest stays empty)
    // BG4: the checkered backdrop and the TV screens (sky/grass); built from its repeating pattern.
    buildSelectBackdrop(s.vram);
    // Sprites: the menu font (for the online players' tags), where the title screen has it.
    expand2bpp(this.menuObj, s.vram, 0x8000);
    s.cgram = palettes(d, 0x2800);
    s.mode = 0;
    s.layers[0] = { map: 0x4800, chr: 0x6000, size: 0, h: 0, v: 0, enabled: true };
    s.layers[1] = { map: 0x5000, chr: 0x6000, size: 0, h: 0, v: 0, enabled: true };
    s.layers[2] = { map: 0x5800, chr: 0x6000, size: 0, h: 0, v: 0, enabled: true };
    s.layers[3] = { map: 0x7000, chr: 0x6000, size: 0, h: 0, v: 0, enabled: true };
    s.oam = createOam();
    s.obsel = 0x02;
    return s;
  }

  /** Cup select: mode 1, BG1 (frame + big font) built by code, sprites for the border icons and title. */
  cupScreen(): Screen {
    const s = createScreen();
    expand2bpp(this.select.subarray(0x3900, 0x3f00), s.vram, 0x0000); // tiles 0x00-0x5F: big font, cups
    expand2bpp(this.menuObj.subarray(0x200), s.vram, 0x60 * 32); // tiles 0x60-: menu graphics
    s.cgram = palettes(this.select, 0x3700);
    s.mode = 1;
    s.layers[0] = { map: 0x4800, chr: 0x0000, size: 0, h: 0, v: 0, enabled: true };
    s.oam = createOam();
    s.obsel = 0x00;
    return s;
  }
}

function palettes(block: Uint8Array, at: number): Uint16Array {
  return new Uint16Array(256).map((_, i) => block[at + i * 2] | (block[at + i * 2 + 1] << 8));
}

/** Character select BG4 map (VRAM 0x7000): checkered tile pattern; TV screens are drawn on BG3/BG1. */
function buildSelectBackdrop(vram: Uint8Array) {
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const e = 0x3014; // tile 0x14, palette 4, priority set: the gray checkered backdrop
      vram[0x7000 + (y * 32 + x) * 2] = e & 0xff;
      vram[0x7000 + (y * 32 + x) * 2 + 1] = e >> 8;
    }
  }
}
