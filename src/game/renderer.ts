// Mode 7 floor + parallax background in WebGL at the SNES resolution (256x224),
// plus a 2D overlay for the driver sprites.

import { BG_BACK_W, BG_FRONT_W, BG_HEIGHT, MAP_PX, type DriverSprites, type SpriteFrame, type Track } from '../rom/rom';

export const SCREEN_W = 256;
export const SCREEN_H = 224;
const HORIZON = 64;
const FOCAL = 150;
const CAM_HEIGHT = 20;
const OVERLAY_SCALE = 4;
/** Camera-to-own-kart distance; at this depth the nearest (largest) driver frames are drawn 1:1. */
export const CHASE_DISTANCE = 34;

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
  color: string;
  /** Index into CHARACTERS; drawn with the ROM's driver frames when available. */
  character: number;
  label?: string;
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
uniform vec2 uRes;
uniform vec2 uCam;
uniform float uAngle;
uniform float uHorizon;
uniform float uHeight;
uniform float uFocal;
uniform vec3 uSky;
uniform vec2 uBgScroll;

void main() {
  float sy = uRes.y - gl_FragCoord.y;
  float sx = gl_FragCoord.x;
  float dy = sy - uHorizon;
  if (dy <= 0.0) {
    // Sky, with the two scenery layers sitting on the horizon. Each layer wraps once per full turn.
    vec3 c = uSky;
    float by = sy - (uHorizon - ${BG_HEIGHT}.0);
    if (by >= 0.0) {
      float v = (floor(by) + 0.5) / ${BG_HEIGHT}.0;
      vec4 back = texture2D(uBgBack, vec2(fract((floor(sx) + uBgScroll.y + 0.5) / ${BG_BACK_W}.0), v));
      vec4 front = texture2D(uBgFront, vec2(fract((floor(sx) + uBgScroll.x + 0.5) / ${BG_FRONT_W}.0), v));
      c = mix(c, back.rgb, back.a);
      c = mix(c, front.rgb, front.a);
    }
    gl_FragColor = vec4(c, 1.0);
    return;
  }
  float z = uHeight * uFocal / dy;
  float lateral = (sx - uRes.x * 0.5) * z / uFocal;
  vec2 fwd = vec2(sin(uAngle), -cos(uAngle));
  vec2 right = vec2(cos(uAngle), sin(uAngle));
  vec2 w = uCam + fwd * z + right * lateral;
  vec3 c;
  if (w.x < 0.0 || w.y < 0.0 || w.x >= ${MAP_PX}.0 || w.y >= ${MAP_PX}.0) {
    c = texture2D(uFill, mod(w, 8.0) / 8.0).rgb;
  } else {
    c = texture2D(uMap, w / ${MAP_PX}.0).rgb;
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

const UNIFORMS = ['uMap', 'uFill', 'uBgFront', 'uBgBack', 'uRes', 'uCam', 'uAngle', 'uHorizon', 'uHeight', 'uFocal', 'uSky', 'uBgScroll'];

interface DriverFrames {
  /** frames[distanceRow][angleSlot] */
  frames: HTMLCanvasElement[][];
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
  private sky: number[] = [0, 0, 0];
  private drivers = new Map<number, DriverFrames>();
  private objectFrames: HTMLCanvasElement[] = [];
  private itemFrames: HTMLCanvasElement[] = [];
  private tick = 0;

  constructor(floorCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement) {
    floorCanvas.width = SCREEN_W;
    floorCanvas.height = SCREEN_H;
    overlayCanvas.width = SCREEN_W * OVERLAY_SCALE;
    overlayCanvas.height = SCREEN_H * OVERLAY_SCALE;

    const gl = floorCanvas.getContext('webgl', { antialias: false });
    if (!gl) throw new Error('WebGL não está disponível neste navegador.');
    this.gl = gl;
    this.overlay = overlayCanvas.getContext('2d')!;
    this.overlay.imageSmoothingEnabled = false;

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
    this.itemFrames = itemFrames.map(frameCanvas);
    const gl = this.gl;
    upload(gl, this.mapTex, MAP_PX, MAP_PX, track.pixels);
    upload(gl, this.fillTex, 8, 8, track.fill);
    upload(gl, this.bgFrontTex, BG_FRONT_W, BG_HEIGHT, track.background.front);
    upload(gl, this.bgBackTex, BG_BACK_W, BG_HEIGHT, track.background.back);
    this.sky = track.backColor.map((v) => v / 255);

    this.objectFrames = track.objectFrames.map(frameCanvas);
    this.drivers.clear();
    for (const [character, sprites] of drivers) {
      if (sprites) this.drivers.set(character, toCanvases(sprites));
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

  render(cam: Camera, sprites: Sprite[], objects: ObjectSprite[] = []) {
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
    gl.uniform2f(u.uRes, SCREEN_W, SCREEN_H);
    gl.uniform2f(u.uCam, cam.x, cam.y);
    gl.uniform1f(u.uAngle, cam.angle);
    gl.uniform1f(u.uHorizon, HORIZON);
    gl.uniform1f(u.uHeight, CAM_HEIGHT);
    gl.uniform1f(u.uFocal, FOCAL);
    gl.uniform3fv(u.uSky, this.sky);
    // One full turn scrolls each layer by its own width; the back layer is half as wide, so it moves slower.
    const turn = cam.angle / (Math.PI * 2);
    gl.uniform2f(u.uBgScroll, turn * BG_FRONT_W, turn * BG_BACK_W);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.drawSprites(cam, sprites, objects);
  }

  private drawObject(o: ObjectSprite, z: number, lat: number) {
    const frames = o.item ? this.itemFrames : this.objectFrames;
    const img = frames[o.frame] ?? frames[0];
    if (!img) return;
    const S = OVERLAY_SCALE;
    const k = FOCAL / z;
    // 16x16 frames: objects are drawn 32px tall at the chase distance (like the karts), items 16px.
    const size = (o.item ? 16 : 32) * (CHASE_DISTANCE / z) * S;
    if (size < 2) return;
    const sx = (SCREEN_W / 2 + lat * k) * S;
    const sy = (HORIZON + (CAM_HEIGHT * FOCAL) / z - o.lift * k) * S;
    this.overlay.drawImage(img, sx - size / 2, sy - size, size, size);
  }

  private drawSprites(cam: Camera, sprites: Sprite[], objects: ObjectSprite[]) {
    const ctx = this.overlay;
    const S = OVERLAY_SCALE;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.tick++;

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
      if ('object' in item) {
        this.drawObject(item.s, item.z, item.lat);
        continue;
      }
      const { s, dx, dy, z, lat } = item;
      const k = FOCAL / z; // screen px per world px
      const sx = (SCREEN_W / 2 + lat * k) * S;
      const sy = (HORIZON + (CAM_HEIGHT * FOCAL) / z - (s.lift ?? 0) * k) * S;
      const shrink = s.scale ?? 1;

      // Heading relative to the line of sight: 0 = seen from behind, ±π = seen from the front.
      let rel = s.angle - Math.atan2(dx, -dy);
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));

      const driver = this.drivers.get(s.character);
      let top: number;
      if (driver) {
        const wanted = driver.rowHeights[0] * (CHASE_DISTANCE / z) * shrink;
        if (wanted < 1) continue;
        // Pick the hand-drawn size closest to the wanted one, then scale it the rest of the way.
        let row = 0;
        for (let r = 1; r < driver.rowHeights.length; r++) {
          if (Math.abs(driver.rowHeights[r] - wanted) < Math.abs(driver.rowHeights[row] - wanted)) row = r;
        }
        const slot = Math.min(15, Math.round((Math.abs(rel) / Math.PI) * 15));
        const frame = driver.frames[row][slot];
        const scale = (wanted / driver.rowHeights[row]) * S;
        const w = frame.width * scale, h = frame.height * scale;
        ctx.save();
        ctx.globalAlpha = s.alpha ?? 1;
        if (s.flash && (this.tick >> 2) % 2 === 0) ctx.filter = 'brightness(1.9) saturate(1.6)';
        ctx.translate(sx, sy);
        // Frames face right; mirror for karts turned to the left.
        if (rel < 0) ctx.scale(-1, 1);
        ctx.drawImage(frame, -w / 2, -h, w, h);
        ctx.restore();
        top = sy - h;
      } else {
        const size = 8 * k * S * shrink;
        if (size < 2) continue;
        drawKart(ctx, sx, sy, size, s.color, rel);
        top = sy - size;
      }

      if (s.label && z < 300) {
        const fontPx = Math.max(16, Math.min(28, 900 / z));
        ctx.font = `bold ${fontPx}px monospace`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#000';
        ctx.fillStyle = s.color;
        ctx.strokeText(s.label, sx, top - 6);
        ctx.fillText(s.label, sx, top - 6);
      }
    }
  }
}

function frameCanvas(f: { w: number; h: number; pixels: Uint8Array }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = f.w;
  c.height = f.h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.pixels), f.w, f.h), 0, 0);
  return c;
}

function toCanvases(sprites: DriverSprites): DriverFrames {
  const frames = sprites.rows.map((row) =>
    row.map((f) => {
      const c = document.createElement('canvas');
      c.width = f.w;
      c.height = f.h;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.pixels), f.w, f.h), 0, 0);
      return c;
    }),
  );
  // Visible height of a side view in each row (frames are bottom-aligned in their box).
  const rowHeights = sprites.rows.map((row) => {
    const f = row[8];
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) if (f.pixels[(y * f.w + x) * 4 + 3]) return f.h - y;
    }
    return f.h;
  });
  return { frames, rowHeights };
}

/** Fallback pixel-art kart, drawn bottom-centered at (x, y). `rel` = heading relative to the line of sight. */
function drawKart(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, rel: number) {
  const u = size / 8;
  const side = Math.sin(rel);
  const w = 6 + Math.abs(side) * 2;
  const left = x - (w / 2) * u;
  const top = y - 7 * u;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(left, y - u, w * u, u);
  ctx.fillStyle = '#111';
  ctx.fillRect(left - u * 0.5, y - 3 * u, 2 * u, 2.5 * u);
  ctx.fillRect(left + (w - 1.5) * u, y - 3 * u, 2 * u, 2.5 * u);
  ctx.fillStyle = color;
  ctx.fillRect(left + u, top + 3 * u, (w - 2) * u, 3.5 * u);
  ctx.fillStyle = '#ffd7a8';
  ctx.fillRect(x - u * 1.25 + side * u, top + 0.5 * u, 2.5 * u, 2.5 * u);
  ctx.fillStyle = color;
  ctx.fillRect(x - u * 1.5 + side * u, top, 3 * u, 1.2 * u);
  if (Math.cos(rel) < 0) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - u + side * 2 * u, top + 4 * u, 2 * u, u);
  }
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
