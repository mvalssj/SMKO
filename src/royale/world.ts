// Battle Royale world: every course of the game (the 20 GP tracks and the 4 battle courses) on one open map,
// grouped in regions by their land (shared/royale.ts: WORLD_REGIONS, WORLD_LAYOUT): the ice courses side by
// side, the beach ones, the castles... Inside a region the courses join with no border: the gaps between them
// are filled with the region's own ground (grass, snow, chocolate), the fences at their edges taken down;
// where that ground is void, lava or deep water, a bridge of the region's own road (planks, bricks, sand)
// runs down the middle of the gap. Between regions, and only there, the gaps are Mario Circuit roads
// (red-and-white kerbs, striped asphalt: tile patterns copied from Mario Circuit 1 and 2), laid like the grout
// between tiles. Each course keeps its own tiles, terrain and objects; from every side but the world's edge a
// way is cut from the edge of the course map straight in to its track (through the fences, the void, the
// water...): Mario Circuit asphalt from a road, the course's own road from its region.
//
// The floor is kept as tile numbers into an atlas of all eight themes' road tiles (8 x 256 tiles of 8x8), the
// way the SNES builds its Mode 7 picture, so the world never needs one huge picture.

import { Genre, TILE, type AiArea, type SmkRom, type SpriteFrame, type Track, type TrackInfo, type TrackObject } from '../rom/rom';
import { terrainOf } from '../game/physics';
import {
  COURSE_TILES, GAP_TILES, GRID_COLS, GRID_ROWS, MARGIN_TILES, WORLD_COLS, WORLD_LAYOUT, WORLD_REGIONS, WORLD_ROWS, cellRegion,
} from '../../shared/royale';

/** Size of one course map, the gap between maps and the strip round the world (tiles): see shared/royale.ts. */
const COURSE = COURSE_TILES;
const GAP = GAP_TILES;
const MARGIN = MARGIN_TILES;

/** Road tile atlas: 8 themes x 256 tiles, 64 tiles a row. */
export const ATLAS_TILES_PER_ROW = 64;
export const ATLAS_W = ATLAS_TILES_PER_ROW * TILE;
export const ATLAS_H = ((8 * 256) / ATLAS_TILES_PER_ROW) * TILE;

/**
 * Mario Circuit road pieces (theme tile numbers). Straights repeat every 4 tiles, as in the original:
 * vertical (Mario Circuit 1's main straight): kerb 38/3C | asphalt 01/11 | kerb 3B/3F, by row;
 * horizontal (Mario Circuit 2's bottom straight): kerb 3A/3E, asphalt 01/11, kerb 39/3D, by column.
 */
const MC = {
  grass: 0x44,
  vertical: [[0x38, 0x01, 0x3b], [0x3c, 0x11, 0x3f]],
  horizontal: [[0x3a, 0x01, 0x39], [0x3e, 0x11, 0x3d]],
  /** Pipe fence round the outside (the four pieces Mario Circuit's fences cycle through). */
  fence: [0xf0, 0xf1, 0xf2, 0xf3],
};
/** Asphalt rows between the kerbs; a road is ROAD_W tiles wide in all. */
const ASPHALT = 8;
export const ROAD_W = ASPHALT + 2;
/** The 4-tile pattern phase: 0 1 1 0. */
const phase = (i: number) => [0, 1, 1, 0][i & 3];

export interface WorldRegion {
  /** Top-left tile of the course map in the world. */
  x0: number;
  y0: number;
  info: TrackInfo;
  theme: number;
  /** Its region (index into WORLD_REGIONS). */
  land: number;
}

export interface WorldFloor {
  cols: number;
  rows: number;
  /** Atlas tile per world tile (theme * 256 + tile). */
  ids: Uint16Array;
  /** Atlas picture (ATLAS_W x ATLAS_H RGBA). */
  atlas: Uint8Array;
  regions: WorldRegion[];
  /** Mario Circuit's theme (the roads, the grass, the sprites' palettes). */
  baseTheme: number;
  /** Per object: which frame set it uses; the sets are each course's object pictures. */
  objectSet: number[];
  objectSets: { frames: SpriteFrame[]; sizes: SpriteFrame[][] }[];
  /** Start positions spread over the whole world (on each course's racing line and on the roads). */
  spawns: { x: number; y: number; angle: number }[];
  /** Each theme's sky band and backdrop color (sky changes as you drive from course to course). */
  skies: Map<number, Pick<Track, 'background' | 'backColor'>>;
  /** Each course's AI data (the ROM's racing line), moved to its place in the world, in `regions` order (by row). */
  courses: { ai: AiArea[]; path: { x: number; y: number }[] }[];
}

export type WorldTrack = Track & { world: WorldFloor };

export function isWorld(t: Track): t is WorldTrack {
  return 'world' in t && !!(t as WorldTrack).world;
}

/** Builds the world from the ROM (all 24 courses). */
export function buildWorld(rom: SmkRom): WorldTrack {
  const mc1 = rom.loadTrack(rom.tracks[0]);
  const base = mc1.theme;

  const ids = new Uint16Array(WORLD_COLS * WORLD_ROWS);
  const genres = new Uint8Array(WORLD_COLS * WORLD_ROWS);
  const themes = new Map<number, ReturnType<SmkRom['loadTheme']>>();
  const theme = (t: number) => {
    let d = themes.get(t);
    if (!d) { d = rom.loadTheme(t); themes.set(t, d); }
    return d;
  };
  /**
   * Terrain of a theme's tile in the world. The green beyond a course's fences is "out of bounds" on the
   * course (nobody gets there); in the open world it is grass you can drive on, slowly, like any grass.
   */
  const worldGenres = new Map<number, Uint8Array>();
  const genreOf = (th: number, tile: number) => {
    let g = worldGenres.get(th);
    if (!g) {
      const d = theme(th);
      g = d.genres.map((genre, t) => {
        if (genre !== Genre.OutOfBounds && genre !== Genre.EmptyBorder) return genre;
        const p = d.tilePixels[t];
        let r = 0, gr = 0, b = 0;
        for (let i = 0; i < 64; i++) { r += p[i * 4]; gr += p[i * 4 + 1]; b += p[i * 4 + 2]; }
        return gr > r + 30 * 64 && gr > b + 30 * 64 ? Genre.Grass : genre;
      });
      worldGenres.set(th, g);
    }
    return g[tile];
  };
  const put = (x: number, y: number, th: number, tile: number) => {
    if (x < 0 || y < 0 || x >= WORLD_COLS || y >= WORLD_ROWS) return;
    ids[y * WORLD_COLS + x] = th * 256 + tile;
    genres[y * WORLD_COLS + x] = genreOf(th, tile);
  };

  // A pipe fence round the edge.
  for (let x = 0; x < WORLD_COLS; x++) { put(x, 0, base, MC.fence[(x >> 2) & 3]); put(x, WORLD_ROWS - 1, base, MC.fence[(x >> 2) & 3]); }
  for (let y = 0; y < WORLD_ROWS; y++) { put(0, y, base, MC.fence[(y >> 2) & 3]); put(WORLD_COLS - 1, y, base, MC.fence[(y >> 2) & 3]); }

  // The courses, each in its cell of the grid.
  const regions: WorldRegion[] = [];
  const tracks: Track[] = [];
  /** Each course's racing surface: the terrain under its racing line (asphalt, dirt, sand, planks...). */
  const surfaces: Set<number>[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const info = rom.tracks[WORLD_LAYOUT[r][c]];
      const t = info === mc1.info ? mc1 : rom.loadTrack(info);
      const x0 = MARGIN + c * (COURSE + GAP), y0 = MARGIN + r * (COURSE + GAP);
      for (let y = 0; y < COURSE; y++) for (let x = 0; x < COURSE; x++) put(x0 + x, y0 + y, t.theme, t.tiles[y * COURSE + x]);
      regions.push({ x0, y0, info, theme: t.theme, land: cellRegion(r, c) });
      tracks.push(t);
      const surface = new Set<number>();
      for (const p of t.path) {
        const g = t.genres[Math.floor(p.y / TILE) * COURSE + Math.floor(p.x / TILE)];
        const kind = terrainOf(g);
        if (kind !== 'wall' && kind !== 'fall' && g !== Genre.ItemBlock && g !== Genre.Coin) surface.add(g);
      }
      surfaces.push(surface);
    }
  }

  const terrain = (x: number, y: number) => terrainOf(genres[y * WORLD_COLS + x]);
  const drivable = (x: number, y: number) => terrain(x, y) === 'road';
  const onTrack = (reg: WorldRegion, x: number, y: number) => surfaces[regions.indexOf(reg)].has(genres[y * WORLD_COLS + x]);

  // Each region's ground (the commonest tile round its courses' edges, walls aside), whether you can drive
  // on it, and its road (the commonest under its racing lines) for the bridges.
  const commonest = (tiles: Iterable<number>, keep: (tile: number) => boolean) => {
    const count = new Map<number, number>();
    for (const v of tiles) if (keep(v)) count.set(v, (count.get(v) ?? 0) + 1);
    let best = 0, n = 0;
    for (const [v, k] of count) if (k > n) { n = k; best = v; }
    return best;
  };
  function* edgeTiles(t: Track) {
    for (let i = 0; i < COURSE; i++) {
      for (let d = 0; d < 2; d++) {
        yield t.tiles[d * COURSE + i];
        yield t.tiles[(COURSE - 1 - d) * COURSE + i];
        yield t.tiles[i * COURSE + d];
        yield t.tiles[i * COURSE + COURSE - 1 - d];
      }
    }
  }
  function* pathTiles(t: Track) {
    for (const p of t.path) yield t.tiles[Math.floor(p.y / TILE) * COURSE + Math.floor(p.x / TILE)];
  }
  const kindOf = (th: number, tile: number) => terrainOf(genreOf(th, tile));
  const isRoad = (th: number) => (tile: number) => {
    const k = kindOf(th, tile), g = genreOf(th, tile);
    return (k === 'road' || k === 'slow') && g !== Genre.ItemBlock && g !== Genre.Coin;
  };
  const lands = WORLD_REGIONS.map((_, land) => {
    const members = tracks.filter((_, i) => regions[i].land === land);
    const th = members[0].theme;
    const ground = commonest(members.flatMap((t) => [...edgeTiles(t)]), (tile) => kindOf(th, tile) !== 'wall');
    const kind = kindOf(th, ground);
    return { theme: th, ground, open: kind !== 'fall' && kind !== 'wall', road: commonest(members.flatMap((t) => [...pathTiles(t)]), isRoad(th)) };
  });
  /** Each course's own road, for the ways in from its region. */
  const ownRoad = tracks.map((t) => commonest(pathTiles(t), isRoad(t.theme)));

  /** Mario Circuit road pieces. */
  const horizontalRoad = (x: number, y: number) => {
    const p = MC.horizontal[phase(x)];
    put(x, y, base, p[0]);
    for (let i = 1; i <= ASPHALT; i++) put(x, y + i, base, p[1]);
    put(x, y + ASPHALT + 1, base, p[2]);
  };
  const verticalRoad = (x: number, y: number) => {
    const p = MC.vertical[phase(y)];
    put(x, y, base, p[0]);
    for (let i = 1; i <= ASPHALT; i++) put(x + i, y, base, p[1]);
    put(x + ASPHALT + 1, y, base, p[2]);
  };

  const sides = ['left', 'right', 'top', 'bottom'] as const;
  type Side = (typeof sides)[number];
  /**
   * How far a road coming in from a course map's side must be cut to reach the track (tiles), for a road
   * along `at` (its first tile row / column). Infinity if it never gets there.
   */
  const reach = (reg: WorldRegion, side: Side, at: number): number => {
    for (let d = 0; d < COURSE; d++) {
      let ok = 0;
      for (let i = 1; i <= ASPHALT; i++) {
        const [x, y] = sidePoint(reg, side, d, at + i);
        if (onTrack(reg, x, y)) ok++;
      }
      if (ok >= 6) return d;
    }
    return Infinity;
  };
  const sidePoint = (reg: WorldRegion, side: Side, d: number, along: number): [number, number] => {
    switch (side) {
      case 'left': return [reg.x0 + d, reg.y0 + along];
      case 'right': return [reg.x0 + COURSE - 1 - d, reg.y0 + along];
      case 'top': return [reg.x0 + along, reg.y0 + d];
      default: return [reg.x0 + along, reg.y0 + COURSE - 1 - d];
    }
  };

  // The gaps. A world column (or row) is either in a column of courses or in the gap after one (k = -1:
  // the strip before the first); outside the grid counts as the nearest course's region, so the strip round
  // the world is its region's ground. A gap whose courses all share a region is that region's ground; any
  // other is a road: kerbs along the courses, plain asphalt where roads cross or turn.
  const step = COURSE + GAP;
  const bandOf = (v: number, cells: number) => {
    const u = v - MARGIN;
    if (u < 0) return { k: -1, gap: true, a: 1, z: MARGIN - 1, inner: false };
    const k = Math.floor(u / step), off = u - k * step, a0 = MARGIN + k * step;
    if (off < COURSE) return { k, gap: false, a: a0, z: a0 + COURSE - 1, inner: false };
    const inner = k + 1 < cells;
    return { k, gap: true, a: a0 + COURSE, z: a0 + COURSE + (inner ? GAP : MARGIN - 1) - 1, inner };
  };
  const landAt = (r: number, c: number) => cellRegion(Math.max(0, Math.min(GRID_ROWS - 1, r)), Math.max(0, Math.min(GRID_COLS - 1, c)));
  /** A bridge is ASPHALT tiles wide, down the middle of a gap. */
  const lane0 = (GAP - ASPHALT) / 2;
  for (let y = 1; y < WORLD_ROWS - 1; y++) {
    const by = bandOf(y, GRID_ROWS);
    for (let x = 1; x < WORLD_COLS - 1; x++) {
      const bx = bandOf(x, GRID_COLS);
      if (!bx.gap && !by.gap) continue; // a course
      const rowsNear = by.gap ? [by.k, by.k + 1] : [by.k], colsNear = bx.gap ? [bx.k, bx.k + 1] : [bx.k];
      const near = rowsNear.flatMap((r) => colsNear.map((c) => landAt(r, c)));
      if (near.every((l) => l === near[0])) {
        const l = lands[near[0]];
        const bridge = !l.open && (
          (bx.inner && x - bx.a >= lane0 && x - bx.a < lane0 + ASPHALT && (!by.gap || by.inner)) ||
          (by.inner && y - by.a >= lane0 && y - by.a < lane0 + ASPHALT && (!bx.gap || bx.inner)));
        put(x, y, l.theme, bridge ? l.road : l.ground);
        continue;
      }
      let across = !bx.gap, down = !by.gap;
      if (bx.gap && by.gap) {
        // A crossing: which way the roads into it run.
        down = landAt(by.k, bx.k) !== landAt(by.k, bx.k + 1) || landAt(by.k + 1, bx.k) !== landAt(by.k + 1, bx.k + 1);
        across = landAt(by.k, bx.k) !== landAt(by.k + 1, bx.k) || landAt(by.k, bx.k + 1) !== landAt(by.k + 1, bx.k + 1);
      }
      if (across && !down) {
        const p = MC.horizontal[phase(x)];
        put(x, y, base, y === by.a ? p[0] : y === by.z ? p[2] : p[1]);
      } else if (down && !across) {
        const p = MC.vertical[phase(y)];
        put(x, y, base, x === bx.a ? p[0] : x === bx.z ? p[2] : p[1]);
      } else put(x, y, base, MC.horizontal[phase(x)][1]);
    }
  }

  // Into each course from every side but the world's edge: a way cut straight in to its track (through the
  // fences, the void, the water...), at the line where that is shortest. From a road it is Mario Circuit
  // asphalt, the road's kerb opened up; from its own region it is the course's own road, out to the bridge
  // when there is one, and the fences along that side come down where the region's ground is drivable.
  regions.forEach((reg, i) => {
    const r = Math.round((reg.y0 - MARGIN) / step), c = Math.round((reg.x0 - MARGIN) / step);
    const l = lands[reg.land];
    for (const side of sides) {
      const [nr, nc] = side === 'left' ? [r, c - 1] : side === 'right' ? [r, c + 1] : side === 'top' ? [r - 1, c] : [r + 1, c];
      if (nr < 0 || nc < 0 || nr >= GRID_ROWS || nc >= GRID_COLS) continue;
      const fromRoad = cellRegion(nr, nc) !== reg.land;
      if (!fromRoad && l.open) {
        for (let d = 0; d < 3; d++) for (let a = 0; a < COURSE; a++) {
          const [x, y] = sidePoint(reg, side, d, a);
          if (terrain(x, y) === 'wall') put(x, y, reg.theme, l.ground);
        }
      }
      let best = -1, bestCost = Infinity;
      for (let line = 16; line <= COURSE - 16 - ROAD_W; line++) {
        // Ties: nearest the middle of the side.
        const score = reach(reg, side, line) + Math.abs(line + ROAD_W / 2 - COURSE / 2) * 0.05;
        if (score < bestCost) { bestCost = score; best = line; }
      }
      if (best < 0 || !Number.isFinite(bestCost)) continue;
      const d = reach(reg, side, best);
      const horizontal = side === 'left' || side === 'right';
      if (fromRoad) {
        for (let k = -1; k < d; k++) {
          const [x, y] = sidePoint(reg, side, k, best);
          if (k < 0) {
            // The kerb of the road outside, opened where this road comes in.
            for (let a = 1; a <= ASPHALT; a++) {
              const [ox, oy] = sidePoint(reg, side, k, best + a);
              put(ox, oy, base, horizontal ? MC.horizontal[phase(ox)][1] : MC.vertical[phase(oy)][1]);
            }
          } else if (horizontal) horizontalRoad(x, y);
          else verticalRoad(x, y);
        }
      } else {
        for (let k = l.open ? 0 : -lane0; k < d; k++) {
          for (let a = 1; a <= ASPHALT; a++) {
            const [x, y] = sidePoint(reg, side, k, best + a);
            put(x, y, reg.theme, ownRoad[i]);
          }
        }
      }
    }
  });

  // Objects (pipes, Thwomps, moles, plants, fish), each with its own course's pictures.
  const objects: TrackObject[] = [];
  const objectSet: number[] = [];
  const objectSets: WorldFloor['objectSets'] = [];
  tracks.forEach((t, i) => {
    if (!t.objects.length) return;
    const set = objectSets.push({ frames: t.objectFrames, sizes: t.objectSizes }) - 1;
    const reg = regions[i];
    for (const o of t.objects) {
      objects.push({ kind: o.kind, x: o.x + reg.x0 * TILE, y: o.y + reg.y0 * TILE });
      objectSet.push(set);
    }
  });

  // Starts: spread along each course's racing line, facing along it.
  const spawns: WorldFloor['spawns'] = [];
  tracks.forEach((t, i) => {
    const reg = regions[i], n = t.path.length;
    if (n < 2) return;
    for (let k = 0; k < n; k += 2) {
      const p = t.path[k], q = t.path[(k + 1) % n];
      const x = p.x + reg.x0 * TILE, y = p.y + reg.y0 * TILE;
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      if (!drivable(tx, ty)) continue;
      spawns.push({ x, y, angle: Math.atan2(q.x - p.x, -(q.y - p.y)) });
    }
  });

  // Atlas: every theme's 256 road tiles.
  const atlas = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  for (let th = 0; th < 8; th++) {
    const tiles = theme(th).tilePixels;
    for (let t = 0; t < 256; t++) {
      const id = th * 256 + t, ax = (id % ATLAS_TILES_PER_ROW) * TILE, ay = Math.floor(id / ATLAS_TILES_PER_ROW) * TILE;
      for (let y = 0; y < TILE; y++) atlas.set(tiles[t].subarray(y * TILE * 4, (y + 1) * TILE * 4), ((ay + y) * ATLAS_W + ax) * 4);
    }
  }

  const courses = tracks.map((t, i) => {
    const reg = regions[i];
    return {
      ai: t.ai.map((a) => ({ ...a, x: a.x + reg.x0, y: a.y + reg.y0, target: { x: a.target.x + reg.x0 * TILE, y: a.target.y + reg.y0 * TILE } })),
      path: t.path.map((p) => ({ x: p.x + reg.x0 * TILE, y: p.y + reg.y0 * TILE })),
    };
  });

  const skies = new Map<number, Pick<Track, 'background' | 'backColor'>>();
  for (let th = 0; th < 8; th++) skies.set(th, { background: theme(th).background, backColor: theme(th).backColor });

  return {
    ...mc1,
    info: { index: -1, name: 'Battle Royale', cup: 4, battle: true },
    theme: base,
    pixels: new Uint8Array(0),
    genres,
    tiles: new Uint8Array(0),
    start: null,
    lapLine: null,
    objects,
    ai: [],
    path: [],
    world: { cols: WORLD_COLS, rows: WORLD_ROWS, ids, atlas, regions, baseTheme: base, objectSet, objectSets, spawns, skies, courses },
  };
}

/** The course (or the grass nearest one) at a world position: its theme gives the sky. */
export function regionAt(w: WorldFloor, x: number, y: number): WorldRegion {
  const tx = x / TILE, ty = y / TILE;
  let best = w.regions[0], bestD = Infinity;
  for (const r of w.regions) {
    const dx = Math.max(r.x0 - tx, 0, tx - (r.x0 + COURSE)), dy = Math.max(r.y0 - ty, 0, ty - (r.y0 + COURSE));
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/** Item box tile clusters of the world (their top-left tile), for the bots. */
export function itemBoxes(t: WorldTrack): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const { cols, rows } = t.world;
  const seen = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    if (t.genres[i] !== Genre.ItemBlock || seen[i]) continue;
    const tx = i % cols, ty = Math.floor(i / cols);
    for (let y = ty; y < Math.min(rows, ty + 2); y++) for (let x = tx; x < Math.min(cols, tx + 2); x++) seen[y * cols + x] = 1;
    out.push({ x: (tx + 1) * TILE, y: (ty + 1) * TILE });
  }
  return out;
}
