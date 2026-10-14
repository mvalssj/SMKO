// The 1P race screen of the original, at the SNES resolution (256x224), measured from the game:
//   lines 3-23    sky band: the two scenery layers (and the HUD timer on top)
//   lines 24-106  Mode 7 race view, horizon on line 24, own kart's wheels on line 101
//   lines 115-218 the whole course seen at an angle (the original's lower screen), with the drivers' heads
// WebGL draws the floor, sky and map; drivers, objects, items and the HUD are drawn 1:1 into a 256x224
// layer (no smooth scaling: each driver uses the hand-drawn size closest to its distance, like the SNES).

import { BG_BACK_W, BG_FRONT_W, BG_HEIGHT, MAP_PX, type DriverSprites, type SpriteFrame, type Track } from '../rom/rom';
import type { RaceGfx } from '../rom/race-gfx';
import { HORIZON, MAP_BOTTOM, MAP_TOP, RaceHud, SKY_TOP, VIEW_BOTTOM } from './hud';
import { Layer } from './layer';

export const SCREEN_W = 256;
export const SCREEN_H = 224;
export const CAM_HEIGHT = 20;
/** Camera-to-own-kart distance; at this depth the nearest (largest) driver frames are drawn. */
export const CHASE_DISTANCE = 34;
/** Own kart's wheels on line 101 (sprite at y = 70, 32 tall): HORIZON + CAM_HEIGHT * FOCAL / CHASE_DISTANCE = 102. */
export const FOCAL = ((102 - HORIZON) * CHASE_DISTANCE) / CAM_HEIGHT;

/** Course map (lower screen): the course leans away, so the far edge is narrower. */
export const MAP_TILT = 0.7;
/** World pixels per screen pixel on the nearest map line. */
export const MAP_SCALE = 4.2;

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
}

/** A driver on the course map. */
export interface MapMarker {
  x: number;
  y: number;
  character: number;
  /** Sprite palette (0-7) of the driver. */
  palette: number;
}

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
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

vec3 floorAt(vec2 w) {
  if (w.x < 0.0 || w.y < 0.0 || w.x >= ${MAP_PX}.0 || w.y >= ${MAP_PX}.0) return texture2D(uFill, mod(w, 8.0) / 8.0).rgb;
  return texture2D(uMap, w / ${MAP_PX}.0).rgb;
}

void main() {
  float sy = floor(${SCREEN_H}.0 - gl_FragCoord.y);
  float sx = floor(gl_FragCoord.x);
  vec3 c = vec3(0.0);
  if (sy >= ${SKY_TOP}.0 && sy < ${HORIZON}.0) {
    // Sky band: the two scenery layers, bottom row on the last line above the road. Each wraps once per turn.
    c = uSky;
    float by = sy - (${HORIZON}.0 - ${BG_HEIGHT}.0);
    if (by >= 0.0) {
      float v = (by + 0.5) / ${BG_HEIGHT}.0;
      vec4 back = texture2D(uBgBack, vec2(fract((sx + uBgScroll.y + 0.5) / ${BG_BACK_W}.0), v));
      vec4 front = texture2D(uBgFront, vec2(fract((sx + uBgScroll.x + 0.5) / ${BG_FRONT_W}.0), v));
      c = mix(c, back.rgb, back.a);
      c = mix(c, front.rgb, front.a);
    }
  } else if (sy >= ${HORIZON}.0 && sy < ${VIEW_BOTTOM}.0) {
    // Race view (Mode 7): one floor line per screen line.
    float dy = sy - ${HORIZON}.0 + 1.0;
    float z = ${CAM_HEIGHT}.0 * uFocal / dy;
    float lateral = (sx + 0.5 - ${SCREEN_W / 2}.0) * z / uFocal;
    vec2 fwd = vec2(sin(uAngle), -cos(uAngle));
    vec2 right = vec2(cos(uAngle), sin(uAngle));
    c = floorAt(uCam + fwd * z + right * lateral);
  } else if (sy >= ${MAP_TOP}.0 && sy < ${MAP_BOTTOM}.0) {
    // Course map: north up, leaning away from the viewer.
    float t = (sy - ${MAP_TOP}.0 + 0.5) / ${MAP_BOTTOM - MAP_TOP}.0;
    float wy = ${MAP_PX}.0 * t * (1.0 + ${MAP_TILT}) / (1.0 + ${MAP_TILT} * t);
    float scale = ${MAP_SCALE} * (1.0 + ${MAP_TILT}) / (1.0 + ${MAP_TILT} * t);
    c = floorAt(vec2(${MAP_PX / 2}.0 + (sx + 0.5 - ${SCREEN_W / 2}.0) * scale, wy));
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

const UNIFORMS = ['uMap', 'uFill', 'uBgFront', 'uBgBack', 'uCam', 'uAngle', 'uFocal', 'uSky', 'uBgScroll'];

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
  private sky: number[] = [0, 0, 0];
  private drivers = new Map<number, DriverFrames>();
  private objectFrames: SpriteFrame[] = [];
  private itemFrames: SpriteFrame[] = [];
  private tick = 0;
  layer: Layer | null = null;
  hud: RaceHud | null = null;

  constructor(floorCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement, private gfx: RaceGfx | null) {
    floorCanvas.width = overlayCanvas.width = SCREEN_W;
    floorCanvas.height = overlayCanvas.height = SCREEN_H;

    const gl = floorCanvas.getContext('webgl', { antialias: false });
    if (!gl) throw new Error('WebGL não está disponível neste navegador.');
    this.gl = gl;
    this.overlay = overlayCanvas.getContext('2d')!;
    this.image = this.overlay.createImageData(SCREEN_W, SCREEN_H);

    this.prog = link(gl, VERT, FRAG);
    gl.useProgram(this.prog);
    for (const name of UNIFORMS) this.uniforms[name] = gl.getUniformLocation(this.prog, name);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.mapTex = gl.createTexture()!;
    this.fillTex = gl.createTexture()!;
    this.bgFrontTex = gl.createTexture()!;
    this.bgBackTex = gl.createTexture()!;
  }

  /** Loads a track and the driver frames (already colored with its palettes) for the characters in the race. */
  setTrack(track: Track, drivers: Map<number, DriverSprites | null>, itemFrames: SpriteFrame[] = []) {
    this.itemFrames = itemFrames;
    const gl = this.gl;
    upload(gl, this.mapTex, MAP_PX, MAP_PX, track.pixels);
    upload(gl, this.fillTex, 8, 8, track.fill);
    upload(gl, this.bgFrontTex, BG_FRONT_W, BG_HEIGHT, track.background.front);
    upload(gl, this.bgBackTex, BG_BACK_W, BG_HEIGHT, track.background.back);
    this.sky = track.backColor.map((v) => v / 255);

    this.objectFrames = track.objectFrames;
    this.drivers.clear();
    for (const [character, sprites] of drivers) {
      if (sprites) this.drivers.set(character, withRowHeights(sprites));
    }
    // Sprites and HUD use the track's palettes, as on the SNES.
    if (this.gfx) {
      this.layer = new Layer(this.gfx.obj, this.gfx.hud, track.colors);
      this.hud = new RaceHud(this.layer);
    }
  }

  /** Re-uploads map tiles that changed (broken blocks). */
  updateTiles(track: Track, tiles: number[]) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
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
    gl.viewport(0, 0, SCREEN_W, SCREEN_H);
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const layer = this.layer;
    if (!layer) return;
    this.tick++;
    layer.clear();
    layer.setClip(HORIZON, VIEW_BOTTOM);
    drawRaceView(layer, cam, sprites, objects, { drivers: this.drivers, objectFrames: this.objectFrames, itemFrames: this.itemFrames }, this.tick);
    layer.setClip(MAP_TOP, MAP_BOTTOM);
    for (const m of markers) {
      const p = mapPoint(m.x, m.y);
      if (p) this.hud!.head(m.character, p.x, p.y, m.palette);
    }
    layer.setClip();
    hud(this.hud!);
    this.image.data.set(layer.px);
    this.overlay.putImageData(this.image, 0, 0);
  }

}

export interface SpriteSet {
  drivers: Map<number, DriverFrames>;
  objectFrames: SpriteFrame[];
  itemFrames: SpriteFrame[];
}

/** Drivers, track objects and items of the race view, far to near, at the SNES resolution. */
export function drawRaceView(layer: Layer, cam: Camera, sprites: Sprite[], objects: ObjectSprite[], set: SpriteSet, tick: number) {
  const fx = Math.sin(cam.angle), fy = -Math.cos(cam.angle);
  const rx = Math.cos(cam.angle), ry = Math.sin(cam.angle);
  const project = <T extends { x: number; y: number }>(s: T) => {
    const dx = s.x - cam.x, dy = s.y - cam.y;
    return { s, dx, dy, z: dx * fx + dy * fy, lat: dx * rx + dy * ry };
  };
  type Item = ReturnType<typeof project<Sprite>> | (ReturnType<typeof project<ObjectSprite>> & { object: true });
  const items: Item[] = [
    ...sprites.map(project),
    ...objects.map((o) => ({ ...project(o), object: true as const })),
  ];
  const projected = items.filter((p) => p.z > 4 && p.z < 900).sort((a, b) => b.z - a.z);

  for (const item of projected) {
    const k = FOCAL / item.z; // screen px per world px
    const sx = SCREEN_W / 2 + item.lat * k;
    const ground = HORIZON + (CAM_HEIGHT * FOCAL) / item.z;
    if ('object' in item) {
      const o = item.s;
      const frames = o.item ? set.itemFrames : set.objectFrames;
      const img = frames[o.frame] ?? frames[0];
      if (!img) continue;
      // 16x16 frames: objects are drawn 32px at the chase distance (like the karts), items 16px.
      const size = Math.round((o.item ? 16 : 32) * (CHASE_DISTANCE / item.z));
      if (size < 1) continue;
      layer.scaled(img, Math.round(sx - size / 2), Math.round(ground - o.lift * k - size), size, size);
      continue;
    }
    const { s, dx, dy } = item;
    const driver = set.drivers.get(s.character);
    if (!driver) continue;
    const wanted = driver.rowHeights[0] * (CHASE_DISTANCE / item.z) * (s.scale ?? 1);
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
    layer.frame(f, Math.round(sx - f.w / 2), Math.round(ground - (s.lift ?? 0) * k - f.h), rel < 0, s.alpha ?? 1, flash);
  }
}

/** Where a world position shows on the course map (lower screen), or null outside it. */
export function mapPoint(x: number, y: number): { x: number; y: number } | null {
  const u = y / MAP_PX;
  if (u < 0 || u > 1) return null;
  const t = u / (1 + MAP_TILT - MAP_TILT * u);
  const scale = (MAP_SCALE * (1 + MAP_TILT)) / (1 + MAP_TILT * t);
  return { x: SCREEN_W / 2 + (x - MAP_PX / 2) / scale, y: MAP_TOP + t * (MAP_BOTTOM - MAP_TOP) };
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
