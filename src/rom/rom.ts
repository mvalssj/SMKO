// Reads track data out of a Super Mario Kart (SNES) ROM supplied by the user.
// Offsets and data layouts follow the Epic Edit project's documentation of the original ROM.
// Nothing from the ROM is ever bundled or sent to the server.

import { decompress } from './decompress';
import { ITEM_KINDS, type ItemOdds } from '../../shared/protocol';

export const TRACK_COUNT = 24; // 20 GP + 4 battle
export const GP_TRACK_COUNT = 20;
export const THEME_COUNT = 8;
export const MAP_SIZE = 128; // tiles
export const TILE = 8; // px
export const MAP_PX = MAP_SIZE * TILE; // 1024

export type Region = 'JP' | 'US' | 'EU';

const REGION_OFFSET = 0xffd9;

interface RegionOffsets {
  trackMapsPtr: number;
  itemIconTileLayout: number;
  commonTilesetUpperByte: number;
  battleTrackOrder: number;
  battleTrackStartPositions: number;
  roadTilesetHack1: number;
  aiFirstAddressByte: number;
  aiAreas: number;
  overlayPatterns: number;
}

const REGION_OFFSETS: Record<Region, RegionOffsets> = {
  JP: {
    trackMapsPtr: 0x1e74d,
    itemIconTileLayout: 0x1b1dc,
    commonTilesetUpperByte: 0x1e6c1,
    battleTrackOrder: 0x1c022,
    battleTrackStartPositions: 0x18b5f,
    roadTilesetHack1: 0x1e695,
    aiFirstAddressByte: 0x1fbc4,
    aiAreas: 0x1ff8c,
    overlayPatterns: 0x4f0b5,
  },
  US: {
    trackMapsPtr: 0x1e749,
    itemIconTileLayout: 0x1b320,
    commonTilesetUpperByte: 0x1e6bd,
    battleTrackOrder: 0x1c15c,
    battleTrackStartPositions: 0x18b4b,
    roadTilesetHack1: 0x1e691,
    aiFirstAddressByte: 0x1fbd3,
    aiAreas: 0x1ff9b,
    overlayPatterns: 0x4f23d,
  },
  EU: {
    trackMapsPtr: 0x1e738,
    itemIconTileLayout: 0x1b1bc,
    commonTilesetUpperByte: 0x1e6ac,
    battleTrackOrder: 0x1bff8,
    battleTrackStartPositions: 0x18b64,
    roadTilesetHack1: 0x1e680,
    aiFirstAddressByte: 0x1fb9d,
    aiAreas: 0x1ff6d,
    overlayPatterns: 0x4f159,
  },
};

const TILE_GENRES = 0x7fdba;
const TRACK_LAP_LINES = 0x180d4;
const TRACK_OBJECTS = 0x5c800;
const ITEM_ICON_GRAPHICS = 0x112f8;
const ITEM_GRAPHICS = 0x40594;
// Per-track overlay tiles (zippers, item boxes, coins, oil...) drawn over the base map: 128 bytes per track.
const TRACK_OVERLAY_ITEMS = 0x5d000;
const OVERLAY_PATTERN_COUNT = 56;
// Pattern -> size index; the ROM only stores this per placed overlay, Epic Edit hardcodes it the same way.
const OVERLAY_PATTERN_SIZES = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1];
// GP start position records are not stored in track order.
const GP_START_REORDER = [14, 10, 7, 8, 15, 19, 16, 4, 17, 13, 6, 12, 11, 5, 18, 9, 2, 3, 1, 0];

// Names in cup order (the ROM stores them in a custom text encoding; not worth decoding for this).
const GP_NAMES = [
  'Mario Circuit 1', 'Donut Plains 1', 'Ghost Valley 1', 'Bowser Castle 1', 'Mario Circuit 2',
  'Choco Island 1', 'Ghost Valley 2', 'Donut Plains 2', 'Bowser Castle 2', 'Mario Circuit 3',
  'Koopa Beach 1', 'Choco Island 2', 'Vanilla Lake 1', 'Bowser Castle 3', 'Mario Circuit 4',
  'Donut Plains 3', 'Koopa Beach 2', 'Ghost Valley 3', 'Vanilla Lake 2', 'Rainbow Road',
];
const BATTLE_NAMES = ['Battle Course 1', 'Battle Course 2', 'Battle Course 3', 'Battle Course 4'];
export const CUP_NAMES = ['Mushroom Cup', 'Flower Cup', 'Star Cup', 'Special Cup'];

/** Road tile genres (terrain types), as stored in the ROM. */
export const Genre = {
  JumpBar: 0x10,
  BumpEdge: 0x12,
  ItemBlock: 0x14,
  Zipper: 0x16,
  OilSlick: 0x18,
  Coin: 0x1a,
  Bump: 0x1c,
  WoodPlank: 0x1e,
  Empty: 0x20,
  Water: 0x22,
  Lava: 0x24,
  OutOfBounds: 0x26,
  EmptyBorder: 0x28,
  Road: 0x40,
  PlankJunction: 0x42,
  BrickRoad: 0x44,
  Clay: 0x46,
  WetSand: 0x48,
  SoftSand: 0x4a,
  RoughClay: 0x4c,
  FlatSurface: 0x4e,
  Bridge: 0x50,
  SlipperyRoad: 0x52,
  Sand: 0x54,
  OffRoad: 0x56,
  Snow: 0x58,
  Grass: 0x5a,
  ShallowWater: 0x5c,
  Mud: 0x5e,
  SolidBlock: 0x80,
  FrailBlock: 0x82,
  IceBlock: 0x84,
} as const;

export interface TrackInfo {
  /** Index of the track inside the ROM tables. */
  index: number;
  name: string;
  /** Cup index 0-3, or 4 for battle courses. */
  cup: number;
  battle: boolean;
}

export interface StartPosition {
  x: number;
  y: number;
  secondRowOffset: number;
}

export interface LapLine {
  x: number;
  y: number;
  length: number;
}

export const AiShape = { Rectangle: 0, TriangleTopLeft: 2, TriangleTopRight: 4, TriangleBottomRight: 6, TriangleBottomLeft: 8 } as const;

/**
 * SMK AI data: while a kart is inside area i, it steers toward target i.
 * Areas are listed in driving order. x/y/w/h are in tiles (top-left corner); target is in pixels.
 */
export interface AiArea {
  shape: number;
  x: number;
  y: number;
  w: number;
  h: number;
  target: { x: number; y: number };
}

export function aiAreaContains(a: AiArea, px: number, py: number): boolean {
  const tx = Math.floor(px / TILE) - a.x;
  const ty = Math.floor(py / TILE) - a.y;
  if (tx < 0 || ty < 0 || tx >= a.w || ty >= a.h) return false;
  const last = a.w - 1;
  switch (a.shape) {
    case AiShape.TriangleTopLeft: return tx + ty <= last;
    case AiShape.TriangleTopRight: return (last - tx) + ty <= last;
    case AiShape.TriangleBottomRight: return (last - tx) + (last - ty) <= last;
    case AiShape.TriangleBottomLeft: return tx + (last - ty) <= last;
    default: return true;
  }
}

/** Parallax scenery above the horizon: two 24px-tall layers that wrap around 360 degrees. */
export interface Background {
  /** 1024 x 24 RGBA, transparent where the back layer shows through. */
  front: Uint8Array;
  /** 512 x 24 RGBA, transparent where the sky shows through. */
  back: Uint8Array;
}

export const BG_HEIGHT = 24;
export const BG_FRONT_W = 1024;
export const BG_BACK_W = 512;

export type ObjectKind = 'pillar' | 'pipe' | 'thwomp' | 'mole' | 'plant' | 'fish';

export interface TrackObject {
  kind: ObjectKind;
  /** Center, in pixels. */
  x: number;
  y: number;
}

export interface Track {
  info: TrackInfo;
  theme: number;
  /** 1024x1024 RGBA pixels of the whole track floor. */
  pixels: Uint8Array;
  /** 128x128 terrain genre per tile. */
  genres: Uint8Array;
  /** Color behind/outside the track. */
  backColor: [number, number, number];
  /** 8x8 RGBA tile the SNES repeats outside the 1024x1024 map (Mode 7 "fill with character 0"). */
  fill: Uint8Array;
  background: Background;
  /** The theme's 256 colors (16 palettes); palettes 8-15 are used by sprites. */
  colors: [number, number, number][];
  start: StartPosition | null;
  lapLine: LapLine | null;
  /** Pipes, Thwomps, moles, piranha plants, fish (GP tracks only). */
  objects: TrackObject[];
  /** 16x16 object sprite; two frames on Rainbow Road, where the Thwomps flash. */
  objectFrames: SpriteFrame[];
  /** AI areas, in driving order. Used for race position and (later) CPU karts. */
  ai: AiArea[];
  /** AI targets in pixels, same order as `ai`. */
  path: { x: number; y: number }[];
}

export class SmkRom {
  readonly data: Uint8Array;
  readonly region: Region;
  readonly crc: number;
  readonly tracks: TrackInfo[];
  private readonly offs: RegionOffsets;
  private readonly trackMaps: number;
  private readonly themeCache = new Map<number, ThemeData>();

  constructor(file: Uint8Array) {
    // Strip a 512-byte copier header if present.
    this.data = file.length % 1024 === 512 ? file.slice(512) : file;
    if (this.data.length < 0x80000) throw new Error('Arquivo muito pequeno para ser uma ROM do Super Mario Kart.');

    const title = String.fromCharCode(...this.data.slice(0xffc0, 0xffd5)).trim();
    if (!title.toUpperCase().replace(/\s/g, '').includes('MARIOKART')) {
      throw new Error(`Esta ROM não parece ser o Super Mario Kart (título interno: "${title}").`);
    }

    const regionByte = this.data[REGION_OFFSET];
    const region = (['JP', 'US', 'EU'] as const)[regionByte];
    if (!region) throw new Error(`Região desconhecida (byte 0x${regionByte.toString(16)}).`);
    this.region = region;
    this.offs = REGION_OFFSETS[region];
    this.crc = crc32(this.data);

    this.trackMaps = this.ptr(this.offs.trackMapsPtr);
    this.checkUnmodified();
    this.tracks = this.readTrackList();
  }

  /** 3-byte little-endian ROM pointer (HiROM bank $Cx), masked to a file offset. */
  private ptr(at: number): number {
    const d = this.data;
    return ((d[at + 2] & 0xf) << 16) + (d[at + 1] << 8) + d[at];
  }

  private get themeRoadGfx() { return this.trackMaps + TRACK_COUNT * 3; }
  private get themePalettes() { return this.themeRoadGfx + THEME_COUNT * 3; }
  // Palettes, object graphics, background graphics, background layouts: one 3-byte pointer per theme each.
  private get themeBackgroundLayouts() { return this.themePalettes + THEME_COUNT * 3 * 3; }
  private get trackObjectGraphics() { return this.themePalettes + THEME_COUNT * 3; }
  private get themeBackgroundGraphics() { return this.themePalettes + THEME_COUNT * 3 * 2; }
  private get gpTrackOrder() { return this.themeBackgroundLayouts + THEME_COUNT * 3; }
  private get trackThemes() { return this.gpTrackOrder + GP_TRACK_COUNT; }
  private get tileGenreIndexes() { return this.trackMaps - THEME_COUNT * 2; }

  private checkUnmodified() {
    const d = this.data;
    const h1 = this.offs.roadTilesetHack1;
    const h2 = h1 + 0x28;
    const h3 = h2 + 0x38;
    const h4 = h3 + 0x92;
    const original = d[h1] === 0xa9 && d[h2] === 0xa0 && d[h3] === 0xc0 && d[h4] === 0x30;
    const genreLoad = this.offs.commonTilesetUpperByte + 0x454;
    const genresOriginal =
      d[genreLoad] === 0xa0 && d[genreLoad + 1] === 0xba && d[genreLoad + 2] === 0xfd && d[genreLoad + 3] === 0xa9;
    if (!original || !genresOriginal) {
      throw new Error('Esta ROM foi modificada por um editor (Epic Edit/MAKE). Use a ROM original.');
    }
  }

  private readTrackList(): TrackInfo[] {
    const list: TrackInfo[] = [];
    for (let i = 0; i < GP_TRACK_COUNT; i++) {
      list.push({ index: this.data[this.gpTrackOrder + i], name: GP_NAMES[i], cup: Math.floor(i / 5), battle: false });
    }
    for (let i = 0; i < 4; i++) {
      list.push({ index: this.data[this.offs.battleTrackOrder + i], name: BATTLE_NAMES[i], cup: 4, battle: true });
    }
    return list;
  }

  loadTrack(info: TrackInfo): Track {
    const d = this.data;
    const i = info.index;
    const theme = d[this.trackThemes + i] >> 1;
    const themeData = this.loadTheme(theme);

    const mapOffset = this.ptr(this.trackMaps + i * 3);
    const map = decompress(decompress(d, mapOffset));
    if (map.length < MAP_SIZE * MAP_SIZE) throw new Error(`Mapa da pista ${info.name} incompleto (${map.length} bytes).`);
    this.applyOverlays(map, i);

    const pixels = new Uint8Array(MAP_PX * MAP_PX * 4);
    const genres = new Uint8Array(MAP_SIZE * MAP_SIZE);
    for (let ty = 0; ty < MAP_SIZE; ty++) {
      for (let tx = 0; tx < MAP_SIZE; tx++) {
        const tile = map[ty * MAP_SIZE + tx];
        genres[ty * MAP_SIZE + tx] = themeData.genres[tile];
        const src = themeData.tilePixels[tile];
        for (let py = 0; py < TILE; py++) {
          const row = ((ty * TILE + py) * MAP_PX + tx * TILE) * 4;
          pixels.set(src.subarray(py * TILE * 4, (py + 1) * TILE * 4), row);
        }
      }
    }

    const ai = this.loadAi(i);
    let start: StartPosition | null = null;
    let lapLine: LapLine | null = null;
    if (!info.battle) {
      const s = this.offs.battleTrackStartPositions + 0xc8 + GP_START_REORDER[i] * 8;
      start = {
        x: d[s] | (d[s + 1] << 8),
        y: d[s + 2] | (d[s + 3] << 8),
        secondRowOffset: d[s + 5] === 0 ? d[s + 4] : d[s + 4] - 256,
      };
      const l = TRACK_LAP_LINES + i * 6;
      lapLine = {
        y: ((d[l + 1] & 0x03) << 8) + d[l],
        x: (d[l + 2] & 0x3f) * 16,
        length: (d[l + 4] & 0x3f) * 16,
      };
    }

    return {
      info,
      theme,
      pixels,
      genres,
      backColor: themeData.backColor,
      fill: themeData.tilePixels[0],
      background: themeData.background,
      colors: themeData.colors,
      start,
      lapLine,
      ai,
      path: ai.map((a) => a.target),
      ...this.loadObjects(info, theme, themeData.colors),
    };
  }

  private loadObjects(info: TrackInfo, theme: number, colors: [number, number, number][]): { objects: TrackObject[]; objectFrames: SpriteFrame[] } {
    if (info.battle) return { objects: [], objectFrames: [] };
    const d = this.data;
    // Object type and palette per theme (the ROM only stores these in code; same table as Epic Edit).
    // Donut Plains 1 is the exception: orange pipes instead of moles.
    const isDp1 = info.index === 19;
    const kind: ObjectKind = isDp1 ? 'pipe' : (['pillar', 'pipe', 'mole', 'plant', 'pipe', 'fish', 'thwomp', 'thwomp'] as const)[theme];
    const palettes = isDp1 ? [5] : theme === 7 ? [1, 7] : [[7], [7], [7], [6], [7], [6], [4]][theme];
    // Graphics pointer per object tileset; Rainbow Road has its own Thwomp graphics.
    const gfxSlot = theme === 7 ? 7 : { pillar: 0, pipe: 1, mole: 2, plant: 3, fish: 5, thwomp: 6 }[kind];
    const gfx = decompress(d, this.ptr(this.trackObjectGraphics + gfxSlot * 3));
    // 16x16 frame: 4 tiles of the 16-tile-wide object sheet.
    const tiles = kind === 'plant' || kind === 'fish' ? [4, 5, 20, 21] : [32, 33, 48, 49];
    const objectFrames = palettes.map((p) => {
      const px = new Uint8Array(16 * 16 * 4);
      tiles.forEach((t, n) => {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const o = t * 32, bit = 7 - x;
            const ci = ((gfx[o + y * 2] >> bit) & 1) | (((gfx[o + y * 2 + 1] >> bit) & 1) << 1) |
              (((gfx[o + 16 + y * 2] >> bit) & 1) << 2) | (((gfx[o + 16 + y * 2 + 1] >> bit) & 1) << 3);
            if (!ci) continue;
            const c = colors[(8 + p) * 16 + ci];
            const q = (((n >> 1) * 8 + y) * 16 + (n & 1) * 8 + x) * 4;
            px[q] = c[0]; px[q + 1] = c[1]; px[q + 2] = c[2]; px[q + 3] = 255;
          }
        }
      });
      return { w: 16, h: 16, pixels: px };
    });

    // 16 regular objects, 2 bytes each (tile coordinates); unused slots are 0,0.
    const objects: TrackObject[] = [];
    const base = TRACK_OBJECTS + info.index * 64;
    for (let i = 0; i < 16; i++) {
      const a = d[base + i * 2], b = d[base + i * 2 + 1];
      const tx = a & 0x7f, ty = ((b & 0x3f) << 1) | (a >> 7);
      if (tx === 0 && ty === 0) continue;
      // Same anchor as Epic Edit: 4px right of the tile corner, on the tile row line.
      objects.push({ kind, x: tx * TILE + TILE / 2, y: ty * TILE });
    }
    return { objects, objectFrames };
  }

  private applyOverlays(map: Uint8Array, trackIndex: number) {
    const d = this.data;
    const patternTable = this.offs.overlayPatterns;
    const sizeTable = patternTable + 0x147;
    for (let n = 0; n < 41; n++) {
      const o = TRACK_OVERLAY_ITEMS + trackIndex * 128 + n * 3;
      if (d[o + 1] === 0xff && d[o + 2] === 0xff) break;
      const sizeIndex = d[o] >> 6;
      const pattern = d[o] & 0x3f;
      if (pattern >= OVERLAY_PATTERN_COUNT || OVERLAY_PATTERN_SIZES[pattern] !== sizeIndex) continue;
      const w = d[sizeTable + sizeIndex * 2];
      const h = d[sizeTable + sizeIndex * 2 + 1];
      const x = d[o + 1] & 0x7f;
      const y = ((d[o + 2] & 0x3f) << 1) | (d[o + 1] >> 7);
      const data = (d[patternTable + pattern * 2 + 1] << 8) + d[patternTable + pattern * 2] + 0x40000;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const tile = d[data + py * w + px];
          if (tile === 0xff || x + px >= MAP_SIZE || y + py >= MAP_SIZE) continue;
          map[(y + py) * MAP_SIZE + x + px] = tile;
        }
      }
    }
  }

  private loadAi(trackIndex: number): AiArea[] {
    const d = this.data;
    const base = d[this.offs.aiFirstAddressByte];
    const areasTable = this.offs.aiAreas;
    const targetsTable = areasTable + 0x30;
    const areaOffset = ((base & 0xf) << 16) + (d[areasTable + trackIndex * 2 + 1] << 8) + d[areasTable + trackIndex * 2];
    const targetOffset = ((base & 0xf) << 16) + (d[targetsTable + trackIndex * 2 + 1] << 8) + d[targetsTable + trackIndex * 2];

    const areas: AiArea[] = [];
    let p = areaOffset;
    for (let t = targetOffset; d[p] !== 0xff; t += 3) {
      const shape = d[p];
      // Area coordinates are stored in 2-tile units.
      let x = d[p + 1] * 2, y = d[p + 2] * 2, w: number, h: number;
      if (shape === AiShape.Rectangle) {
        w = d[p + 3] * 2; h = d[p + 4] * 2; p += 5;
      } else {
        // Triangles store the position of their right angle; convert to the top-left corner.
        w = h = d[p + 3] * 2; p += 4;
        if (shape === AiShape.TriangleTopRight || shape === AiShape.TriangleBottomRight) x -= w - 2;
        if (shape === AiShape.TriangleBottomRight || shape === AiShape.TriangleBottomLeft) y -= h - 2;
      }
      areas.push({ shape, x, y, w, h, target: { x: d[t] * TILE + TILE / 2, y: d[t + 1] * TILE + TILE / 2 } });
    }
    return areas;
  }

  private loadTheme(theme: number): ThemeData {
    const cached = this.themeCache.get(theme);
    if (cached) return cached;

    const d = this.data;
    const paletteData = decompress(d, this.ptr(this.themePalettes + theme * 3)).subarray(0, 512);
    const colors: [number, number, number][] = [];
    for (let c = 0; c < 256; c++) {
      const lo = paletteData[c * 2] ?? 0;
      const hi = paletteData[c * 2 + 1] ?? 0;
      const bgr = lo | (hi << 8);
      colors.push([expand5(bgr & 0x1f), expand5((bgr >> 5) & 0x1f), expand5((bgr >> 10) & 0x1f)]);
    }

    // Road tileset: 192 theme tiles + 64 tiles common to every theme.
    // Each block = 256 palette bytes (high nibble) followed by 4bpp tiles (32 bytes each).
    const themeTiles = decompress(d, this.ptr(this.themeRoadGfx + theme * 3));
    const commonUpper = this.offs.commonTilesetUpperByte;
    const commonLower = commonUpper + 3;
    const commonOffset = ((d[commonUpper] & 0xf) << 16) + (d[commonLower + 1] << 8) + d[commonLower];
    const commonTiles = decompress(d, commonOffset);

    const genreData = decompress(d, TILE_GENRES);
    const gi = this.tileGenreIndexes + theme * 2;
    const themeGenreStart = d[gi] | (d[gi + 1] << 8);
    const themeTileCount = Math.floor((themeTiles.length - 256) / 32);

    const tilePixels: Uint8Array[] = [];
    const genres = new Uint8Array(256);
    for (let t = 0; t < 256; t++) {
      let block: Uint8Array | null;
      let local: number;
      if (t < 192) {
        block = t < themeTileCount ? themeTiles : null;
        local = t;
        genres[t] = t < themeTileCount ? genreData[themeGenreStart + t] : Genre.Road;
      } else {
        block = commonTiles;
        local = t - 192;
        genres[t] = genreData[local];
      }

      const px = new Uint8Array(TILE * TILE * 4);
      if (block) {
        const palette = block[local] >> 4;
        const gfx = 256 + local * 32;
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) {
            const byte = block[gfx + y * 4 + (x >> 1)];
            const ci = x & 1 ? byte >> 4 : byte & 0x0f;
            // Color 0 of every road palette shows the backdrop color.
            const color = ci === 0 ? colors[0] : colors[palette * 16 + ci];
            const p = (y * TILE + x) * 4;
            px[p] = color[0];
            px[p + 1] = color[1];
            px[p + 2] = color[2];
            px[p + 3] = 255;
          }
        }
      }
      tilePixels.push(px);
    }

    const background = this.loadBackground(theme, colors);
    const result: ThemeData = { tilePixels, genres, backColor: colors[0], colors, background };
    this.themeCache.set(theme, result);
    return result;
  }

  private loadBackground(theme: number, colors: [number, number, number][]): Background {
    const d = this.data;
    const gfx = decompress(d, this.ptr(this.themeBackgroundGraphics + theme * 3));
    const layout = decompress(d, this.ptr(this.themeBackgroundLayouts + theme * 3));
    const render = (front: boolean): Uint8Array => {
      const width = front ? BG_FRONT_W : BG_BACK_W;
      const rowBytes = width / 4; // 2 bytes per 8px tile
      const layerStart = front ? 0 : 1024;
      const out = new Uint8Array(width * BG_HEIGHT * 4);
      // Rows are stored in 64-byte blocks interleaved across the 4 rows; row 0 is unused.
      for (let row = 0; row < 3; row++) {
        for (let tx = 0; tx < width / 8; tx++) {
          const byteInRow = tx * 2;
          const at = layerStart + (row + 1) * 64 + Math.floor(byteInRow / 64) * 256 + (byteInRow % 64);
          if (byteInRow >= rowBytes) continue;
          const tile = layout[at];
          const props = layout[at + 1] & 0xdf;
          const palette = ((props & 0x30) >> 4) + (front ? 4 : 6);
          const sub = props & 0x0c;
          const flipX = (props & 0x40) !== 0, flipY = (props & 0x80) !== 0;
          for (let y = 0; y < 8; y++) {
            const gy = flipY ? 7 - y : y;
            const lo = gfx[tile * 16 + gy * 2] ?? 0, hi = gfx[tile * 16 + gy * 2 + 1] ?? 0;
            for (let x = 0; x < 8; x++) {
              const bit = flipX ? x : 7 - x;
              const ci = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
              if (ci === 0) continue;
              const c = colors[palette * 16 + sub + ci];
              const p = ((row * 8 + y) * width + tx * 8 + x) * 4;
              out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = 255;
            }
          }
        }
      }
      return out;
    };
    return { front: render(true), back: render(false) };
  }

  /** Grand Prix points per finishing place (8 entries). */
  rankPoints(): number[] {
    const at = { JP: 0x5be52, US: 0x5beb4, EU: 0x5bebc }[this.region];
    return [...Array(8).keys()].map((i) => this.data[at + i * 2]);
  }

  /** Original item chances for a GP track. */
  itemOdds(info: TrackInfo): ItemOdds {
    const d = this.data;
    const table = this.offs.itemIconTileLayout + 0x1c3;
    const setIndexes = this.offs.battleTrackStartPositions + 0x28;
    const set = [1, 0, 2, 4, 6, 5, 3][d[setIndexes + info.index] >> 1] ?? 0;
    // 9-byte entries: 8 cumulative thresholds (0 = item absent), the remainder up to 32 is Lightning.
    const read = (cond: number) => {
      const e = table + (21 + set * 3 + cond) * 9;
      const w: number[] = [];
      let prev = 0;
      for (let k = 0; k < 8; k++) {
        const v = d[e + k];
        w.push(v === 0 ? 0 : v - prev);
        if (v) prev = v;
      }
      w.push(32 - prev);
      return w;
    };
    return { middle: read(0), leader: read(1), back: read(2) };
  }

  /** HUD item icons and the shell sprites, colored with a track's palettes. */
  loadItemGraphics(colors: [number, number, number][]): ItemGraphics {
    const d = this.data;
    const iconGfx = decompress(d, ITEM_ICON_GRAPHICS);
    const icons = ITEM_KINDS.map((_, i) => {
      const at = this.offs.itemIconTileLayout + i * 2;
      const first = d[at] & 0x7f, props = d[at + 1];
      const palette = (props & 0x30) >> 4, sub = props & 0x0c;
      const px = new Uint8Array(16 * 16 * 4);
      for (let n = 0; n < 4; n++) {
        const o = (first + n) * 16;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const bit = 7 - x;
            const ci = ((iconGfx[o + y * 2] >> bit) & 1) | (((iconGfx[o + y * 2 + 1] >> bit) & 1) << 1);
            if (!ci) continue;
            const c = colors[palette * 16 + sub + ci];
            const q = (((n >> 1) * 8 + y) * 16 + (n & 1) * 8 + x) * 4;
            px[q] = c[0]; px[q + 1] = c[1]; px[q + 2] = c[2]; px[q + 3] = 255;
          }
        }
      }
      return { w: 16, h: 16, pixels: px };
    });
    const itemGfx = decompress(d, ITEM_GRAPHICS);
    const shell = (palette: number) => sheetFrame(itemGfx, [22, 23, 38, 39], colors, palette);
    return { icons, greenShell: shell(14), redShell: shell(13) };
  }

  /** Driver sprite frames for one character, colored with a track's palettes. Null if unsupported. */
  loadDriverSprites(character: number, colors: [number, number, number][]): DriverSprites | null {
    if (this.region !== 'US') return null; // frame tables only mapped for the US ROM so far
    const d = this.data;
    const ch = CHARACTERS[character];
    const pal = ch.palette * 16;
    const rows: SpriteFrame[][] = [];
    for (let r = 0; r < DRIVER_DISTANCE_ROWS; r++) {
      const row: SpriteFrame[] = [];
      for (let slot = 0; slot < 16; slot++) {
        const e = DRIVER_ANGLE_TABLE + (r * 16 + slot) * 2;
        const frame = d[e] >> 1;
        const flags = d[e + 1];
        const addr = ch.sheet + (d[DRIVER_FRAME_TABLE + frame * 2] | (d[DRIVER_FRAME_TABLE + frame * 2 + 1] << 8)) - 0x2000;
        const w = (flags >> 4) * 4;
        const h = (flags & 0x0f) * 8;
        // 16x32 back/front views store one half of a symmetric 32x32 sprite.
        const mirrored = flags === 0x44;
        const outW = mirrored ? w * 2 : w;
        const px = new Uint8Array(outW * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const t = addr + (y >> 3) * 512 + (x >> 3) * 32;
            const ty = y & 7, bit = 7 - (x & 7);
            const ci = ((d[t + ty * 2] >> bit) & 1) | (((d[t + ty * 2 + 1] >> bit) & 1) << 1) |
              (((d[t + 16 + ty * 2] >> bit) & 1) << 2) | (((d[t + 16 + ty * 2 + 1] >> bit) & 1) << 3);
            if (ci === 0) continue;
            const c = colors[pal + ci];
            for (const ox of mirrored ? [x, outW - 1 - x] : [x]) {
              const p = (y * outW + ox) * 4;
              px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
            }
          }
        }
        row.push({ w: outW, h, pixels: px });
      }
      rows.push(row);
    }
    return { rows };
  }
}

export interface SpriteFrame {
  w: number;
  h: number;
  pixels: Uint8Array;
}

/** rows[distance][angle]: distance 0 = nearest/largest; angle 0 = seen from behind ... 15 = from the front, kart turned right. */
export interface DriverSprites {
  rows: SpriteFrame[][];
}

export interface ItemGraphics {
  /** 16x16 HUD icon per ITEM_KINDS entry. */
  icons: SpriteFrame[];
  greenShell: SpriteFrame;
  redShell: SpriteFrame;
}

/** Characters in Super Mario Kart order. Sheet = ROM offset of the 4bpp frame sheet; palette = sprite palette. */
export const CHARACTERS = [
  { name: 'Mario', sheet: 0x02000, palette: 9 },
  { name: 'Luigi', sheet: 0x02000, palette: 10 },
  { name: 'Bowser', sheet: 0x12000, palette: 8 },
  { name: 'Peach', sheet: 0x22000, palette: 11 },
  { name: 'DK Jr.', sheet: 0x32000, palette: 11 },
  { name: 'Koopa', sheet: 0x52000, palette: 10 },
  { name: 'Toad', sheet: 0x62000, palette: 9 },
  { name: 'Yoshi', sheet: 0x42000, palette: 8 },
] as const;

// Driver frame tables (US ROM): 2-byte entries (frame*2, size flags) for 11 distances x 16 angles,
// then the address of every frame inside a character's sheet (16 tiles wide).
const DRIVER_ANGLE_TABLE = 0x9090;
const DRIVER_FRAME_TABLE = 0x91fa;
export const DRIVER_DISTANCE_ROWS = 11;

interface ThemeData {
  tilePixels: Uint8Array[];
  genres: Uint8Array;
  backColor: [number, number, number];
  colors: [number, number, number][];
  background: Background;
}

/** 16x16 sprite from four 4bpp tiles (TL, TR, BL, BR) of a 16-tile-wide sheet. */
function sheetFrame(gfx: Uint8Array, tiles: number[], colors: [number, number, number][], palette: number): SpriteFrame {
  const px = new Uint8Array(16 * 16 * 4);
  tiles.forEach((t, n) => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const o = t * 32, bit = 7 - x;
        const ci = ((gfx[o + y * 2] >> bit) & 1) | (((gfx[o + y * 2 + 1] >> bit) & 1) << 1) |
          (((gfx[o + 16 + y * 2] >> bit) & 1) << 2) | (((gfx[o + 16 + y * 2 + 1] >> bit) & 1) << 3);
        if (!ci) continue;
        const c = colors[palette * 16 + ci];
        const q = (((n >> 1) * 8 + y) * 16 + (n & 1) * 8 + x) * 4;
        px[q] = c[0]; px[q + 1] = c[1]; px[q + 2] = c[2]; px[q + 3] = 255;
      }
    }
  });
  return { w: 16, h: 16, pixels: px };
}

function expand5(v: number): number {
  return (v << 3) | (v >> 2);
}

export function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
