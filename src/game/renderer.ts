// The 1P race screen of the original, at the SNES resolution (256x224), measured from the game:
//   lines 3-23    sky band: the two scenery layers (and the HUD timer on top)
//   lines 24-106  Mode 7 race view, horizon on line 24, own kart's wheels on line 101
//   lines 115-218 the whole course seen at an angle (the original's lower screen), with the drivers' heads
// WebGL draws the floor, sky and map; drivers, objects, items and the HUD are drawn 1:1 into a 256x224
// layer (no smooth scaling: each driver uses the hand-drawn size closest to its distance, like the SNES).

import { BG_BACK_W, BG_FRONT_W, BG_HEIGHT, MAP_PX, type DriverSprites, type SpriteFrame, type Track } from '../rom/rom';
import { BALLOON_TILES, PLACE_FIRST, PLACE_LINES, PLACE_STRIDE, PLACE_TOP, type RaceGfx } from '../rom/race-gfx';
import { HORIZON, MAP_BOTTOM, MAP_TOP, RaceHud, SKY_TOP, VIEW_BOTTOM, type PlaceShow } from './hud';
import { Layer } from './layer';

export const SCREEN_W = 256;
export const SCREEN_H = 224;
/**
 * The race camera: the original's, from the parameters the game gives the DSP-1 every frame, the same all
 * race long (the game's units are 1/4 px): it looks at the kart from 64 px away (Lfe 256), tilted down
 * 16.875° (zenith 13312 of 65536), the screen 256 px from the eye (Les 256). The kart it looks at is the middle
 * of the picture, on line HORIZON + 256 tan 16.875° = 101.6, and the horizon falls on line 24, as measured.
 */
export interface View {
  /** Eye to the kart looked at (px), downward tilt (radians), screen distance (px), the kart's screen line. */
  dist: number;
  pitch: number;
  focal: number;
  center: number;
  /** Derived: the eye's height and how far behind the kart it is (px). */
  height: number;
  back: number;
}
const view = (dist: number, pitch: number, focal: number, horizon: number): View => ({
  dist, pitch, focal, center: horizon + focal * Math.tan(pitch), height: dist * Math.sin(pitch), back: dist * Math.cos(pitch),
});
export const VIEW = view(64, ((90 - (13312 * 360) / 65536) * Math.PI) / 180, 256, HORIZON);
export const FOCAL = VIEW.focal;
/** How far behind the kart the eye is (px, along the ground); at the eye-to-kart distance the nearest (largest) driver frames are drawn. */
export const CHASE_DISTANCE = VIEW.back;
export const CAM_HEIGHT = VIEW.height;

/**
 * Battle Royale's little planet: the floor curves away from the camera like a log rolling under it (as in
 * Animal Crossing). A point `z` ahead lies z² / (2 R) below the flat floor, so the far floor drops, the
 * horizon comes a few lines lower and nearer, and karts come up over it as you get closer.
 */
export const PLANET_RADIUS = 7000;

/**
 * Without the course map (the player hid it, key M): the race view fills the whole picture. The sky band and
 * the HUD move `shift` lines down and the camera tilts down further (30°, same distance from the kart and
 * same screen distance, so every sprite stays 1:1): the kart comes near the bottom, as on the original's top
 * screen, and more of the course shows ahead.
 */
export const FULL_VIEW = { shift: 32, view: view(64, (30 * Math.PI) / 180, 256, HORIZON + 32) };
/** The camera for the picture with or without the course map. */
export const viewFor = (full: boolean) => (full ? FULL_VIEW.view : VIEW);

/**
 * Where a screen line meets the floor, for the camera `v`: the distance ahead of the eye along the ground and
 * the floor's size per screen pixel across, or null above the horizon (or past the little planet's, `curve`
 * = 1 / 2R: the floor x px ahead lies x² curve below the flat one). The line's offset from the kart's line is
 * `sy - v.center + 1`, as the floor and the sprites both count it.
 */
export function floorLine(v: View, sy: number, curve = 0): { ahead: number; across: number } | null {
  const y = sy - v.center + 1, s = Math.sin(v.pitch), c = Math.cos(v.pitch);
  const down = v.focal * s + y * c, fwd = v.focal * c - y * s;
  if (down <= 0) return null;
  let t = v.height / down;
  if (curve > 0) {
    const a = curve * fwd * fwd, disc = down * down - 4 * a * v.height;
    if (disc < 0) return null;
    t = (down - Math.sqrt(disc)) / (2 * a);
  }
  return { ahead: t * fwd, across: t };
}

/**
 * Course map (lower screen): the original's camera for it, from its DSP-1 parameters (the map's raster and the
 * heads' projection): 2176 px from the point it looks at (the course's middle across, 984 px down), tilted
 * 30.94° (zenith 10752), the screen 512 px away; that point on line 214 (the game's $9A), so the course's
 * near edge falls on line 219, the bottom of the map, and its far edge on line 128.
 */
export const MAP_VIEW: View = (() => {
  const dist = 2176, pitch = ((90 - (10752 * 360) / 65536) * Math.PI) / 180;
  return { dist, pitch, focal: 512, center: 214, height: dist * Math.sin(pitch), back: dist * Math.cos(pitch) };
})();
/** The point the map camera looks at, in course pixels. */
const MAP_FOCUS = { x: MAP_PX / 2, y: 984 };
/** World pixels per screen pixel on the nearest map line. */
export const MAP_SCALE = floorLine(MAP_VIEW, MAP_BOTTOM - 1)!.across;

/** Where a map screen line meets the course (course pixels ahead: its y), and its pixels per screen pixel. */
export function mapLine(sy: number): { y: number; across: number } | null {
  const l = floorLine(MAP_VIEW, sy);
  return l && { y: MAP_FOCUS.y + MAP_VIEW.back - l.ahead, across: l.across };
}

export interface Camera {
  x: number;
  y: number;
  angle: number;
}

/** A track object (pipe, Thwomp...): a 16x16 image drawn at the size of a kart. */
export interface ObjectSprite {
  x: number;
  y: number;
  /** Index into the track's objectFrames, or into the item frames when `item` is set. */
  frame: number;
  lift: number;
  /** Bananas and shells: drawn at half the size of a track object. */
  item?: boolean;
  /** Drawn mirrored (a shell spinning). */
  mirror?: boolean;
  /** Its own pictures (the Battle Royale world has every course's objects); default: the track's. */
  frames?: SpriteFrame[];
  sizes?: SpriteFrame[][];
}

export interface Sprite {
  x: number;
  y: number;
  /** Index into CHARACTERS. */
  character: number;
  /** 0..1, shrinks the kart while it falls off the track. */
  scale?: number;
  /** Kart heading, to pick the front/back/side view relative to the camera. */
  angle: number;
  /** Height above the floor (jumps), in world pixels. */
  lift?: number;
  /** Boo: see-through. */
  alpha?: number;
  /** Star: flashing. */
  flash?: boolean;
  /** Tire smoke (skid / power slide), dirt kicked up off-road, boost sparks. */
  smoke?: boolean;
  dust?: boolean;
  boost?: boolean;
  /** Battle Mode: balloons left, floating over the driver, and their sprite palette. */
  balloons?: number;
  balloonPalette?: number;
}

/** Balloon sizes (px) and their first tile: 2x2 sprites down to 9 px, then single tiles. */
const BALLOON_SIZES: [number, number, boolean][] = [
  [16, BALLOON_TILES, true], [14, BALLOON_TILES + 2, true], [12, BALLOON_TILES + 4, true], [10, BALLOON_TILES + 6, true],
  [9, BALLOON_TILES + 8, true], [7, BALLOON_TILES + 10, false], [5, BALLOON_TILES + 11, false], [3, BALLOON_TILES + 12, false],
];

/** Effect sprites (16x16, tiles 00-3F of the race's sprite VRAM) and the palettes the game draws them in. */
const FX_SMOKE = [0x20, 0x22];
const FX_DUST = [0x00, 0x02, 0x04, 0x06];
const FX_SPARK = [0x2e, 0x0e];
const PAL_SMOKE = 7;
const PAL_DUST = 6;
const PAL_SPARK = 6;

/** A driver on the course map. */
export interface MapMarker {
  x: number;
  y: number;
  character: number;
  /** Sprite palette (0-7) of the driver. */
  palette: number;
  /** Drawn at half size (everyone else on Battle Royale's map of the whole world). */
  small?: boolean;
}

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/**
 * The floor of a world bigger than one course (Battle Royale): uMap holds an atlas tile number per tile
 * (red = low byte, green = high byte), uFill the atlas of 8x8 tiles. The world wraps round (floorAt); the
 * map of the whole world (floorMapAt) shows tile `outside` beyond it.
 */
export interface WorldShape { cols: number; rows: number; atlasW: number; atlasH: number; outside: number }

const floorFn = (world: WorldShape | null) => world ? `
vec3 tileAt(float id, vec2 p) {
  float per = ${world.atlasW / 8}.0;
  vec2 a = vec2(mod(id, per), floor(id / per)) * 8.0 + floor(p) + 0.5;
  return texture2D(uFill, a / vec2(${world.atlasW}.0, ${world.atlasH}.0)).rgb;
}
const vec2 WORLD = vec2(${world.cols * 8}.0, ${world.rows * 8}.0);
vec3 floorAt(vec2 w) {
  vec2 t = floor(w / 8.0);
  vec2 p = w - t * 8.0;
  t = mod(t, vec2(${world.cols}.0, ${world.rows}.0));
  vec4 c = texture2D(uMap, (t + 0.5) / vec2(${world.cols}.0, ${world.rows}.0));
  return tileAt(floor(c.r * 255.0 + 0.5) + floor(c.g * 255.0 + 0.5) * 256.0, p);
}
vec3 floorMapAt(vec2 w) {
  if (w.x < 0.0 || w.y < 0.0 || w.x >= WORLD.x || w.y >= WORLD.y) return tileAt(${world.outside}.0, w - floor(w / 8.0) * 8.0);
  return floorAt(w);
}
// From the safe area's centre, the short way round.
float zoneDistance(vec2 w) {
  vec2 d = w - uZone.xy;
  d -= WORLD * floor(d / WORLD + 0.5);
  return length(d);
}` : `
vec3 floorAt(vec2 w) {
  if (w.x < 0.0 || w.y < 0.0 || w.x >= ${MAP_PX}.0 || w.y >= ${MAP_PX}.0) return texture2D(uFill, mod(w, 8.0) / 8.0).rgb;
  return texture2D(uMap, w / ${MAP_PX}.0).rgb;
}
vec3 floorMapAt(vec2 w) { return floorAt(w); }
float zoneDistance(vec2 w) { return distance(w, uZone.xy); }`;

/**
 * Fragment shader for a picture `w` pixels wide (the view widens, the scale stays the original's); `full`:
 * the course map hidden, the view filling the picture (FULL_VIEW).
 */
const frag = (w: number, world: WorldShape | null = null, full = false) => {
  const shift = full ? FULL_VIEW.shift : 0, v = viewFor(full);
  const HORIZON_AT = HORIZON + shift, SKY_FROM = full ? 0 : SKY_TOP, VIEW_TO = full ? SCREEN_H : VIEW_BOTTOM;
  const f = (x: number) => x.toFixed(6);
  return `
precision highp float;
uniform sampler2D uMap;
uniform sampler2D uFill;
uniform sampler2D uBgFront;
uniform sampler2D uBgBack;
uniform vec2 uCam;
uniform float uAngle;
uniform float uFocal;
uniform vec3 uSky;
uniform vec2 uBgScroll;
uniform vec2 uMapOrigin;
uniform float uMapZoom;
uniform vec3 uZone;
uniform float uCurve;
uniform float uSkyDrop;
${floorFn(world)}
// Battle Royale: outside the safe area the floor is tinted (uZone = centre, radius; radius < 0 = none).
vec3 zoned(vec3 c, vec2 w) {
  if (uZone.z < 0.0 || zoneDistance(w) <= uZone.z) return c;
  return mix(c, vec3(0.42, 0.06, 0.36), 0.5);
}

void main() {
  float sy = floor(${SCREEN_H}.0 - gl_FragCoord.y);
  float sx = floor(gl_FragCoord.x);
  vec3 c = vec3(0.0);
  // Race view (Mode 7): one floor line per screen line, as the original's tilted camera sees it (floorLine):
  // z ahead of the eye along the ground, 'across' floor px per screen px. On the little planet (uCurve =
  // 1 / 2R) a point z ahead is z * z * uCurve below the flat floor; past the planet's horizon there is only sky.
  float yv = sy - ${f(v.center)} + 1.0;
  float down = ${f(v.focal * Math.sin(v.pitch))} + yv * ${f(Math.cos(v.pitch))};
  float fwdRay = ${f(v.focal * Math.cos(v.pitch))} - yv * ${f(Math.sin(v.pitch))};
  bool ground = sy >= ${HORIZON_AT}.0 && sy < ${VIEW_TO}.0 && down > 0.0;
  float across = ${f(v.height)} / max(down, 1e-6);
  if (ground && uCurve > 0.0) {
    float a = uCurve * fwdRay * fwdRay, disc = down * down - 4.0 * a * ${f(v.height)};
    if (disc < 0.0) ground = false;
    else across = (down - sqrt(disc)) / (2.0 * a);
  }
  float z = across * fwdRay;
  if (sy >= ${SKY_FROM}.0 && !ground && sy < ${VIEW_TO}.0) {
    // Sky band: the two scenery layers, bottom row on the last line above the road (uSkyDrop lines lower on
    // the little planet). Each wraps once per turn.
    c = uSky;
    float by = sy - (${HORIZON_AT}.0 + uSkyDrop - ${BG_HEIGHT}.0);
    if (by >= 0.0) {
      float v = (by + 0.5) / ${BG_HEIGHT}.0;
      vec4 back = texture2D(uBgBack, vec2(fract((sx - ${(w - SCREEN_W) >> 1}.0 + uBgScroll.y + 0.5) / ${BG_BACK_W}.0), v));
      vec4 front = texture2D(uBgFront, vec2(fract((sx - ${(w - SCREEN_W) >> 1}.0 + uBgScroll.x + 0.5) / ${BG_FRONT_W}.0), v));
      c = mix(c, back.rgb, back.a);
      c = mix(c, front.rgb, front.a);
    }
  } else if (ground) {
    float lateral = (sx + 0.5 - ${w / 2}.0) * across;
    vec2 fwd = vec2(sin(uAngle), -cos(uAngle));
    vec2 right = vec2(cos(uAngle), sin(uAngle));
    vec2 wp = uCam + fwd * z + right * lateral;
    c = zoned(floorAt(wp), wp);
  } else if (${full ? 'false' : 'true'} && sy >= ${MAP_TOP}.0 && sy < ${MAP_BOTTOM}.0) {
    // Course map: north up, seen by the original's map camera (MAP_VIEW, mapLine).
    float my = sy - ${f(MAP_VIEW.center)} + 1.0;
    float mdown = ${f(MAP_VIEW.focal * Math.sin(MAP_VIEW.pitch))} + my * ${f(Math.cos(MAP_VIEW.pitch))};
    float mfwd = ${f(MAP_VIEW.focal * Math.cos(MAP_VIEW.pitch))} - my * ${f(Math.sin(MAP_VIEW.pitch))};
    float macross = ${f(MAP_VIEW.height)} / mdown;
    float wy = ${f(MAP_FOCUS.y + MAP_VIEW.back)} - macross * mfwd;
    vec2 mp = uMapOrigin + vec2(${f(MAP_FOCUS.x)} + (sx + 0.5 - ${w / 2}.0) * macross, wy) * uMapZoom;
    c = zoned(floorMapAt(mp), mp);
  }
  gl_FragColor = vec4(c, 1.0);
}
`;
};

const UNIFORMS = ['uMap', 'uFill', 'uBgFront', 'uBgBack', 'uCam', 'uAngle', 'uFocal', 'uSky', 'uBgScroll', 'uMapOrigin', 'uMapZoom', 'uZone', 'uCurve', 'uSkyDrop'];

export interface DriverFrames {
  /** frames[distanceRow][angleSlot] */
  frames: SpriteFrame[][];
  /** Visible height of each distance row, used to pick the row closest to the wanted on-screen size. */
  rowHeights: number[];
}

export class Renderer {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private mapTex: WebGLTexture;
  private fillTex: WebGLTexture;
  private bgFrontTex: WebGLTexture;
  private bgBackTex: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private overlay: CanvasRenderingContext2D;
  private image: ImageData;
  /** The place number: drawn on a canvas that the page blends additively (CSS plus-lighter) over the picture. */
  private placeFx: CanvasRenderingContext2D | null;
  private placeImage: ImageData;
  private sky: number[] = [0, 0, 0];
  private drivers = new Map<number, DriverFrames>();
  private objectFrames: SpriteFrame[] = [];
  private objectSizes: SpriteFrame[][] = [];
  private itemFrames: SpriteFrame[] = [];
  private tick = 0;
  layer: Layer | null = null;
  hud: RaceHud | null = null;

  /** Picture width: 256, or wider for widescreen (more of the course at the sides, same pixel scale). */
  width = SCREEN_W;
  /** Where the original 256 columns start (the HUD is drawn there). */
  pad = 0;
  /** World mode (Battle Royale): the floor's shape, or null for one course. */
  private world: WorldShape | null = null;
  /** Top-left of the 1024 x 1024 area the course map (lower screen) shows: a course shows whole. */
  mapOrigin = { x: 0, y: 0 };
  /** World pixels per course-map pixel, relative to the original's (Battle Royale: the whole world). */
  mapZoom = 1;
  /** Battle Royale safe area (floor outside it is tinted), or null. */
  zone: { x: number; y: number; r: number } | null = null;
  /** The planet's curve, 1 / (2 R) (0 = flat, as on the SNES). */
  curve = 0;
  /** The course map hidden: the race view fills the picture (setFullView). */
  private fullView = false;

  constructor(private floorCanvas: HTMLCanvasElement, private overlayCanvas: HTMLCanvasElement, private gfx: RaceGfx | null, private placeCanvas?: HTMLCanvasElement, width = SCREEN_W) {
    this.placeFx = placeCanvas?.getContext('2d') ?? null;
    const gl = floorCanvas.getContext('webgl', { antialias: false });
    if (!gl) throw new Error('WebGL não está disponível neste navegador.');
    this.gl = gl;
    this.overlay = overlayCanvas.getContext('2d')!;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.prog = null!;
    this.image = this.placeImage = null!;
    this.setWidth(width, true);

    this.mapTex = gl.createTexture()!;
    this.fillTex = gl.createTexture()!;
    this.bgFrontTex = gl.createTexture()!;
    this.bgBackTex = gl.createTexture()!;
  }

  /**
   * Picture width: 256 (the original) or wider (widescreen: more of the course at the sides, same scale; the
   * HUD stays in the middle 256 columns). Can change during a race.
   */
  setWidth(width: number, force = false) {
    if (width === this.width && !force) return;
    this.width = width;
    this.pad = (width - SCREEN_W) >> 1;
    this.floorCanvas.width = this.overlayCanvas.width = width;
    this.floorCanvas.height = this.overlayCanvas.height = SCREEN_H;
    if (this.placeCanvas) { this.placeCanvas.width = width; this.placeCanvas.height = SCREEN_H; }
    this.placeImage = new ImageData(width, SCREEN_H);
    this.image = this.overlay.createImageData(width, SCREEN_H);
    this.layer?.resize(width);

    const gl = this.gl;
    if (this.prog) gl.deleteProgram(this.prog);
    this.prog = link(gl, VERT, frag(width, this.world, this.fullView));
    gl.useProgram(this.prog);
    for (const name of UNIFORMS) this.uniforms[name] = gl.getUniformLocation(this.prog, name);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  /** Lines of sky under the horizon line (the little planet's horizon is lower): the first line with floor. */
  private skyDrop(v: View): number {
    if (this.curve <= 0) return 0;
    const top = HORIZON + (this.fullView ? FULL_VIEW.shift : 0);
    for (let sy = top; sy < SCREEN_H; sy++) if (floorLine(v, sy, this.curve)) return sy - top;
    return 0;
  }

  /** Shows or hides the course map (lower screen); hidden, the race view fills the picture. */
  setFullView(on: boolean) {
    if (on === this.fullView) return;
    this.fullView = on;
    this.setWidth(this.width, true);
  }

  /** Loads a track and the driver frames (already colored with its palettes) for the characters in the race. */
  setTrack(track: Track, drivers: Map<number, DriverSprites | null>, itemFrames: SpriteFrame[] = [], world: (WorldShape & { ids: Uint16Array; atlas: Uint8Array }) | null = null) {
    this.itemFrames = itemFrames;
    const gl = this.gl;
    const shape = world && { cols: world.cols, rows: world.rows, atlasW: world.atlasW, atlasH: world.atlasH, outside: world.outside };
    if (JSON.stringify(shape) !== JSON.stringify(this.world)) {
      this.world = shape;
      this.setWidth(this.width, true);
    }
    this.mapOrigin = { x: 0, y: 0 };
    this.mapZoom = 1;
    this.zone = null;
    this.curve = 0;
    if (world) {
      const ids = new Uint8Array(world.cols * world.rows * 4);
      for (let i = 0; i < world.ids.length; i++) { ids[i * 4] = world.ids[i] & 255; ids[i * 4 + 1] = world.ids[i] >> 8; ids[i * 4 + 3] = 255; }
      upload(gl, this.mapTex, world.cols, world.rows, ids);
      upload(gl, this.fillTex, world.atlasW, world.atlasH, world.atlas);
    } else {
      upload(gl, this.mapTex, MAP_PX, MAP_PX, track.pixels);
      upload(gl, this.fillTex, 8, 8, track.fill);
    }
    this.setSky(track);

    this.objectFrames = track.objectFrames;
    this.objectSizes = track.objectSizes;
    this.drivers.clear();
    for (const [character, sprites] of drivers) {
      if (sprites) this.drivers.set(character, withRowHeights(sprites));
    }
    // Sprites and HUD use the track's palettes, as on the SNES.
    if (this.gfx) {
      this.layer = new Layer(this.gfx.obj, this.gfx.hud, track.colors, this.width);
      this.hud = new RaceHud(this.layer, this.gfx);
    }
  }

  /** Adds a driver's frames (someone with a driver nobody had yet came into an online Battle Royale). */
  addDriver(character: number, sprites: DriverSprites | null) {
    if (sprites) this.drivers.set(character, withRowHeights(sprites));
  }

  /** The sky band's two scenery layers and the color behind them (the world changes them course by course). */
  setSky(sky: Pick<Track, 'background' | 'backColor'>) {
    const gl = this.gl;
    upload(gl, this.bgFrontTex, BG_FRONT_W, BG_HEIGHT, sky.background.front);
    upload(gl, this.bgBackTex, BG_BACK_W, BG_HEIGHT, sky.background.back);
    this.sky = sky.backColor.map((v) => v / 255);
  }

  /** Re-uploads map tiles that changed (broken blocks). */
  updateTiles(track: Track, tiles: number[]) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
    if (track.world) {
      const px = new Uint8Array(4);
      for (const i of tiles) {
        const id = track.world.ids[i];
        px[0] = id & 255; px[1] = id >> 8; px[3] = 255;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, i % track.world.cols, Math.floor(i / track.world.cols), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return;
    }
    const buf = new Uint8Array(8 * 8 * 4);
    for (const i of tiles) {
      const tx = (i % 128) * 8, ty = Math.floor(i / 128) * 8;
      for (let y = 0; y < 8; y++) buf.set(track.pixels.subarray(((ty + y) * MAP_PX + tx) * 4, ((ty + y) * MAP_PX + tx + 8) * 4), y * 32);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, tx, ty, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    }
  }

  /**
   * One frame: floor/sky/map, then drivers and objects in the race view, map markers, and `hud`
   * (timer, Lakitu...) drawn last on top.
   */
  render(cam: Camera, sprites: Sprite[], objects: ObjectSprite[], markers: MapMarker[], hud: (hud: RaceHud) => void) {
    const gl = this.gl;
    const u = this.uniforms;
    gl.viewport(0, 0, this.width, SCREEN_H);
    gl.useProgram(this.prog);
    const textures = [this.mapTex, this.fillTex, this.bgFrontTex, this.bgBackTex];
    ['uMap', 'uFill', 'uBgFront', 'uBgBack'].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[i]);
      gl.uniform1i(u[name], i);
    });
    gl.uniform2f(u.uCam, cam.x, cam.y);
    gl.uniform1f(u.uAngle, cam.angle);
    gl.uniform1f(u.uFocal, FOCAL);
    gl.uniform3fv(u.uSky, this.sky);
    // One full turn scrolls each layer by its own width; the back layer is half as wide, so it moves slower.
    const turn = cam.angle / (Math.PI * 2);
    gl.uniform2f(u.uBgScroll, turn * BG_FRONT_W, turn * BG_BACK_W);
    gl.uniform2f(u.uMapOrigin, this.mapOrigin.x, this.mapOrigin.y);
    gl.uniform1f(u.uMapZoom, this.mapZoom);
    gl.uniform3f(u.uZone, this.zone?.x ?? 0, this.zone?.y ?? 0, this.zone ? this.zone.r : -1);
    gl.uniform1f(u.uCurve, this.curve);
    // Lines of sky below the old horizon: the last line where the floor can't be seen any more.
    const v = viewFor(this.fullView);
    gl.uniform1f(u.uSkyDrop, this.skyDrop(v));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const layer = this.layer;
    if (!layer) return;
    this.tick++;
    layer.clear();
    layer.ox = 0;
    const shift = this.fullView ? FULL_VIEW.shift : 0;
    layer.oy = shift;
    layer.setClip(HORIZON + shift, this.fullView ? SCREEN_H : VIEW_BOTTOM);
    const world = this.world && { w: this.world.cols * 8, h: this.world.rows * 8 };
    drawRaceView(layer, cam, sprites, objects, {
      drivers: this.drivers, objectFrames: this.objectFrames, objectSizes: this.objectSizes, itemFrames: this.itemFrames, world, curve: this.curve, view: v,
    }, this.tick);
    layer.setClip(MAP_TOP, MAP_BOTTOM);
    // The course map is centred in the picture, the HUD in the original's 256 columns.
    layer.ox = this.pad;
    for (const m of this.fullView ? [] : markers) {
      // (In the world, wherever the kart is counted, brought back into the world.)
      const mx = world ? m.x - world.w * Math.floor(m.x / world.w) : m.x, my = world ? m.y - world.h * Math.floor(m.y / world.h) : m.y;
      const p = mapPoint(mx - this.mapOrigin.x, my - this.mapOrigin.y, this.mapZoom);
      if (p && (p.x < -8 || p.x > SCREEN_W + 8)) continue;
      if (p) this.hud!.head(m.character, p.x, p.y, m.palette, m.small);
    }
    // The HUD moves down with the race view. (Its top lines, hidden on the original's black lines 0-2, stay
    // hidden over the sky.)
    layer.setClip(shift ? SKY_TOP + shift : 0);
    layer.oy = shift;
    this.hud!.placeShow = null;
    hud(this.hud!);
    layer.oy = 0;
    this.image.data.set(layer.px);
    this.overlay.putImageData(this.image, 0, 0);
    if (this.placeFx && this.gfx) {
      this.placeImage.data.fill(0);
      const p = this.hud!.placeShow as PlaceShow | null;
      if (p) placeMask(this.gfx.place, p.n, (x, y) => {
        const q = ((y + shift) * this.width + x + this.pad) * 4;
        this.placeImage.data.set([p.add[0], p.add[1], p.add[2], 255], q);
      });
      this.placeFx.putImageData(this.placeImage, 0, 0);
    }
  }

}

export interface SpriteSet {
  drivers: Map<number, DriverFrames>;
  objectFrames: SpriteFrame[];
  /** Hand-drawn smaller sizes of the track object (largest first), per palette. */
  objectSizes?: SpriteFrame[][];
  itemFrames: SpriteFrame[];
  /** The Battle Royale world's size in pixels: it wraps round, so things are seen the short way round. */
  world?: { w: number; h: number } | null;
  /** The planet's curve, 1 / (2 R) (0 = flat). */
  curve?: number;
  /** The camera (tilted further with the course map hidden: FULL_VIEW). */
  view?: View;
}

/** Drivers, track objects and items of the race view, far to near, at the SNES resolution. */
export function drawRaceView(layer: Layer, cam: Camera, sprites: Sprite[], objects: ObjectSprite[], set: SpriteSet, tick: number) {
  const fx = Math.sin(cam.angle), fy = -Math.cos(cam.angle);
  const rx = Math.cos(cam.angle), ry = Math.sin(cam.angle);
  const w = set.world, curve = set.curve ?? 0, v = set.view ?? VIEW;
  const sp = Math.sin(v.pitch), cp = Math.cos(v.pitch);
  const project = <T extends { x: number; y: number }>(s: T) => {
    let dx = s.x - cam.x, dy = s.y - cam.y;
    if (w) { dx -= w.w * Math.round(dx / w.w); dy -= w.h * Math.round(dy / w.h); }
    // z: ahead of the eye along the ground; depth: along the camera's line of sight.
    const z = dx * fx + dy * fy;
    return { s, dx, dy, z, lat: dx * rx + dy * ry, depth: z * cp + (v.height + z * z * curve) * sp };
  };
  // On the little planet nothing shows past its horizon (sqrt(2 R h) ahead).
  const far = curve > 0 ? Math.min(900, Math.sqrt(v.height / curve)) : 900;
  type Item = ReturnType<typeof project<Sprite>> | (ReturnType<typeof project<ObjectSprite>> & { object: true });
  const items: Item[] = [
    ...sprites.map(project),
    ...objects.map((o) => ({ ...project(o), object: true as const })),
  ];
  const projected = items.filter((p) => p.depth > 8 && p.z < far).sort((a, b) => b.depth - a.depth);

  for (const item of projected) {
    const k = v.focal / item.depth; // screen px per world px
    const sx = layer.w / 2 + item.lat * k;
    // Where its spot on the floor shows (further down the curve on the little planet: z * z * curve below
    // the flat floor); a height h above the floor shows h cos(tilt) k higher.
    const ground = v.center + ((v.height + item.z * item.z * curve) * cp - item.z * sp) * k;
    const liftK = k * cp;
    if ('object' in item) {
      const o = item.s;
      const frames = o.item ? set.itemFrames : o.frames ?? set.objectFrames;
      const img = frames[o.frame] ?? frames[0];
      if (!img) continue;
      // 16x16 frames: objects are drawn 32px at the chase distance (like the karts), items 16px.
      const size = Math.round((o.item ? 16 : 32) * (v.dist / item.depth));
      if (size < 1) continue;
      // Further away the game switches to the object's smaller hand-drawn sizes, drawn 1:1.
      const allSizes = o.sizes ?? set.objectSizes;
      const sizes = !o.item ? allSizes?.[Math.min(o.frame, (allSizes?.length ?? 1) - 1)] : undefined;
      if (sizes?.length && size <= 16) {
        let best = sizes[0];
        for (const f of sizes) if (Math.abs(f.h - size) < Math.abs(best.h - size)) best = f;
        layer.frame(best, Math.round(sx - best.w / 2), Math.round(ground - o.lift * liftK - best.h));
        continue;
      }
      layer.scaled(img, Math.round(sx - size / 2), Math.round(ground - o.lift * liftK - size), size, size, o.mirror);
      continue;
    }
    const { s, dx, dy } = item;
    const driver = set.drivers.get(s.character);
    if (!driver) continue;
    const wanted = driver.rowHeights[0] * (v.dist / item.depth) * (s.scale ?? 1);
    if (wanted < 2) continue;
    // The hand-drawn size closest to the wanted one, drawn 1:1.
    let row = 0;
    for (let r = 1; r < driver.rowHeights.length; r++) {
      if (Math.abs(driver.rowHeights[r] - wanted) < Math.abs(driver.rowHeights[row] - wanted)) row = r;
    }
    // Heading relative to the line of sight: 0 = seen from behind, ±π = seen from the front.
    let rel = s.angle - Math.atan2(dx, -dy);
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const slot = Math.min(15, Math.round((Math.abs(rel) / Math.PI) * 15));
    const f = driver.frames[row][slot];
    // Frames face right; mirrored for karts turned to the left.
    const flash = !!s.flash && (tick >> 2) % 2 === 0;
    const x0 = Math.round(sx - f.w / 2), y0 = Math.round(ground - (s.lift ?? 0) * liftK - f.h);
    layer.frame(f, x0, y0, rel < 0, s.alpha ?? 1, flash);
    // Effects only on the two nearest sizes, where the game draws them too.
    if (row <= 1 && !s.lift) drawKartFx(layer, s, x0, y0 + f.h, f.w, tick);
    if (s.balloons) drawBalloons(layer, s.balloons, s.balloonPalette ?? 0, x0 + f.w / 2, y0, f.h);
  }
}

/** Battle balloons over a driver: the size closest to a third of the kart's height, side by side. */
export function drawBalloons(layer: Layer, n: number, palette: number, cx: number, top: number, kartHeight: number) {
  const want = Math.max(3, Math.min(16, kartHeight / 2));
  let best = BALLOON_SIZES[0];
  for (const b of BALLOON_SIZES) if (Math.abs(b[0] - want) < Math.abs(best[0] - want)) best = b;
  const [size, tile, big] = best;
  const gap = Math.max(1, Math.round(size * 0.75));
  for (let i = 0; i < n; i++) {
    const x = Math.round(cx - ((n - 1) * gap) / 2 + i * gap - (big ? 8 : 4));
    const y = Math.round(top - size - 1 - (i % 2) * Math.round(size / 4));
    layer.sprite(tile, x, y, palette, big);
  }
}

/** Smoke, dirt and sparks at the rear wheels of a nearby kart (bottom-left corner at x0, yBottom). */
function drawKartFx(layer: Layer, s: Sprite, x0: number, yBottom: number, w: number, tick: number) {
  const phase = tick >> 2;
  const y = yBottom - 14;
  if (s.smoke) {
    const t = FX_SMOKE[phase % 2];
    layer.sprite(t, x0 - 8, y, PAL_SMOKE, true);
    layer.sprite(t, x0 + w - 8, y, PAL_SMOKE, true, true);
  }
  if (s.dust) {
    const t = FX_DUST[phase % 4];
    layer.sprite(t, x0 - 6, y - 2, PAL_DUST, true);
    layer.sprite(t, x0 + w - 10, y - 2, PAL_DUST, true, true);
  }
  if (s.boost) {
    const t = FX_SPARK[phase % 2];
    layer.sprite(t, x0 + w / 2 - 8, yBottom - 10, PAL_SPARK, true, phase % 4 >= 2);
  }
}

/**
 * Pixels of the big place number `n` (1-8): the game's window table, window 1 XOR window 2 on each line.
 */
export function placeMask(table: Uint8Array, n: number, put: (x: number, y: number) => void) {
  const first = PLACE_FIRST + (n - 1) * PLACE_STRIDE;
  for (let i = 0; i < PLACE_LINES; i++) {
    const at = (first + i) * 4;
    if (at + 3 >= table.length) break;
    const [a, b, c, d] = [table[at], table[at + 1], table[at + 2], table[at + 3]];
    for (let x = Math.min(a, c); x <= Math.max(b, d); x++) {
      if ((x >= a && x <= b) !== (x >= c && x <= d)) put(x, PLACE_TOP + i);
    }
  }
}

/** Where a world position shows on the course map (lower screen), or null outside it. */
export function mapPoint(x: number, y: number, zoom = 1): { x: number; y: number } | null {
  const cx = x / zoom, cy = y / zoom;
  if (cy < 0 || cy > MAP_PX) return null;
  const v = MAP_VIEW, s = Math.sin(v.pitch), c = Math.cos(v.pitch);
  const ahead = MAP_FOCUS.y + v.back - cy;
  const depth = ahead * c + v.height * s;
  if (depth <= 0) return null;
  return { x: SCREEN_W / 2 + (v.focal * (cx - MAP_FOCUS.x)) / depth, y: v.center - 1 + (v.focal * (v.height * c - ahead * s)) / depth };
}

export function withRowHeights(sprites: DriverSprites): DriverFrames {
  // Visible height of a side view in each row (frames are bottom-aligned in their box).
  const rowHeights = sprites.rows.map((row) => {
    const f = row[8];
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) if (f.pixels[(y * f.w + x) * 4 + 3]) return f.h - y;
    }
    return f.h;
  });
  return { frames: sprites.rows, rowHeights };
}

function upload(gl: WebGLRenderingContext, tex: WebGLTexture, w: number, h: number, pixels: Uint8Array) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function link(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program');
  return p;
}
