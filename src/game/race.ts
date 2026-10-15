// One race: local kart simulation, remote karts, items, camera, and the original HUD (timer, Lakitu, map).
// Works offline (solo practice, items run by a LocalChannel) or online (NetClient).

import {
  BATTLE_BALLOONS, CHARACTER_NAMES, EFFECT_BOOST, EFFECT_GHOST, EFFECT_SHRUNK, EFFECT_STAR, ITEM_KINDS, NET_HZ, TOTAL_LAPS,
  CPU_SPECIAL, type Cc, type EntityKind, type ItemKind, type KartNetState, type PlayerInfo, type ServerMsg,
} from '../../shared/protocol';
import { ROULETTE_MS, START_COINS } from '../../shared/items';
import { CHARACTERS, Genre, MAP_SIZE, TILE, type DriverSprites, type ItemGraphics, type SpriteFrame, type Track } from '../rom/rom';
import { RemoteKarts, type NetClient } from '../net/client';
import type { Channel } from '../net/local';
import { readInput } from './input';
import {
  CHARACTER_CLASS, KART_CLASSES, NO_INPUT, STEP_MS, applyBreak, countdownInput, coverTiles, createKart, featherJump, isInvincible,
  isBoosting, kartFacing, kartHeight, raceGeometry, terrainAt, restoreTiles, spinOut, stepKart, tileCluster, type Bumper, type Kart, type SavedTile,
} from './physics';
import { CHASE_DISTANCE, Renderer, type MapMarker, type ObjectSprite, type Sprite } from './renderer';
import { PLACE_RED, RaceHud, placeRainbow, type LakituShow } from './hud';
import { CpuDriver, rubberBand } from './cpu';
import { objectState } from './objects';
import { ITEM_HIT_DISTANCE, OWNER_GRACE_FRAMES, advanceEntity, createEntity, type Entity } from './items';
import { LOOP, MUSIC, SFX0, type Sound } from '../audio/sound';

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
  /** Grand Prix lives left (shown above the coins); undefined outside a solo GP. */
  lives?: number;
  /** Music and engine sound (the game's own sound driver); null = silent. */
  sound?: Sound | null;
  /** Battle Mode: balloons instead of laps; the last one with balloons wins. */
  battle?: boolean;
}

/**
 * Music cues of a race, in frames from the green light (measured in the original: song 1 at -477, song 3 at
 * -309, song 4 at +107). Song 3 carries the start lights' beeps, so it must start exactly 309 frames before green.
 */
const MUSIC_INTRO_AT = -477;
const MUSIC_START_AT = -309;
const MUSIC_LOOP_AT = 107;
const MUSIC_AFTER_FINISH = 215;
const FINAL_LAP_FANFARE = 118;
const FINISH_SWING_FRAMES = 60;
const LAP_TIMES_AFTER = 494;

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

/** Everything else is drawn in the picture, like the original; this line only says who a spectator watches. */
export interface Hud {
  note: HTMLElement;
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
  /** Each lap's time (ms), and when the current lap started. */
  private lapTimes: number[] = [];
  private lapStartedAt = 0;
  /** Finishing order seen so far (own kart, our CPUs, and others as the server reports them). */
  private finishers: number[] = [];
  /** After the finish the computer drives our kart on, as in the original. */
  private autopilot: CpuDriver | null = null;
  /** Battle: balloons left per player (missing = full); true once we're out. */
  private balloons = new Map<number, number>();
  private out = false;
  /** Music: last cue sent, the final lap's start frame, whether the star tune is on. */
  private musicCue = '';
  private finalLapAt: number | null = null;
  private starTune = false;
  private unsubs: (() => void)[] = [];

  private item: ItemKind | null = null;
  private rollingUntil = 0;
  private itemHeld = false;
  private pickupCooldown = 0;
  private starTouchCooldown = 0;
  private entities = new Map<number, Entity>();
  private savedTiles = new Map<number, SavedTile>();
  private cpus: Cpu[];
  /** Lakitu's lap sign / finish flag: what and since which race frame. */
  private sign: { kind: 'lap' | 'finish'; lap: number; at: number } | null = null;
  /** Race frame the own kart started falling off the track (Lakitu fishes it back). */
  private fellAt: number | null = null;
  /** Wrong way: progress samples, and since when the kart has been going backwards. */
  private progressSample = 0;
  private reverseSince: number | null = null;
  /** Ids simulated here: this player and its CPUs. */
  private local: Set<number>;
  /** Spectating: place (0 = leader) of the kart the camera follows. */
  private watchPlace = 0;

  constructor(private o: RaceOptions) {
    const charOf = (id: number) => o.players.find((p) => p.id === id)?.character ?? 0;
    this.kart = createKart(o.track, o.slot, charOf(o.selfId), o.cc);
    this.cpus = o.cpus.map((c) => {
      const kart = createKart(o.track, c.slot, charOf(c.id), o.cc);
      if (o.items) kart.coins = START_COINS;
      return { id: c.id, kart, driver: new CpuDriver(o.track, kart, c.skill), finishedAt: 0 };
    });
    if (o.items) this.kart.coins = START_COINS;
    this.local = new Set([o.selfId, ...o.cpus.map((c) => c.id)]);
    this.geo = raceGeometry(o.track);
    this.startAt = performance.now() + o.startInMs;
    this.placeCamera(true);
    o.renderer.setTrack(o.track, o.drivers, itemFrames(o.itemGfx));
    o.sound?.course(o.track.theme);
    o.hud.note.textContent = '';

    if (o.net) {
      this.unsubs.push(o.net.on((m) => {
        if (m.t === 'states') this.remote.push(m.karts, this.local);
        else if (m.t === 'finished') this.noteFinisher(m.id, m.place);
        else if (m.t === 'balloons') {
          this.balloons.set(m.id, m.n);
          // Out of balloons: we watch the rest of the battle.
          if (m.id === o.selfId && m.n === 0 && !this.out) { this.out = true; this.o.spectate = true; }
        } else if (m.t === 'cpuHost' && m.id === o.selfId) this.adoptCpus();
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
    this.o.sound?.engine(0);
    this.o.sound?.loop(null);
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

  /** Time Trial: each lap's time and the total. */
  get times(): { laps: number[]; totalMs: number } {
    return { laps: [...this.lapTimes], totalMs: this.finishedAt ? this.finishedAt - this.startAt : 0 };
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
        if (m.coins > k.coins) o.sound?.sfx0(SFX0.coin);
        k.coins = m.coins;
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
          if (m.kind === 'mushroom') { k.boost = 60; o.sound?.sfx0(SFX0.mushroom); }
          else if (m.kind === 'star') k.star = STAR_FRAMES;
          else if (m.kind === 'feather') { featherJump(k); o.sound?.sfx0(SFX0.featherJump); }
          else if (m.kind === 'ghost') { k.ghost = GHOST_FRAMES; o.sound?.sfx0(SFX0.boo); }
        } else if (m.kind === 'lightning') {
          o.sound?.music(MUSIC.lightning);
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
      if (this.item === 'greenShell' || this.item === 'redShell') o.sound?.sfx0(SFX0.shell);
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
        if (e.kind === 'poison') { if (!isInvincible(v)) v.shrink = SHRINK_FRAMES; }
        else spinOut(v);
        break;
      }
    }

    // A star spins out the CPUs we touch.
    if (k.star > 0) for (const c of this.cpus) if (Math.hypot(c.kart.x - k.x, c.kart.y - k.y) < 10) spinOut(c.kart);

    // Touching a kart that has a star spins us out.
    if (this.starTouchCooldown > 0) this.starTouchCooldown--;
    // (Our own CPUs aren't in the remote list: Mario and Luigi CPUs use stars too.)
    for (const r of [...remotes, ...this.cpus.map((c) => netState(c.id, c.kart))]) {
      if (r.e & EFFECT_STAR && this.starTouchCooldown === 0 && Math.hypot(r.x - k.x, r.y - k.y) < 10) {
        if (o.battle && !isInvincible(k)) o.channel.send({ t: 'pop' });
        spinOut(k);
        this.starTouchCooldown = 60;
      }
    }
  }

  // ---------- Simulation ----------

  private step(now: number) {
    const racing = now >= this.startAt;
    this.stepSound(now);
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
    // During the countdown only the accelerate timing counts (start boost / bad start).
    if (!racing) countdownInput(this.kart, readInput(), this.raceFrame(now));
    if (racing && !this.lapStartedAt) this.lapStartedAt = this.startAt;
    const input = !racing ? NO_INPUT : this.autopilot ? this.autopilot.input(this.kart) : readInput();
    // Shrunk karts and Boos can be driven through.
    const others = this.bumpers([...this.remote.sample(), ...this.cpus.map((c) => netState(c.id, c.kart))]
      .filter((r) => r.f === 0 && !(r.e & (EFFECT_GHOST | EFFECT_SHRUNK))));
    const lapBefore = this.kart.lap;
    const spinBefore = this.kart.spin, boostBefore = this.kart.boost;
    const ev = stepKart(this.kart, input, this.o.track, this.geo, others, this.raceFrame(now));
    this.kartSounds(ev, input, spinBefore, boostBefore, now);
    if (ev.broken.length) {
      this.o.renderer.updateTiles(this.o.track, ev.broken);
      this.o.net?.send({ t: 'break', tiles: ev.broken });
    }
    this.stepItems(now, input, racing);
    this.stepCpus(now, racing);

    if (this.kart.lap > TOTAL_LAPS && !this.finishedAt && lapBefore === TOTAL_LAPS) {
      this.finishedAt = now;
      this.lapTimes.push(now - this.lapStartedAt);
      this.noteFinisher(this.o.selfId);
      this.autopilot = new CpuDriver(this.o.track, this.kart, 0.8);
      this.o.net?.send({ t: 'finish', timeMs: Math.round(now - this.startAt) });
      this.sign = { kind: 'finish', lap: TOTAL_LAPS, at: this.raceFrame(now) };
    } else if (this.kart.lap > lapBefore && this.kart.lap >= 2 && this.kart.lap <= TOTAL_LAPS) {
      this.lapTimes.push(now - this.lapStartedAt);
      this.lapStartedAt = now;
      // Lakitu shows "LAP 2" .. "LAP 4", then "FINAL LAP".
      this.sign = { kind: 'lap', lap: this.kart.lap, at: this.raceFrame(now) };
    }
    this.watchLakitu(now, racing);

    if (this.finishedAt) {
      // After the finish the camera swings round to the front of the kart (half a turn in about a second, as measured).
      const t = Math.min(1, (now - this.finishedAt) / (FINISH_SWING_FRAMES * STEP_MS));
      this.placeCamera(true, this.kart.x, this.kart.y, this.kart.angle + Math.PI * (t * t * (3 - 2 * t)));
    } else this.placeCamera(false);
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
    const all = this.bumpers([netState(o.selfId, this.kart), ...this.cpus.map((c) => netState(c.id, c.kart)), ...remotes.filter((r) => r.f === 0)]);
    for (const c of this.cpus) {
      const k = c.kart;
      k.speedScale = rubberBand(c.driver.skill, k.progress - best);
      if (!racing) countdownInput(k, c.driver.startInput(frame), frame);
      const others = all.filter((x) => x.id !== c.id);
      const ev = stepKart(k, racing ? c.driver.input(k) : NO_INPUT, o.track, this.geo, others, frame);
      if (ev.broken.length) {
        o.renderer.updateTiles(o.track, ev.broken);
        o.net?.send({ t: 'break', tiles: ev.broken });
      }
      if (racing && !c.finishedAt && k.fall === 0 && o.items && c.driver.wantsDrop()) {
        const special = CPU_SPECIAL[this.player(c.id)?.character ?? 4];
        if (special === 'star') k.star = STAR_FRAMES;
        else o.channel.send({ t: 'cpuDrop', cpu: c.id, x: k.x, y: k.y, a: k.angle, kind: special });
      }
      if (k.lap > TOTAL_LAPS && !c.finishedAt) {
        c.finishedAt = now;
        this.noteFinisher(c.id);
        o.net?.send({ t: 'finish', timeMs: Math.round(now - this.startAt), cpu: c.id });
      }
    }
    if (this.frame % Math.round(60 / NET_HZ) === 0) {
      (o.net ?? o.channel).send({ t: 'cpu', karts: this.cpus.map((c) => netState(c.id, c.kart)) });
    }
  }

  /** Sounds of our own kart, as the game raises them. */
  private kartSounds(ev: ReturnType<typeof stepKart>, input: ReturnType<typeof readInput>, _spinBefore: number, boostBefore: number, now: number) {
    const s = this.o.sound, k = this.kart;
    if (!s) return;
    if (ev.bump) s.sfx0(SFX0.bump);
    if (ev.hop) s.sfx0(SFX0.hop);
    if (ev.land) s.sfx0(SFX0.land);
    // Zipper panels: the same sound as a mushroom.
    if (k.boost > boostBefore + 1 && boostBefore === 0 && k.boost === 45) s.sfx0(SFX0.mushroom);
    // The continuous sound: spinning, the item roulette, the tyres screeching, driving on dirt.
    const screech = (input.brake && k.speed > 1) || (Math.abs(k.slide) > 0.3 && k.speed > 2);
    const offroad = k.speed > 1 && k.air === 0 && k.fall === 0 && terrainAt(this.o.track, k.x, k.y) === 'slow';
    s.loop(k.spin > 0 ? LOOP.spin : now < this.rollingUntil ? LOOP.itemBox : screech ? LOOP.brake : offroad ? LOOP.offroad : null);
  }

  /** We now simulate the CPUs (their browser left): carry on from where the others last saw them. */
  private adoptCpus() {
    const o = this.o;
    const mine = new Set(this.cpus.map((c) => c.id));
    for (const r of this.remote.sample()) {
      const p = this.player(r.id);
      if (!p?.cpu || mine.has(r.id)) continue;
      const kart = createKart(o.track, 0, p.character, o.cc);
      Object.assign(kart, { x: r.x, y: r.y, angle: r.a, speed: r.s, lap: r.lap, progress: r.p });
      kart.safe = { x: r.x, y: r.y, angle: r.a };
      kart.armed = true;
      if (o.items) kart.coins = START_COINS;
      this.cpus.push({ id: r.id, kart, driver: new CpuDriver(o.track, kart, 0.8), finishedAt: 0 });
      this.local.add(r.id);
    }
  }

  /** The original's music cues and the engine note (port 2 = speed / 16). */
  private stepSound(now: number) {
    const s = this.o.sound;
    if (!s) return;
    // Music cues go out early by the audio latency, so what is heard lines up with the picture.
    const frame = this.raceFrame(now) + s.leadFrames, k = this.kart;
    const cue = (name: string, cmd: number) => { if (this.musicCue !== name) { this.musicCue = name; s.music(cmd); } };
    if (k.lap >= TOTAL_LAPS && this.finalLapAt === null && !this.o.spectate) this.finalLapAt = frame;
    if (this.finishedAt) {
      const since = (now - this.finishedAt) / STEP_MS;
      if (since >= MUSIC_AFTER_FINISH) cue('after', MUSIC.afterRace);
      else cue('finish', MUSIC.finish);
    } else if (k.star > 0) {
      cue('star', MUSIC.star);
      this.starTune = true;
    } else if (this.finalLapAt !== null) {
      if (frame - this.finalLapAt < FINAL_LAP_FANFARE && !this.starTune) cue('fanfare', MUSIC.finalLapFanfare);
      else cue('final', MUSIC.finalLap);
    } else if (frame >= MUSIC_LOOP_AT || this.starTune) {
      cue('race', MUSIC.race);
    } else if (frame >= MUSIC_START_AT) cue('start', MUSIC.raceStart);
    // The intro only when there is time for it before the start song (not when the race shows up just before).
    else if (frame >= MUSIC_INTRO_AT && frame < MUSIC_START_AT - 30) cue('intro', MUSIC.intro);
    if (k.star === 0) this.starTune = false;
    // Engine: our kart's speed in game units / 16 (also while revving on the grid).
    const revving = this.raceFrame(now) < 0 && readInput().accel;
    s.engine(this.o.spectate ? 0 : revving ? 24 : Math.abs(k.speed) * 16);
  }

  /** Battle balloons: yellow for us, blue for the others (the original's two players). */
  private balloonPalette(id: number) {
    return id === this.o.selfId ? 0 : 1;
  }

  /** Online, the server's place wins over the order the news arrived in. */
  private noteFinisher(id: number, place?: number) {
    const i = this.finishers.indexOf(id);
    if (i >= 0 && place === undefined) return;
    if (i >= 0) this.finishers.splice(i, 1);
    this.finishers.splice(place === undefined ? this.finishers.length : Math.min(place - 1, this.finishers.length), 0, id);
  }

  /** Karts to bump into, with their class weight. */
  private bumpers(karts: KartNetState[]): (Bumper & { id: number })[] {
    return karts.map((r) => ({ id: r.id, x: r.x, y: r.y, w: KART_CLASSES[CHARACTER_CLASS[this.player(r.id)?.character ?? 0]].weight }));
  }

  /** Finishing order of this client's race (solo practice results). */
  results(): RaceResult[] {
    const me = { id: this.o.selfId, at: this.finishedAt, p: this.finishedAt ? Infinity : this.kart.progress };
    const rows = [me, ...this.cpus.map((c) => ({ id: c.id, at: c.finishedAt, p: c.kart.progress }))];
    rows.sort((a, b) => (a.at && b.at ? a.at - b.at : a.at ? -1 : b.at ? 1 : b.p - a.p));
    // Still racing: the time they're heading for, from how far round they are (as the original estimates).
    const elapsed = performance.now() - this.startAt, full = TOTAL_LAPS * Math.max(1, this.o.track.path.length);
    const estimate = (p: number) => (p > full * 0.2 ? Math.round((elapsed * full) / p) : null);
    return rows.map((r) => ({ id: r.id, timeMs: r.at ? Math.round(r.at - this.startAt) : estimate(r.p) }));
  }

  private placeCamera(snap: boolean, x = this.kart.x, y = this.kart.y, angle = this.kart.angle) {
    let da = angle - this.cam.angle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this.cam.angle += snap ? da : da * 0.12;
    const back = CHASE_DISTANCE;
    this.cam.x = x - Math.sin(this.cam.angle) * back;
    this.cam.y = y + Math.cos(this.cam.angle) * back;
  }

  /** Falling off (Lakitu's rescue) and going the wrong way (his reverse sign). */
  private watchLakitu(now: number, racing: boolean) {
    const k = this.kart, frame = this.raceFrame(now);
    if (k.fall > 0) this.fellAt ??= frame;
    else if (this.fellAt !== null && frame - this.fellAt > 40) this.fellAt = null;
    // Sampled twice a second: progress going down while driving forward = wrong way.
    if (racing && !this.finishedAt && frame % 30 === 0) {
      const back = k.progress < this.progressSample - 0.5 && k.speed > 0.5 && k.fall === 0;
      if (back) this.reverseSince ??= frame;
      else if (k.progress > this.progressSample) this.reverseSince = null;
      this.progressSample = k.progress;
    }
  }

  /** What Lakitu is doing now (most urgent first). */
  private lakituShow(frame: number): LakituShow | null {
    if (this.o.spectate) return frame <= 140 ? { kind: 'start', t: frame } : null;
    if (this.fellAt !== null) return { kind: 'rescue', t: frame - this.fellAt, x: 128, y: 70 };
    if (this.reverseSince !== null && frame - this.reverseSince >= 30) return { kind: 'reverse', t: frame - this.reverseSince - 30 };
    if (this.sign) {
      const show: LakituShow = this.sign.kind === 'lap'
        ? { kind: 'lap', lap: this.sign.lap, t: frame - this.sign.at }
        : { kind: 'finish', t: frame - this.sign.at };
      if (!RaceHud.done(show)) return show;
      if (this.sign.kind === 'lap') this.sign = null;
    }
    if (frame <= 140) return { kind: 'start', t: frame };
    return null;
  }

  // ---------- Drawing ----------

  private draw(now: number) {
    const o = this.o;
    const remotes = [...this.remote.sample(), ...this.cpus.map((c) => netState(c.id, c.kart))];
    const charOf = (id: number) => o.players.find((p) => p.id === id)?.character ?? 0;
    const nameOf = (id: number) => CHARACTER_NAMES[charOf(id)];
    const watched = o.spectate ? this.watched(remotes) : null;
    const me = this.kart;

    const sprites: Sprite[] = remotes.map((r) => ({
      x: r.x, y: r.y, angle: r.a + (r.d ?? 0), character: charOf(r.id),
      scale: (r.f > 0 ? r.f / 70 : 1) * (r.e & EFFECT_SHRUNK ? 0.5 : 1), lift: r.h,
      alpha: r.e & EFFECT_GHOST ? 0.15 : 1, flash: !!(r.e & EFFECT_STAR),
      smoke: Math.abs(r.d ?? 0) > 0.3 && r.s > 2, dust: r.s > 1 && r.f === 0 && r.h === 0 && terrainAt(o.track, r.x, r.y) === 'slow',
      boost: !!(r.e & EFFECT_BOOST),
      balloons: o.battle ? this.balloons.get(r.id) ?? BATTLE_BALLOONS : 0, balloonPalette: this.balloonPalette(r.id),
    }));
    if (!o.spectate) sprites.push({
      x: me.x, y: me.y, angle: kartFacing(me), character: charOf(o.selfId),
      scale: (me.fall > 0 ? me.fall / 70 : 1) * (me.shrink > 0 ? 0.5 : 1), lift: kartHeight(me),
      alpha: me.ghost > 0 ? 0.45 : 1, flash: me.star > 0,
      smoke: Math.abs(me.slide) > 0.3 && me.speed > 2, dust: me.speed > 1 && me.fall === 0 && me.air === 0 && terrainAt(o.track, me.x, me.y) === 'slow',
      boost: isBoosting(me),
      balloons: o.battle ? this.balloons.get(o.selfId) ?? BATTLE_BALLOONS : 0, balloonPalette: this.balloonPalette(o.selfId),
    });

    const frame = this.raceFrame(now);
    const objects: ObjectSprite[] = [];
    o.track.objects.forEach((obj, i) => {
      const st = objectState(obj.kind, i, frame);
      if (st.visible) objects.push({ x: obj.x, y: obj.y, lift: st.height, frame: Math.floor(frame / 8) % Math.max(1, o.track.objectFrames.length) });
    });
    for (const e of this.entities.values()) {
      // Shells spin: their picture flips every few frames while they move.
      const moving = e.kind === 'greenShell' || e.kind === 'redShell' || e.kind === 'fireball';
      objects.push({ x: e.x, y: e.y, lift: 0, item: true, frame: ITEM_FRAME[e.kind], mirror: moving && (frame >> 2) % 2 === 1 });
    }

    // Course map: everyone's head; our own drawn last (on top).
    const marker = (id: number, x: number, y: number): MapMarker => {
      const c = charOf(id);
      return { x, y, character: c, palette: CHARACTERS[c].palette - 8 };
    };
    const markers = remotes.filter((r) => r !== watched).map((r) => marker(r.id, r.x, r.y));
    if (watched) markers.push(marker(watched.id, watched.x, watched.y));
    else if (!o.spectate) markers.push(marker(o.selfId, me.x, me.y));

    // Whose numbers the HUD shows: our own kart, or the one a spectator follows.
    const ranked = [{ id: o.selfId, p: this.finishedAt ? Infinity : me.progress }, ...remotes.map((r) => ({ id: r.id, p: r.p }))];
    const focus = watched ? { id: watched.id, p: watched.p, lap: watched.lap } : { id: o.selfId, p: ranked[0].p, lap: me.lap };
    const field = o.spectate ? ranked.slice(1) : ranked;
    // Ties count as ahead: on the grid, the last kart shows 8th like the original.
    const place = field.filter((x) => x.id !== focus.id && x.p >= focus.p).length + 1;
    const raceMs = this.finishedAt ? this.finishedAt - this.startAt : Math.max(0, now - this.startAt);
    const lakitu = this.lakituShow(frame);

    o.renderer.render(this.cam, sprites, objects, markers, (hud) => {
      if (o.battle) {
        // Battle: no laps, places or lap times; Lakitu still starts it.
        if (!o.spectate) this.drawItemBox(now, hud);
        if (lakitu && lakitu.kind === 'start') hud.lakitu(lakitu, frame);
        return;
      }
      hud.timer(Math.min(TOTAL_LAPS, Math.max(1, focus.lap)), raceMs);
      if (o.items && !o.spectate) hud.coins(me.coins);
      if (o.lives !== undefined && !o.spectate) hud.lives(o.lives);
      // After a podium finish the number flashes through the colors.
      const myPlace = this.finishers.indexOf(o.selfId) + 1;
      if (o.net || this.cpus.length) hud.place(myPlace || place, myPlace >= 1 && myPlace <= 4 ? placeRainbow(frame) : PLACE_RED);
      if (this.finishedAt) {
        hud.finishOrder(this.finishers.map((id, i) => {
          const c = charOf(id);
          return { place: i + 1, character: c, palette: CHARACTERS[c].palette - 8 };
        }), frame);
        // The lap times come up once Lakitu's flag flight is over (494 frames after the line, measured).
        if (now - this.finishedAt > LAP_TIMES_AFTER * STEP_MS) hud.lapTimes(this.lapTimes, this.finishedAt - this.startAt);
      }
      if (!o.spectate) this.drawItemBox(now, hud);
      if (lakitu) hud.lakitu(lakitu, frame);
    });
    o.hud.note.textContent = watched ? `ASSISTINDO ${nameOf(watched.id).toUpperCase()}  (← → troca)` : o.spectate ? 'ASSISTINDO' : '';
  }

  /** Held item (or the roulette) in its box at the top center. */
  private drawItemBox(now: number, hud: RaceHud) {
    let icon: number | null = null;
    if (now < this.rollingUntil) icon = Math.floor(now / 70) % ITEM_KINDS.length;
    else if (this.item) icon = ITEM_KINDS.indexOf(this.item);
    if (icon !== null) hud.itemIcon(this.o.itemGfx.icons[icon]);
  }
}

function netState(id: number, k: Kart): KartNetState {
  const e = (k.star > 0 ? EFFECT_STAR : 0) | (k.ghost > 0 ? EFFECT_GHOST : 0) | (k.shrink > 0 ? EFFECT_SHRUNK : 0) | (isBoosting(k) ? EFFECT_BOOST : 0);
  return { id, x: r1(k.x), y: r1(k.y), a: r3(k.angle), d: r3(k.slide), s: r3(k.speed), lap: k.lap, p: k.progress, f: k.fall, h: r1(kartHeight(k)), e };
}

/** Index into itemFrames() for each kind of item on the track. */
const ITEM_FRAME: Record<EntityKind, number> = { banana: 0, greenShell: 1, redShell: 2, poison: 3, fireball: 4, egg: 5 };

/**
 * Track pictures of the items, from the ROM's HUD icons: banana, shells, and for the CPU-only items the
 * mushroom turned dark purple (poison), the coin turned to fire (fireball) and to white with green (egg).
 */
function itemFrames(gfx: ItemGraphics): SpriteFrame[] {
  const tint = (f: SpriteFrame, map: (r: number, g: number, b: number) => [number, number, number]) => {
    const px = new Uint8Array(f.pixels);
    for (let i = 0; i < px.length; i += 4) if (px[i + 3]) [px[i], px[i + 1], px[i + 2]] = map(px[i], px[i + 1], px[i + 2]);
    return { w: f.w, h: f.h, pixels: px };
  };
  const at = (k: ItemKind) => cutout(gfx.icons[ITEM_KINDS.indexOf(k)]);
  return [
    at('banana'), at('greenShell'), at('redShell'),
    tint(at('mushroom'), (r, g, b) => (r > g + 40 ? [110, 40, 150] : [r, g, b])),
    tint(at('coins'), (r, g, b) => { const l = (r + g + b) / 3; return l > 180 ? [255, 240, 120] : l > 90 ? [248, 112, 32] : [168, 16, 0]; }),
    tint(at('coins'), (r, g, b) => { const l = (r + g + b) / 3; return l > 180 ? [248, 248, 248] : l > 90 ? [80, 200, 64] : [24, 96, 24]; }),
  ];
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

export function formatTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}'${String(s).padStart(2, '0')}"${String(cs).padStart(2, '0')}`;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
