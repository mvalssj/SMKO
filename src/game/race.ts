// One race: local kart simulation, remote karts, items, camera, and the original HUD (timer, Lakitu, map).
// Works offline (solo practice, items run by a LocalChannel) or online (NetClient).

import {
  BATTLE_BALLOONS, CHARACTER_NAMES, EFFECT_BOOST, EFFECT_GHOST, EFFECT_SHRUNK, EFFECT_STAR, ITEM_KINDS, NET_HZ, TOTAL_LAPS,
  CPU_SPECIAL, type Cc, type EntityKind, type ItemKind, type KartNetState, type PlayerInfo, type ServerMsg,
} from '../../shared/protocol';
import { ROULETTE_MS, ROULETTE_SHOW_MS, ROULETTE_SPIN_MS, ROULETTE_STOP_MS, START_COINS } from '../../shared/items';
import { CHARACTERS, Genre, MAP_PX, TILE, type DriverSprites, type ItemGraphics, type SpriteFrame, type Track } from '../rom/rom';
import { RemoteKarts, type NetClient } from '../net/client';
import type { Channel } from '../net/local';
import { readInput } from './input';
import {
  CHARACTER_CLASS, DASH_FRAMES, KART_CLASSES, NO_INPUT, STEP_MS, applyBreak, countdownInput, coverTiles, createKart, featherJump, isInvincible,
  isBoosting, kartFacing, kartHeight, raceGeometry, terrainAt, restoreTiles, spinOut, stepKart, tileCluster, type Bumper, type Input, type Kart, type SavedTile,
} from './physics';
import { WORLD_H, WORLD_W, insideZone, wrapDX, wrapDY, wrapX, wrapY, type ZoneNow } from '../../shared/royale';
import { BotDriver, type Rival } from '../royale/bot';
import type { RoyaleState } from '../royale/state';
import { regionAt } from '../royale/world';
import { CHASE_DISTANCE, MAP_SCALE, PLANET_RADIUS, Renderer, SCREEN_W, type MapMarker, type ObjectSprite, type Sprite } from './renderer';
import { PLACE_RED, RaceHud, placeRainbow, type LakituShow } from './hud';
import { CpuDriver, rubberBand } from './cpu';
import { objectState } from './objects';
import { ITEM_HIT_DISTANCE, OWNER_GRACE_FRAMES, advanceEntity, createEntity, type Entity } from './items';
import { LOOP, MUSIC, SFX0, type Sound } from '../audio/sound';

/**
 * Item effects, measured in the original (kart RAM, 8th place): star 512 frames; Boo (invisible) 1152; a
 * lightning bolt leaves the others small for 157 frames (5 shrinking, about 130 small, 21 growing back).
 */
const STAR_FRAMES = 512;
const GHOST_FRAMES = 1152;
const SHRINK_FRAMES = 157;

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
  /**
   * Battle Royale: the open world of every course, up to 100 karts, the safe area closing in; balloons as in
   * Battle Mode (set `battle` too). Slots are starting places in the world.
   */
  royale?: RoyaleState;
  /** Battle Royale, taking over a bot: where our kart is; and everyone's balloons so far. */
  start?: { x: number; y: number; a: number };
  balloons?: [number, number][];
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
  /** Battle Royale bot: its brain, its item (from the item authority), the roulette's end, out of balloons. */
  bot?: BotDriver;
  item?: ItemKind | null;
  rollingUntil?: number;
  pickupCooldown?: number;
  out?: boolean;
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
  /** Battle Royale: the floor curves away like a little planet's (the player can turn it off). */
  static planet = true;
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
  /** When the item from the last box can be used (the roulette's end and its show). */
  private readyAt = 0;
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
  /** Battle Royale: the safe area now, the course whose sky is showing, our place once out, the winner. */
  private zone: ZoneNow | null = null;
  private skyTheme = -1;
  private royalePlace = 0;
  private royaleWinner: number | null = null;
  private royaleEndedAt = 0;
  /** Battle Royale eliminations, including the locally observed survival time for the final board. */
  private royaleOut = new Map<number, { place: number; timeMs: number }>();
  private outsideSince: number | null = null;

  constructor(private o: RaceOptions) {
    const charOf = (id: number) => o.players.find((p) => p.id === id)?.character ?? 0;
    const place = (k: Kart, slot: number, character: number, cpu = false) => {
      if (!o.royale) return k;
      const s = o.royale.spawn(slot, character, cpu);
      Object.assign(k, { x: s.x, y: s.y, angle: s.angle });
      k.safe = { ...s };
      return k;
    };
    this.kart = place(createKart(o.track, o.slot, charOf(o.selfId), o.cc), o.slot, charOf(o.selfId));
    if (o.start) {
      Object.assign(this.kart, { x: o.start.x, y: o.start.y, angle: o.start.a });
      this.kart.safe = { x: o.start.x, y: o.start.y, angle: o.start.a };
    }
    for (const [id, n] of o.balloons ?? []) this.balloons.set(id, n);
    this.cpus = o.cpus.map((c) => {
      const kart = place(createKart(o.track, c.slot, charOf(c.id), o.cc), c.slot, charOf(c.id), true);
      if (o.items) kart.coins = START_COINS;
      const bot = o.royale ? new BotDriver(o.royale.world, c.id, c.skill, Math.random) : undefined;
      return { id: c.id, kart, driver: new CpuDriver(o.track, kart, c.skill), finishedAt: 0, bot, item: null, rollingUntil: 0, pickupCooldown: 0 };
    });
    if (o.items) this.kart.coins = START_COINS;
    this.local = new Set([o.selfId, ...o.cpus.map((c) => c.id)]);
    this.geo = raceGeometry(o.track);
    this.startAt = performance.now() + o.startInMs;
    this.placeCamera(true);
    const world = o.royale?.world.world;
    o.renderer.setTrack(o.track, o.drivers, itemFrames(o.itemGfx), world ? {
      cols: world.cols, rows: world.rows, ids: world.ids, atlas: world.atlas, atlasW: 512, atlasH: 256, outside: world.baseTheme * 256 + 0x44,
    } : null);
    o.sound?.course(o.track.theme);
    if (o.royale) { this.followRegion(true); this.showWorldMap(); this.applyPlanet(); }
    o.hud.note.textContent = '';

    if (o.net) {
      this.unsubs.push(o.net.on((m) => {
        if (m.t === 'states') this.remote.push(m.karts, this.local);
        else if (m.t === 'finished') this.noteFinisher(m.id, m.place);
        else if (o.royale) {
          if (m.t === 'cpuHost' && m.id === o.selfId) this.adoptCpus();
          else if (m.t === 'royaleSwap') this.swapIn(m.bot, m.player);
          else if (m.t === 'break') { applyBreak(o.track, m.tiles); o.renderer.updateTiles(o.track, m.tiles); o.royale.nav.refresh(m.tiles); }
        } else if (m.t === 'balloons') {
          // onItemMessage records the count and sound after this listener.
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
    // The Royale world is cached between matches. Never leave consumed boxes/coins in that shared map.
    // Keep this after unsubscribing so a late network update cannot cover the restored tiles again.
    const tiles = [...this.savedTiles.keys()];
    if (tiles.length) {
      restoreTiles(this.o.track, this.savedTiles, tiles);
      this.o.renderer.updateTiles(this.o.track, tiles);
    }
  }

  /** Frames since the start signal (negative during the countdown). Same on every client. */
  private raceFrame(now: number) {
    return Math.floor((now - this.startAt) / STEP_MS);
  }

  player(id: number): PlayerInfo | undefined {
    if (this.byId.size !== this.o.players.length) this.byId = new Map(this.o.players.map((p) => [p.id, p]));
    return this.byId.get(id);
  }
  private byId = new Map<number, PlayerInfo>();

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
    // A bot's own item news (Battle Royale bots use the item boxes like everyone).
    if ((m.t === 'item' || m.t === 'coins') && m.cpu !== undefined) {
      const c = this.cpus.find((x) => x.id === m.cpu);
      if (!c) return;
      if (m.t === 'item') { c.item = m.item; c.rollingUntil = m.roll ? performance.now() + ROULETTE_MS : 0; }
      else c.kart.coins = m.coins;
      return;
    }
    switch (m.t) {
      case 'balloons': {
        const previous = this.balloons.get(m.id) ?? BATTLE_BALLOONS;
        this.balloons.set(m.id, m.n);
        if (m.id === o.selfId && m.n < previous) o.sound?.sfx0(SFX0.bump);
        break;
      }
      case 'royaleOut': {
        this.balloons.set(m.id, 0);
        this.royaleOut.set(m.id, { place: m.place, timeMs: Math.max(0, Math.round(performance.now() - this.startAt)) });
        const c = this.cpus.find((x) => x.id === m.id);
        if (c) c.out = true;
        if (m.id === o.selfId && !this.out) { this.out = true; this.royalePlace = m.place; this.item = null; }
        break;
      }
      case 'royaleOver':
        this.royaleWinner = m.winner;
        this.royaleEndedAt ||= performance.now();
        if (m.winner === o.selfId && !this.finishedAt) {
          // The last one in: Lakitu waves the flag, the finish music plays, as at the end of a race.
          this.finishedAt = performance.now();
          this.royalePlace = 1;
          this.sign = { kind: 'finish', lap: TOTAL_LAPS, at: this.raceFrame(performance.now()) };
        }
        break;
      case 'item':
        this.item = m.item;
        // The roulette spins (rollingUntil), then shows the item a moment before it can be used (readyAt).
        this.rollingUntil = m.roll ? performance.now() + ROULETTE_SPIN_MS : 0;
        this.readyAt = m.roll ? this.rollingUntil + ROULETTE_SHOW_MS : 0;
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
          if (m.kind === 'mushroom') { k.dash = DASH_FRAMES; o.sound?.sfx0(SFX0.mushroom); }
          else if (m.kind === 'star') k.star = STAR_FRAMES;
          else if (m.kind === 'feather') { featherJump(k); o.sound?.sfx0(SFX0.featherJump); }
          else if (m.kind === 'ghost') { k.ghost = GHOST_FRAMES; o.sound?.sfx0(SFX0.boo); }
        } else if (m.kind === 'lightning') {
          o.sound?.music(MUSIC.lightning);
          if (!isInvincible(k)) {
            k.shrink = SHRINK_FRAMES;
            spinOut(k, 'lightning');
            this.item = null;
          }
          for (const c of this.cpus) {
            if (c.id !== m.id && !isInvincible(c.kart)) { c.kart.shrink = SHRINK_FRAMES; spinOut(c.kart, 'lightning'); c.item = null; }
          }
        } else {
          // One of our bots used an item on itself.
          const c = this.cpus.find((x) => x.id === m.id);
          if (c?.bot) {
            if (m.kind === 'mushroom') c.kart.dash = DASH_FRAMES;
            else if (m.kind === 'star') c.kart.star = STAR_FRAMES;
            else if (m.kind === 'feather') featherJump(c.kart);
            else if (m.kind === 'ghost') c.kart.ghost = GHOST_FRAMES;
          }
        }
        break;
    }
  }

  private stepItems(now: number, input: ReturnType<typeof readInput>, racing: boolean) {
    const o = this.o;
    const k = this.kart;
    const frame = this.raceFrame(now);

    // Use the held item on button press (not while it's still rolling); pressed while it spins, it stops.
    const pressed = !!input.item && !this.itemHeld;
    this.itemHeld = !!input.item;
    if (pressed && racing && this.item && now < this.rollingUntil) {
      this.rollingUntil = now + ROULETTE_STOP_MS;
      this.readyAt = this.rollingUntil + ROULETTE_SHOW_MS;
      o.channel.send({ t: 'stopRoll' });
    } else if (pressed && racing && this.item && now >= this.readyAt && k.fall === 0 && !this.finishedAt && !this.out) {
      o.channel.send({ t: 'use', x: k.x, y: k.y, a: k.angle, back: input.brake, s: Math.max(0, k.speed), fwd: !!input.up });
      if (this.item === 'greenShell' || this.item === 'redShell') o.sound?.sfx0(SFX0.shell);
      this.item = null;
    }

    // Item boxes and coins: test the whole kart footprint, not only its exact centre. In the open Battle
    // Royale world this is important because the original 16px item-box tiles sit beside one another.
    if (this.pickupCooldown > 0) this.pickupCooldown--;
    if (o.items && racing && k.air === 0 && k.fall === 0 && this.pickupCooldown === 0 && !this.out) {
      const box = pickupTile(o.track, k.x, k.y, Genre.ItemBlock);
      const coin = box ? null : pickupTile(o.track, k.x, k.y, Genre.Coin);
      if (box && !this.item && now >= this.readyAt) {
        o.channel.send({ t: 'box', tiles: tileCluster(o.track, box.tx, box.ty, Genre.ItemBlock, 2) });
        this.pickupCooldown = 20;
      } else if (coin) {
        o.channel.send({ t: 'coin', tiles: tileCluster(o.track, coin.tx, coin.ty, Genre.Coin, 1) });
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
      const victims: [number | undefined, Kart][] = [
        ...(this.out ? [] : [[undefined, k] as [number | undefined, Kart]]),
        ...this.cpus.filter((c) => !c.out).map((c) => [c.id, c.kart] as [number, Kart]),
      ];
      for (const [cpu, v] of victims) {
        if ((cpu ?? o.selfId) === e.owner && fresh) continue;
        if (v.air > 0 || v.fall > 0 || e.lift > 0 || near2(e, v) >= ITEM_HIT_DISTANCE) continue;
        o.channel.send({ t: 'hit', entity: e.id, cpu });
        this.entities.delete(e.id);
        if (e.kind === 'poison') { if (!isInvincible(v)) v.shrink = SHRINK_FRAMES; }
        else spinOut(v, e.kind === 'greenShell' || e.kind === 'redShell' ? true : e.kind === 'banana' ? 'banana' : false);
        break;
      }
    }

    // A star spins out the CPUs we touch (in a battle it pops one of their balloons).
    if (k.star > 0 && !this.out) {
      for (const c of this.cpus) {
        if (c.out || near2(c.kart, k) >= 10 || isInvincible(c.kart) || c.kart.spin > 0) continue;
        if (o.royale) o.channel.send({ t: 'pop', cpu: c.id });
        // (A star's touch spins round as a shell does, a frame longer: measured.)
spinOut(c.kart, 'star');
      }
    }

    // Touching a kart that has a star spins us out.
    if (this.starTouchCooldown > 0) this.starTouchCooldown--;
    // (Our own CPUs aren't in the remote list: Mario and Luigi CPUs use stars too.)
    for (const r of [...remotes, ...this.cpus.filter((c) => !c.out).map((c) => netState(c.id, c.kart))]) {
      if (this.out) break;
      if (r.e & EFFECT_STAR && this.starTouchCooldown === 0 && near2(r, k) < 10) {
        if (o.battle && !isInvincible(k)) o.channel.send({ t: 'pop' });
        // (A star's touch spins round as a shell does, a frame longer: measured.)
spinOut(k, 'star');
        this.starTouchCooldown = 60;
      }
    }
  }

  // ---------- Simulation ----------

  private step(now: number) {
    const racing = now >= this.startAt;
    this.stepSound(now);
    if (this.o.royale) {
      this.zone = this.o.royale.zone(now - this.startAt);
      this.o.renderer.zone = this.zone.now;
      if (this.frame % 15 === 0) this.followRegion(false);
      if (this.out) {
        this.frame++;
        this.stepItems(now, NO_INPUT, racing);
        this.stepBots(now, racing);
        const alive = [...this.remote.sample(), ...this.cpus.filter((c) => !c.out).map((c) => netState(c.id, c.kart))]
          .filter((r) => (this.balloons.get(r.id) ?? 1) > 0);
        const w = this.watched(alive);
        if (w) this.placeCamera(false, w.x, w.y, w.a);
        if (this.o.net && this.frame % 30 === 0) this.o.net.send({ t: 'focus', x: Math.round(this.cam.x), y: Math.round(this.cam.y) });
        return;
      }
    }
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
    // The original drives with the pad as it was a frame earlier (read in the vertical blank, used next frame).
    const pad = !racing ? NO_INPUT : this.autopilot ? this.autopilot.input(this.kart) : readInput();
    const input = this.lastPad;
    this.lastPad = pad;
    // Shrunk karts and Boos can be driven through.
    const others = this.bumpers([...this.remote.sample(), ...this.cpus.map((c) => netState(c.id, c.kart))]
      .filter((r) => r.f === 0 && !(r.e & (EFFECT_GHOST | EFFECT_SHRUNK))));
    const lapBefore = this.kart.lap;
    const spinBefore = this.kart.spin, boostBefore = this.kart.boost;
    this.headingBefore = this.kart.angle;
    const ev = stepKart(this.kart, input, this.o.track, this.geo, others, this.raceFrame(now));
    this.kartSounds(ev, input, spinBefore, boostBefore, now);
    if (ev.broken.length) {
      this.o.renderer.updateTiles(this.o.track, ev.broken);
      this.o.net?.send({ t: 'break', tiles: ev.broken });
    }
    this.stepItems(now, input, racing);
    if (this.o.royale) this.stepBots(now, racing);
    else this.stepCpus(now, racing);

    if (!this.o.royale && this.kart.lap > TOTAL_LAPS && !this.finishedAt && lapBefore === TOTAL_LAPS) {
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
    } else if (this.kart.spin > 0) this.placeCamera(false);
    // The original's camera looks along the kart's heading of the frame before (measured: its DSP-1 azimuth),
    // not turning after it slowly. (Spinning, it follows smoothly, as before: not measured.)
    else this.placeCamera(true, this.kart.x, this.kart.y, this.headingBefore ?? this.kart.angle);
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

  /**
   * Battle Royale bots: each drives with its own brain, picks up boxes and coins, uses its item; a bot with a
   * star pops the balloons of whoever it touches.
   */
  private stepBots(now: number, racing: boolean) {
    const o = this.o, royale = o.royale!, zone = this.zone!;
    const frame = this.raceFrame(now);
    const remotes = this.remote.sample();
    const live = this.cpus.filter((c) => !c.out);
    const everyone = [
      ...(this.out ? [] : [netState(o.selfId, this.kart)]),
      ...live.map((c) => netState(c.id, c.kart)),
      ...remotes.filter((r) => r.f === 0 && (this.balloons.get(r.id) ?? 1) > 0),
    ];
    const bumpers = this.bumpers(everyone.filter((r) => r.f === 0 && !(r.e & (EFFECT_GHOST | EFFECT_SHRUNK))));
    // Rivals each bot can see: a coarse grid so 100 karts don't each look at 100 others. (Its cells divide
    // the world exactly, which wraps round: the cells along one edge are next to those along the other.)
    const CELL = 608, GX = Math.round(WORLD_W / CELL), GY = Math.round(WORLD_H / CELL), grid = new Map<number, Rival[]>();
    const cell = (v: number, n: number) => ((Math.floor(v) % n) + n) % n;
    const key = (x: number, y: number) => cell(x / CELL, GX) * 1000 + cell(y / CELL, GY);
    for (const r of everyone) {
      if (r.e & EFFECT_GHOST) continue;
      const g = key(r.x, r.y);
      if (!grid.has(g)) grid.set(g, []);
      grid.get(g)!.push({ id: r.id, x: r.x, y: r.y, a: r.a, star: !!(r.e & EFFECT_STAR) });
    }
    const near = (k: Kart, id: number) => {
      const out: Rival[] = [];
      const cx = Math.floor(k.x / CELL), cy = Math.floor(k.y / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const r of grid.get(cell(cx + dx, GX) * 1000 + cell(cy + dy, GY)) ?? []) if (r.id !== id) out.push(r);
      }
      return out;
    };
    // Karts to bump into, in 64 px cells: each bot only looks at the cells round it.
    const BCELL = 64, BX = Math.round(WORLD_W / BCELL), BY = Math.round(WORLD_H / BCELL), bgrid = new Map<number, (Bumper & { id: number })[]>();
    for (const b of bumpers) {
      const g = cell(b.x / BCELL, BX) * 4096 + cell(b.y / BCELL, BY);
      if (!bgrid.has(g)) bgrid.set(g, []);
      bgrid.get(g)!.push(b);
    }
    const bumpNear = (k: Kart, id: number) => {
      const out: Bumper[] = [];
      const cx = Math.floor(k.x / BCELL), cy = Math.floor(k.y / BCELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const b of bgrid.get(cell(cx + dx, BX) * 4096 + cell(cy + dy, BY)) ?? []) if (b.id !== id) out.push(b);
      }
      return out;
    };
    for (const c of live) {
      const k = c.kart, bot = c.bot!;
      if (!racing) { countdownInput(k, NO_INPUT, frame); continue; }
      const rolling = now < (c.rollingUntil ?? 0);
      const input = bot.input(k, {
        frame, zone: zone.now, next: zone.next, nav: royale.nav, rivals: near(k, c.id), boxes: royale.boxes, spawns: royale.spawns,
        item: rolling ? null : c.item ?? null,
      });
      const falling = k.fall > 0;
      const ev = stepKart(k, input, o.track, this.geo, bumpNear(k, c.id), frame);
      // For the server's statistics: where the bots fall off.
      if (!falling && k.fall > 0) {
        const name = regionAt(royale.world.world, k.x, k.y).info.name;
        this.botFalls.set(name, (this.botFalls.get(name) ?? 0) + 1);
      }
      if (ev.broken.length) {
        o.renderer.updateTiles(o.track, ev.broken);
        royale.nav.refresh(ev.broken);
        o.net?.send({ t: 'break', tiles: ev.broken });
      }
      // Item: use it when the brain says so.
      const use = bot.wantsItem();
      if (use && c.item && !rolling && k.fall === 0) {
        o.channel.send({ t: 'use', cpu: c.id, x: k.x, y: k.y, a: k.angle, back: use.back, s: Math.max(0, k.speed) });
        c.item = null;
      }
      // Boxes and coins in the kart's footprint (the same forgiving pickup as the human player).
      if (c.pickupCooldown) c.pickupCooldown--;
      if (k.air === 0 && k.fall === 0 && !c.pickupCooldown) {
        const box = pickupTile(o.track, k.x, k.y, Genre.ItemBlock);
        const coin = box ? null : pickupTile(o.track, k.x, k.y, Genre.Coin);
        if (box && !c.item && !rolling) {
          o.channel.send({ t: 'box', cpu: c.id, tiles: tileCluster(o.track, box.tx, box.ty, Genre.ItemBlock, 2) });
          c.pickupCooldown = 20;
        } else if (coin) {
          o.channel.send({ t: 'coin', cpu: c.id, tiles: tileCluster(o.track, coin.tx, coin.ty, Genre.Coin, 1) });
          c.pickupCooldown = 6;
        }
      }
      // A person with a star running into this bot.
      for (const r of remotes) {
        if (!(r.e & EFFECT_STAR) || r.f > 0 || isInvincible(k) || k.spin > 0 || near2(r, k) >= 10) continue;
        o.channel.send({ t: 'pop', cpu: c.id });
        // (A star's touch spins round as a shell does, a frame longer: measured.)
spinOut(k, 'star');
      }
      // A star: spin out and pop whoever it touches (other bots here; people check for themselves).
      if (k.star > 0) {
        for (const v of live) {
          if (v === c || v.out || isInvincible(v.kart) || v.kart.spin > 0 || near2(v.kart, k) >= 10) continue;
          o.channel.send({ t: 'pop', cpu: v.id });
          // (A star's touch spins round as a shell does, a frame longer: measured.)
spinOut(v.kart, 'star');
        }
      }
    }
    if (this.frame % Math.round(60 / NET_HZ) === 0) {
      (o.net ?? o.channel).send({ t: 'cpu', karts: live.map((c) => netState(c.id, c.kart)) });
    }
  }

  /** Battle Royale: a person took bot `bot`'s place (if we were running it, we stop). */
  private swapIn(bot: number, player: PlayerInfo) {
    const o = this.o;
    const i = o.players.findIndex((p) => p.id === bot);
    if (i >= 0) o.players[i] = player; else o.players.push(player);
    const b = this.balloons.get(bot);
    if (b !== undefined) { this.balloons.delete(bot); this.balloons.set(player.id, b); }
    this.cpus = this.cpus.filter((c) => c.id !== bot);
    this.local.delete(bot);
    this.remote.forget(bot);
    if (!o.drivers.has(player.character)) this.onNewDriver?.(player.character);
  }
  /** Battle Royale bots' falls per course since the last takeBotFalls(). */
  private botFalls = new Map<string, number>();
  takeBotFalls(): [string, number][] {
    const out = [...this.botFalls];
    this.botFalls.clear();
    return out;
  }

  /** Called when a driver not loaded yet comes in (online Battle Royale): load its pictures. */
  onNewDriver: ((character: number) => void) | null = null;

  /** Battle Royale: the sky (and music) of the course we're on, or nearest to. */
  private followRegion(force: boolean) {
    const o = this.o, w = o.royale!.world.world;
    const p = this.out ? this.cam : this.kart;
    const theme = regionAt(w, p.x, p.y).theme;
    if (theme === this.skyTheme && !force) return;
    this.skyTheme = theme;
    const sky = w.skies.get(theme);
    if (sky) o.renderer.setSky(sky);
    if (!force && o.sound) {
      // Each course has its own music: load its song set and start its race tune again.
      o.sound.course(theme);
      this.musicCue = '';
    }
  }

  /**
   * Battle Royale: the course map (lower screen) shows the whole world, so every driver still in is on it:
   * as wide as the screen on its nearest (widest) line, its south edge on the map's last line.
   */
  private showWorldMap() {
    const w = this.o.royale!.world.world;
    const r = this.o.renderer;
    r.mapZoom = (w.cols * TILE) / (SCREEN_W * MAP_SCALE);
    r.mapOrigin = { x: 0, y: w.rows * TILE - MAP_PX * r.mapZoom };
  }

  /** Battle Royale: the little planet's curve on or off (Race.planet). */
  applyPlanet() {
    if (this.o.royale) this.o.renderer.curve = Race.planet ? 1 / (2 * PLANET_RADIUS) : 0;
  }

  /** Battle Royale: how many drivers are still in. */
  private aliveCount(): number {
    if (!this.o.royale) return 0;
    let n = 0;
    for (const [, b] of this.balloons) if (b > 0) n++;
    const known = this.balloons.size;
    return n + Math.max(0, this.o.players.length - known);
  }

  /** Battle Royale result for this player: place (1 = won), once known. */
  get royaleResult(): { place: number; winner: number | null } | null {
    if (!this.o.royale || (!this.out && this.royaleWinner === null)) return null;
    return { place: this.royalePlace || 1, winner: this.royaleWinner };
  }

  /** Final survival classification, winner first. Limited by the caller for the Top 10 board. */
  royaleStandings(): { id: number; place: number; timeMs: number }[] {
    if (!this.o.royale || this.royaleWinner === null) return [];
    const finalMs = Math.max(0, Math.round(((this.royaleEndedAt || this.finishedAt || performance.now()) - this.startAt)));
    const rows = [...this.royaleOut.entries()].map(([id, r]) => ({ id, ...r }));
    if (!this.royaleOut.has(this.royaleWinner)) rows.push({ id: this.royaleWinner, place: 1, timeMs: finalMs });
    return rows.sort((a, b) => a.place - b.place || b.timeMs - a.timeMs);
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
      if (o.royale) {
        // A Battle Royale bot still in: carry on from where it was.
        if ((this.balloons.get(r.id) ?? 1) <= 0) continue;
        const kart = createKart(o.track, 0, p.character, o.cc);
        Object.assign(kart, { x: r.x, y: r.y, angle: r.a, speed: r.s });
        kart.safe = { x: r.x, y: r.y, angle: r.a };
        const bot = new BotDriver(o.royale.world, r.id, 0.6 + Math.random() * 0.4, Math.random);
        this.cpus.push({ id: r.id, kart, driver: new CpuDriver(o.track, kart, 0.8), finishedAt: 0, bot, item: null, rollingUntil: 0, pickupCooldown: 0 });
        this.local.add(r.id);
        this.remote.forget(r.id);
        continue;
      }
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
    if (!this.o.royale && k.lap >= TOTAL_LAPS && this.finalLapAt === null && !this.o.spectate) this.finalLapAt = frame;
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
    s.engine(this.o.spectate || this.out ? 0 : revving ? 24 : Math.abs(k.speed) * 16);
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
    if (k.fall > 0 && this.fellAt === null && this.o.royale) {
      // Open world: Lakitu brings the kart back to the nearest stretch of racing line, facing along it.
      let best = k.safe, bestD = Infinity;
      for (const p of this.o.royale.spawns) {
        const d = near2(p, k);
        if (d < bestD) { bestD = d; best = p; }
      }
      k.safe = { x: best.x, y: best.y, angle: best.angle };
    }
    if (k.fall > 0) this.fellAt ??= frame;
    else if (this.fellAt !== null && frame - this.fellAt > 40) this.fellAt = null;
    // No laps in a battle: no wrong way either.
    if (this.o.battle) return;
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
    if (this.o.royale && !this.out && !this.finishedAt && this.zone && frame > 0) {
      if (!insideZone(this.zone.now, this.kart.x, this.kart.y)) this.outsideSince ??= frame;
      else this.outsideSince = null;
      if (this.outsideSince !== null) return { kind: 'reverse', t: frame - this.outsideSince };
    }
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
    const remotes = [...this.remote.sample(), ...this.cpus.filter((c) => !c.out).map((c) => netState(c.id, c.kart))]
      .filter((r) => !o.royale || (this.balloons.get(r.id) ?? 1) > 0);
    const charOf = (id: number) => o.players.find((p) => p.id === id)?.character ?? 0;
    const nameOf = (id: number) => CHARACTER_NAMES[charOf(id)];
    const watched = o.spectate || (o.royale && this.out) ? this.watched(remotes) : null;
    const me = this.kart;

    const sprites: Sprite[] = remotes.map((r) => ({
      x: r.x, y: r.y, angle: r.a + (r.d ?? 0), character: charOf(r.id),
      scale: (r.f > 0 ? r.f / 70 : 1) * (r.e & EFFECT_SHRUNK ? 0.5 : 1), lift: r.h,
      alpha: r.e & EFFECT_GHOST ? 0.15 : 1, flash: !!(r.e & EFFECT_STAR),
      smoke: Math.abs(r.d ?? 0) > 0.3 && r.s > 2, dust: r.s > 1 && r.f === 0 && r.h === 0 && terrainAt(o.track, r.x, r.y) === 'slow',
      boost: !!(r.e & EFFECT_BOOST),
      balloons: o.battle ? this.balloons.get(r.id) ?? BATTLE_BALLOONS : 0, balloonPalette: this.balloonPalette(r.id),
    }));
    if (!o.spectate && !this.out) sprites.push({
      x: me.x, y: me.y, angle: kartFacing(me), character: charOf(o.selfId),
      scale: (me.fall > 0 ? me.fall / 70 : 1) * (me.shrink > 0 ? 0.5 : 1), lift: kartHeight(me),
      // Boo: the original flickers our own kart (drawn every other frame, measured).
      alpha: me.ghost > 0 && this.frame % 2 === 0 ? 0 : 1, flash: me.star > 0,
      smoke: Math.abs(me.slide) > 0.3 && me.speed > 2, dust: me.speed > 1 && me.fall === 0 && me.air === 0 && terrainAt(o.track, me.x, me.y) === 'slow',
      boost: isBoosting(me),
      balloons: o.battle ? this.balloons.get(o.selfId) ?? BATTLE_BALLOONS : 0, balloonPalette: this.balloonPalette(o.selfId),
    });

    const frame = this.raceFrame(now);
    const objects: ObjectSprite[] = [];
    const sets = o.royale?.world.world;
    o.track.objects.forEach((obj, i) => {
      const st = objectState(obj.kind, i, frame);
      if (!st.visible) return;
      const set = sets?.objectSets[sets.objectSet[i]];
      const frames = set?.frames ?? o.track.objectFrames;
      objects.push({ x: obj.x, y: obj.y, lift: st.height, frame: Math.floor(frame / 8) % Math.max(1, frames.length), frames: set?.frames, sizes: set?.sizes });
    });
    for (const e of this.entities.values()) {
      // Shells spin: their picture flips every few frames while they move.
      const moving = e.kind === 'greenShell' || e.kind === 'redShell' || e.kind === 'fireball';
      objects.push({ x: e.x, y: e.y, lift: e.lift, item: true, frame: ITEM_FRAME[e.kind], mirror: moving && (frame >> 2) % 2 === 1 });
    }

    // Course map: everyone's head; our own drawn last (on top).
    const marker = (id: number, x: number, y: number, small = false): MapMarker => {
      const c = charOf(id);
      return { x, y, character: c, palette: CHARACTERS[c].palette - 8, small };
    };
    const markers = remotes.filter((r) => r !== watched).map((r) => marker(r.id, r.x, r.y, !!o.royale));
    if (watched) markers.push(marker(watched.id, watched.x, watched.y));
    else if (!o.spectate && !this.out) markers.push(marker(o.selfId, me.x, me.y));

    // Whose numbers the HUD shows: our own kart, or the one a spectator follows.
    const ranked = [{ id: o.selfId, p: this.finishedAt ? Infinity : me.progress }, ...remotes.map((r) => ({ id: r.id, p: r.p }))];
    const focus = watched ? { id: watched.id, p: watched.p, lap: watched.lap } : { id: o.selfId, p: ranked[0].p, lap: me.lap };
    const field = o.spectate ? ranked.slice(1) : ranked;
    // Ties count as ahead: on the grid, the last kart shows 8th like the original.
    const place = field.filter((x) => x.id !== focus.id && x.p >= focus.p).length + 1;
    const raceMs = this.finishedAt ? this.finishedAt - this.startAt : Math.max(0, now - this.startAt);
    const lakitu = this.lakituShow(frame);

    o.renderer.render(this.cam, sprites, objects, markers, (hud) => {
      if (o.royale) {
        if (!this.out && !this.finishedAt) this.drawItemBox(now, hud);
        hud.alive(this.aliveCount());
        if (this.royalePlace === 1 && this.finishedAt) hud.text('WINNER', 128, 40);
        else if (this.out) hud.text(`PLACE ${this.royalePlace}`, 128, 40);
        if (lakitu) hud.lakitu(lakitu, frame);
        return;
      }
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
    if (o.royale && this.out && watched && !this.watchKeys) {
      // Out of the battle: ← → switch whom the camera follows.
      const key = (e: KeyboardEvent) => {
        if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.watchPlace--;
        else if (e.code === 'ArrowRight' || e.code === 'KeyD') this.watchPlace++;
      };
      addEventListener('keydown', key);
      this.unsubs.push(() => removeEventListener('keydown', key));
      this.watchKeys = true;
    }
  }

  private watchKeys = false;
  /** The kart's heading before this frame's step: the camera looks along it. */
  private headingBefore: number | null = null;
  /** The pad last frame (see step: the kart answers it a frame late, as in the original). */
  private lastPad: Input = NO_INPUT;

  /** Held item (or the roulette) in its box at the top center. */
  private drawItemBox(now: number, hud: RaceHud) {
    let icon: number | null = null;
    if (now < this.rollingUntil) icon = Math.floor(now / 70) % ITEM_KINDS.length;
    else if (this.item) icon = ITEM_KINDS.indexOf(this.item);
    if (icon !== null) hud.itemIcon(this.o.itemGfx.icons[icon]);
  }
}

/** Distance between two karts or items, the short way round (the Battle Royale world wraps round). */
function near2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(wrapDX(a.x - b.x), wrapDY(a.y - b.y));
}

/** A 16px box/coin is collected when any part of a kart overlaps it, as in the original. */
function pickupTile(track: Track, x: number, y: number, genre: number): { tx: number; ty: number } | null {
  const cols = track.world ? track.world.cols : 128;
  const rows = track.world ? track.world.rows : 128;
  // Centre first, then the four corners of the kart's practical 16px collision footprint.
  for (const [dx, dy] of [[0, 0], [-8, -8], [8, -8], [-8, 8], [8, 8]] as const) {
    let tx = Math.floor((x + dx) / TILE), ty = Math.floor((y + dy) / TILE);
    if (track.world) {
      tx = (tx % cols + cols) % cols;
      ty = (ty % rows + rows) % rows;
    } else if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
    if (track.genres[ty * cols + tx] === genre) return { tx, ty };
  }
  return null;
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
