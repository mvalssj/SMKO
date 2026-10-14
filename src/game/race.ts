// One race: local kart simulation, remote karts, items, camera, HUD and minimap.
// Works offline (solo practice, items run by a LocalChannel) or online (NetClient).

import {
  CC_SPEED, CHARACTER_NAMES, EFFECT_GHOST, EFFECT_SHRUNK, EFFECT_STAR, ITEM_KINDS, KART_COLORS, NET_HZ, TOTAL_LAPS,
  type Cc, type ItemKind, type KartNetState, type PlayerInfo, type ServerMsg,
} from '../../shared/protocol';
import { ROULETTE_MS } from '../../shared/items';
import { Genre, MAP_PX, MAP_SIZE, TILE, type DriverSprites, type ItemGraphics, type SpriteFrame, type Track } from '../rom/rom';
import { RemoteKarts, type NetClient } from '../net/client';
import type { Channel } from '../net/local';
import { readInput } from './input';
import {
  NO_INPUT, STEP_MS, applyBreak, coverTiles, createKart, featherJump, isInvincible, kartHeight, raceGeometry,
  restoreTiles, spinOut, stepKart, tileCluster, type Kart, type SavedTile,
} from './physics';
import { CHASE_DISTANCE, Renderer, type ObjectSprite, type Sprite } from './renderer';
import { CpuDriver, rubberBand } from './cpu';
import { objectState } from './objects';
import { ITEM_HIT_DISTANCE, OWNER_GRACE_FRAMES, advanceEntity, createEntity, type Entity } from './items';

const STAR_FRAMES = 60 * 8;
const GHOST_FRAMES = 60 * 5;
const SHRINK_FRAMES = 60 * 5;

export interface RaceOptions {
  track: Track;
  slot: number;
  selfId: number;
  players: PlayerInfo[];
  startInMs: number;
  /** Online room (kart states); null in solo practice. */
  net: NetClient | null;
  /** Item messages: the NetClient online, a LocalChannel in solo practice. */
  channel: Channel;
  hud: Hud;
  renderer: Renderer;
  /** Driver frames per character in this race (colored with the track's palettes). */
  drivers: Map<number, DriverSprites | null>;
  itemGfx: ItemGraphics;
  /** Engine class: scales everyone's top speed. */
  cc: Cc;
  /** False in Time Trial: no item boxes, coins or thrown items. */
  items: boolean;
  /** CPUs this client simulates (solo, or the online room's CPU host); empty otherwise. */
  cpus: { id: number; slot: number; skill: number }[];
  /** Joined mid-race: no kart of our own, the camera follows a racer (← → to switch). */
  spectate?: boolean;
}

interface Cpu {
  id: number;
  kart: Kart;
  driver: CpuDriver;
  finishedAt: number;
}

export interface RaceResult {
  id: number;
  timeMs: number | null;
}

export interface Hud {
  lap: HTMLElement;
  place: HTMLElement;
  time: HTMLElement;
  countdown: HTMLElement;
  minimap: HTMLCanvasElement;
  item: HTMLCanvasElement;
  coins: HTMLElement;
}

export class Race {
  private kart: Kart;
  private geo;
  private remote = new RemoteKarts();
  private cam = { x: 0, y: 0, angle: 0 };
  private raf = 0;
  private last = 0;
  private acc = 0;
  private frame = 0;
  private startAt: number;
  private finishedAt = 0;
  private minimapBg: HTMLCanvasElement;
  private unsubs: (() => void)[] = [];

  private item: ItemKind | null = null;
  private rollingUntil = 0;
  private itemHeld = false;
  private pickupCooldown = 0;
  private starTouchCooldown = 0;
  private entities = new Map<number, Entity>();
  private savedTiles = new Map<number, SavedTile>();
  private iconCanvases: HTMLCanvasElement[];
  private cpus: Cpu[];
  /** Ids simulated here: this player and its CPUs. */
  private local: Set<number>;
  /** Spectating: place (0 = leader) of the kart the camera follows. */
  private watchPlace = 0;

  constructor(private o: RaceOptions) {
    this.kart = createKart(o.track, o.slot);
    this.kart.speedScale = CC_SPEED[o.cc];
    this.cpus = o.cpus.map((c) => {
      const kart = createKart(o.track, c.slot);
      return { id: c.id, kart, driver: new CpuDriver(o.track, kart, c.skill), finishedAt: 0 };
    });
    this.local = new Set([o.selfId, ...o.cpus.map((c) => c.id)]);
    this.geo = raceGeometry(o.track);
    this.startAt = performance.now() + o.startInMs;
    this.placeCamera(true);
    o.renderer.setTrack(o.track, o.drivers, [3, 4, 5].map((i) => cutout(o.itemGfx.icons[i])));
    this.minimapBg = buildMinimap(o.track);
    this.iconCanvases = o.itemGfx.icons.map(toCanvas);
    o.hud.coins.textContent = '0';
    this.drawItemBox(0);

    if (o.net) {
      this.unsubs.push(o.net.on((m) => {
        if (m.t === 'states') this.remote.push(m.karts, this.local);
        else if (m.t === 'break') {
          applyBreak(o.track, m.tiles);
          o.renderer.updateTiles(o.track, m.tiles);
        }
      }));
    }
    this.unsubs.push(o.channel.on((m) => this.onItemMessage(m)));
    if (o.spectate) {
      const key = (e: KeyboardEvent) => {
        if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.watchPlace--;
        else if (e.code === 'ArrowRight' || e.code === 'KeyD') this.watchPlace++;
      };
      addEventListener('keydown', key);
      this.unsubs.push(() => removeEventListener('keydown', key));
    }
  }

  /** Spectating: the racers by place, and the one being followed. */
  private watched(remotes: KartNetState[]): KartNetState | null {
    if (!remotes.length) return null;
    const order = [...remotes].sort((a, b) => b.p - a.p);
    const n = order.length;
    return order[((this.watchPlace % n) + n) % n];
  }

  start() {
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.acc += Math.min(250, now - this.last);
      this.last = now;
      while (this.acc >= STEP_MS) {
        this.step(now);
        this.acc -= STEP_MS;
      }
      this.draw(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
  }

  /** Frames since the start signal (negative during the countdown). Same on every client. */
  private raceFrame(now: number) {
    return Math.floor((now - this.startAt) / STEP_MS);
  }

  player(id: number): PlayerInfo | undefined {
    return this.o.players.find((p) => p.id === id);
  }

  get finished() {
    return this.finishedAt > 0;
  }

  // ---------- Items ----------

  private onItemMessage(m: ServerMsg) {
    const o = this.o;
    const k = this.kart;
    switch (m.t) {
      case 'item':
        this.item = m.item;
        this.rollingUntil = m.roll ? performance.now() + ROULETTE_MS : 0;
        break;
      case 'coins':
        k.coins = m.coins;
        o.hud.coins.textContent = String(m.coins);
        break;
      case 'tiles':
        if (m.restore) restoreTiles(o.track, this.savedTiles, m.tiles);
        else for (const [i, s] of coverTiles(o.track, m.tiles)) this.savedTiles.set(i, s);
        o.renderer.updateTiles(o.track, m.tiles);
        break;
      case 'spawn':
        this.entities.set(m.e.id, createEntity(m.e));
        break;
      case 'despawn':
        this.entities.delete(m.id);
        break;
      case 'effect':
        if (m.id === o.selfId) {
          if (m.kind === 'mushroom') k.boost = 60;
          else if (m.kind === 'star') k.star = STAR_FRAMES;
          else if (m.kind === 'feather') featherJump(k);
          else if (m.kind === 'ghost') k.ghost = GHOST_FRAMES;
        } else if (m.kind === 'lightning') {
          if (!isInvincible(k)) {
            k.shrink = SHRINK_FRAMES;
            spinOut(k);
            this.item = null;
          }
          for (const c of this.cpus) {
            if (c.id !== m.id && !isInvincible(c.kart)) { c.kart.shrink = SHRINK_FRAMES; spinOut(c.kart); }
          }
        }
        break;
    }
  }

  private stepItems(now: number, input: ReturnType<typeof readInput>, racing: boolean) {
    const o = this.o;
    const k = this.kart;
    const frame = this.raceFrame(now);

    // Use the held item on button press (not while it's still rolling).
    const pressed = !!input.item && !this.itemHeld;
    this.itemHeld = !!input.item;
    if (pressed && racing && this.item && now >= this.rollingUntil && k.fall === 0 && !this.finishedAt) {
      o.channel.send({ t: 'use', x: k.x, y: k.y, a: k.angle, back: input.brake });
      this.item = null;
    }

    // Item boxes and coins under the kart.
    if (this.pickupCooldown > 0) this.pickupCooldown--;
    if (o.items && racing && k.air === 0 && k.fall === 0 && this.pickupCooldown === 0) {
      const tx = Math.floor(k.x / TILE), ty = Math.floor(k.y / TILE);
      const g = o.track.genres[ty * MAP_SIZE + tx];
      if (g === Genre.ItemBlock && !this.item && now >= this.rollingUntil) {
        o.channel.send({ t: 'box', tiles: tileCluster(o.track, tx, ty, Genre.ItemBlock, 2) });
        this.pickupCooldown = 20;
      } else if (g === Genre.Coin) {
        o.channel.send({ t: 'coin', tiles: tileCluster(o.track, tx, ty, Genre.Coin, 1) });
        this.pickupCooldown = 6;
      }
    }

    // Move bananas and shells; check whether one hits this kart.
    const remotes = this.remote.sample();
    const targetPos = (id: number) =>
      id === o.selfId ? k : this.cpus.find((c) => c.id === id)?.kart ?? remotes.find((r) => r.id === id) ?? null;
    for (const e of this.entities.values()) {
      advanceEntity(e, o.track, frame, targetPos);
      if (e.dead) { this.entities.delete(e.id); continue; }
      const fresh = frame - e.frame < OWNER_GRACE_FRAMES;
      // Our kart and our CPUs: a star or Boo destroys the item without getting hurt (spinOut checks that).
      const victims: [number | undefined, Kart][] = [[undefined, k], ...this.cpus.map((c) => [c.id, c.kart] as [number, Kart])];
      for (const [cpu, v] of victims) {
        if ((cpu ?? o.selfId) === e.owner && fresh) continue;
        if (v.air > 0 || v.fall > 0 || Math.hypot(e.x - v.x, e.y - v.y) >= ITEM_HIT_DISTANCE) continue;
        o.channel.send({ t: 'hit', entity: e.id, cpu });
        this.entities.delete(e.id);
        spinOut(v);
        break;
      }
    }

    // A star spins out the CPUs we touch.
    if (k.star > 0) for (const c of this.cpus) if (Math.hypot(c.kart.x - k.x, c.kart.y - k.y) < 10) spinOut(c.kart);

    // Touching a kart that has a star spins us out.
    if (this.starTouchCooldown > 0) this.starTouchCooldown--;
    for (const r of remotes) {
      if (r.e & EFFECT_STAR && this.starTouchCooldown === 0 && Math.hypot(r.x - k.x, r.y - k.y) < 10) {
        spinOut(k);
        this.starTouchCooldown = 60;
      }
    }
  }

  // ---------- Simulation ----------

  private step(now: number) {
    const racing = now >= this.startAt;
    if (this.o.spectate) {
      // Thrown items still move on screen; the camera rides behind the followed kart.
      const frame = this.raceFrame(now);
      const remotes = this.remote.sample();
      const pos = (id: number) => remotes.find((r) => r.id === id) ?? null;
      for (const e of this.entities.values()) {
        advanceEntity(e, this.o.track, frame, pos);
        if (e.dead) this.entities.delete(e.id);
      }
      const w = this.watched(remotes);
      if (w) this.placeCamera(false, w.x, w.y, w.a);
      return;
    }
    const input = racing ? readInput() : NO_INPUT;
    // Shrunk karts and Boos can be driven through.
    const others = [...this.remote.sample(), ...this.cpus.map((c) => netState(c.id, c.kart))]
      .filter((r) => r.f === 0 && !(r.e & (EFFECT_GHOST | EFFECT_SHRUNK)));
    const lapBefore = this.kart.lap;
    const ev = stepKart(this.kart, input, this.o.track, this.geo, others, this.raceFrame(now));
    if (ev.broken.length) {
      this.o.renderer.updateTiles(this.o.track, ev.broken);
      this.o.net?.send({ t: 'break', tiles: ev.broken });
    }
    this.stepItems(now, input, racing);
    this.stepCpus(now, racing);

    if (this.kart.lap > TOTAL_LAPS && !this.finishedAt && lapBefore === TOTAL_LAPS) {
      this.finishedAt = now;
      this.o.net?.send({ t: 'finish', timeMs: Math.round(now - this.startAt) });
    }

    this.placeCamera(false);
    // Positions go to the server online, or to the local item authority in solo (for item odds by place).
    if (++this.frame % Math.round(60 / NET_HZ) === 0) {
      const { id: _id, ...state } = netState(this.o.selfId, this.kart);
      (this.o.net ?? this.o.channel).send({ t: 'state', k: state });
    }
  }

  private stepCpus(now: number, racing: boolean) {
    if (!this.cpus.length) return;
    const o = this.o;
    const frame = this.raceFrame(now);
    const remotes = this.remote.sample();
    // Rubber band against the best human (CPUs are never in the remote list on the CPU host).
    const humans = [this.kart.progress, ...remotes.map((r) => r.p)];
    const best = Math.max(...humans);
    const all = [this.kart, ...this.cpus.map((c) => c.kart), ...remotes.filter((r) => r.f === 0)];
    for (const c of this.cpus) {
      const k = c.kart;
      k.speedScale = rubberBand(c.driver.skill, k.progress - best) * CC_SPEED[o.cc];
      const others = all.filter((x) => x !== k);
      const ev = stepKart(k, racing ? c.driver.input(k) : NO_INPUT, o.track, this.geo, others, frame);
      if (ev.broken.length) {
        o.renderer.updateTiles(o.track, ev.broken);
        o.net?.send({ t: 'break', tiles: ev.broken });
      }
      if (racing && !c.finishedAt && k.fall === 0 && c.driver.wantsDrop()) {
        o.channel.send({ t: 'cpuDrop', cpu: c.id, x: k.x, y: k.y, a: k.angle });
      }
      if (k.lap > TOTAL_LAPS && !c.finishedAt) {
        c.finishedAt = now;
        o.net?.send({ t: 'finish', timeMs: Math.round(now - this.startAt), cpu: c.id });
      }
    }
    if (this.frame % Math.round(60 / NET_HZ) === 0) {
      (o.net ?? o.channel).send({ t: 'cpu', karts: this.cpus.map((c) => netState(c.id, c.kart)) });
    }
  }

  /** Finishing order of this client's race (solo practice results). */
  results(): RaceResult[] {
    const me = { id: this.o.selfId, at: this.finishedAt, p: this.finishedAt ? Infinity : this.kart.progress };
    const rows = [me, ...this.cpus.map((c) => ({ id: c.id, at: c.finishedAt, p: c.kart.progress }))];
    rows.sort((a, b) => (a.at && b.at ? a.at - b.at : a.at ? -1 : b.at ? 1 : b.p - a.p));
    return rows.map((r) => ({ id: r.id, timeMs: r.at ? Math.round(r.at - this.startAt) : null }));
  }

  private placeCamera(snap: boolean, x = this.kart.x, y = this.kart.y, angle = this.kart.angle) {
    let da = angle - this.cam.angle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.cam.angle += snap ? da : da * 0.12;
    const back = CHASE_DISTANCE;
    this.cam.x = x - Math.sin(this.cam.angle) * back;
    this.cam.y = y + Math.cos(this.cam.angle) * back;
  }

  // ---------- Drawing ----------

  private draw(now: number) {
    const o = this.o;
    const remotes = [...this.remote.sample(), ...this.cpus.map((c) => netState(c.id, c.kart))];
    const charOf = (id: number) => o.players.find((p) => p.id === id)?.character ?? 0;
    const colorOf = (id: number) => KART_COLORS[charOf(id)];
    const nameOf = (id: number) => CHARACTER_NAMES[charOf(id)];

    const watched = o.spectate ? this.watched(remotes) : null;
    const sprites: Sprite[] = remotes.map((r) => ({
      x: r.x, y: r.y, angle: r.a, color: colorOf(r.id), character: charOf(r.id), label: r === watched ? undefined : nameOf(r.id),
      scale: (r.f > 0 ? r.f / 70 : 1) * (r.e & EFFECT_SHRUNK ? 0.5 : 1), lift: r.h,
      alpha: r.e & EFFECT_GHOST ? 0.15 : 1, flash: !!(r.e & EFFECT_STAR),
    }));
    const me = this.kart;
    if (!o.spectate) sprites.push({
      x: me.x, y: me.y, angle: me.angle, color: colorOf(o.selfId), character: charOf(o.selfId),
      scale: (me.fall > 0 ? me.fall / 70 : 1) * (me.shrink > 0 ? 0.5 : 1), lift: kartHeight(me),
      alpha: me.ghost > 0 ? 0.45 : 1, flash: me.star > 0,
    });

    const frame = this.raceFrame(now);
    const objects: ObjectSprite[] = [];
    o.track.objects.forEach((obj, i) => {
      const st = objectState(obj.kind, i, frame);
      if (st.visible) objects.push({ x: obj.x, y: obj.y, lift: st.height, frame: Math.floor(frame / 8) % Math.max(1, o.track.objectFrames.length) });
    });
    for (const e of this.entities.values()) {
      objects.push({ x: e.x, y: e.y, lift: 0, item: true, frame: e.kind === 'banana' ? 0 : e.kind === 'greenShell' ? 1 : 2 });
    }
    o.renderer.render(this.cam, sprites, objects);

    if (o.spectate) {
      this.drawSpectatorHud(now, remotes, watched, nameOf);
      this.drawMinimap(remotes, colorOf, watched?.id);
      return;
    }

    // HUD
    const lap = Math.min(TOTAL_LAPS, Math.max(1, me.lap));
    o.hud.lap.textContent = this.finishedAt ? 'FIM!' : `VOLTA ${lap}/${TOTAL_LAPS}`;
    const all: { id: number; p: number }[] = [{ id: o.selfId, p: me.progress }, ...remotes.map((r) => ({ id: r.id, p: r.p }))];
    if (this.finishedAt) all[0].p = Infinity;
    const place = all.filter((x) => x.p > me.progress).length + 1;
    o.hud.place.textContent = o.net || this.cpus.length ? `${place}º` : '';
    const t = this.finishedAt ? this.finishedAt - this.startAt : Math.max(0, now - this.startAt);
    o.hud.time.textContent = formatTime(t);

    const left = this.startAt - now;
    o.hud.countdown.textContent = left > 3000 ? '' : left > 0 ? String(Math.ceil(left / 1000)) : left > -800 ? 'JÁ!' : '';

    this.drawItemBox(now);
    this.drawMinimap(remotes, colorOf);
  }

  private drawSpectatorHud(now: number, remotes: KartNetState[], w: KartNetState | null, nameOf: (id: number) => string) {
    const o = this.o;
    const lap = Math.min(TOTAL_LAPS, Math.max(1, w?.lap ?? 1));
    o.hud.lap.textContent = w ? `ASSISTINDO ${nameOf(w.id).toUpperCase()} · VOLTA ${lap}/${TOTAL_LAPS}  (← → troca)` : 'ASSISTINDO';
    o.hud.place.textContent = w ? `${remotes.filter((r) => r.p > w.p).length + 1}º` : '';
    o.hud.time.textContent = formatTime(Math.max(0, now - this.startAt));
    const left = this.startAt - now;
    o.hud.countdown.textContent = left > 3000 ? '' : left > 0 ? String(Math.ceil(left / 1000)) : left > -800 ? 'JÁ!' : '';
    this.drawItemBox(0);
  }

  private drawItemBox(now: number) {
    const c = this.o.hud.item;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    let icon: number | null = null;
    // Roulette: cycle through the icons until the rolled item shows up.
    if (now < this.rollingUntil) icon = Math.floor(now / 70) % ITEM_KINDS.length;
    else if (this.item) icon = ITEM_KINDS.indexOf(this.item);
    if (icon !== null) ctx.drawImage(this.iconCanvases[icon], 0, 0);
  }

  private drawMinimap(remotes: KartNetState[], colorOf: (id: number) => string, highlight?: number) {
    const c = this.o.hud.minimap;
    const ctx = c.getContext('2d')!;
    const s = c.width / MAP_PX;
    ctx.drawImage(this.minimapBg, 0, 0, c.width, c.height);
    const dot = (x: number, y: number, color: string, r: number) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(x * s - r - 1, y * s - r - 1, r * 2 + 2, r * 2 + 2);
      ctx.fillStyle = color;
      ctx.fillRect(x * s - r, y * s - r, r * 2, r * 2);
    };
    for (const r of remotes) dot(r.x, r.y, colorOf(r.id), r.id === highlight ? 4 : 3);
    if (!this.o.spectate) dot(this.kart.x, this.kart.y, colorOf(this.o.selfId), 4);
  }
}

function netState(id: number, k: Kart): KartNetState {
  const e = (k.star > 0 ? EFFECT_STAR : 0) | (k.ghost > 0 ? EFFECT_GHOST : 0) | (k.shrink > 0 ? EFFECT_SHRUNK : 0);
  return { id, x: r1(k.x), y: r1(k.y), a: r3(k.angle), s: r3(k.speed), lap: k.lap, p: k.progress, f: k.fall, h: r1(kartHeight(k)), e };
}

function toCanvas(f: SpriteFrame): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = f.w;
  c.height = f.h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.pixels), f.w, f.h), 0, 0);
  return c;
}

/** HUD icons have a solid background: clear it (flood fill from the border) to use them as track sprites. */
function cutout(f: SpriteFrame): SpriteFrame {
  const px = new Uint8Array(f.pixels);
  const bg = [px[0], px[1], px[2]];
  const same = (i: number) => px[i * 4 + 3] && px[i * 4] === bg[0] && px[i * 4 + 1] === bg[1] && px[i * 4 + 2] === bg[2];
  const stack: number[] = [];
  for (let x = 0; x < f.w; x++) stack.push(x, (f.h - 1) * f.w + x);
  for (let y = 0; y < f.h; y++) stack.push(y * f.w, y * f.w + f.w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (!same(i)) continue;
    px[i * 4 + 3] = 0;
    const x = i % f.w, y = Math.floor(i / f.w);
    if (x > 0) stack.push(i - 1);
    if (x < f.w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - f.w);
    if (y < f.h - 1) stack.push(i + f.w);
  }
  // The bottom row is the HUD box border.
  px.fill(0, (f.h - 1) * f.w * 4);
  return { w: f.w, h: f.h, pixels: px };
}

function buildMinimap(track: Track): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = MAP_PX;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(track.pixels), MAP_PX, MAP_PX), 0, 0);
  return c;
}

export function formatTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}'${String(s).padStart(2, '0')}"${String(cs).padStart(2, '0')}`;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
