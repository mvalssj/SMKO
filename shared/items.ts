// Item authority: item rolls, item boxes, coins, thrown items and hits.
// The online server runs one per race; solo practice runs the same class in the browser.

import {
  ITEM_KINDS, STEP_MS,
  type ClientMsg, type EntityKind, type ItemKind, type ItemOdds, type NetEntity, type ServerMsg,
} from './protocol';

export const ROULETTE_MS = 1000;
export const BOX_RESPAWN_MS = 10_000;
export const MAX_COINS = 10;
/** Every Grand Prix race starts with 5 coins (measured: 50cc top speed 823 = 783 + 5 coins x 8). */
export const START_COINS = 5;

/** Mario Circuit 1's odds; used if the host didn't send the track's own. */
export const DEFAULT_ODDS: ItemOdds = {
  middle: [6, 0, 1, 7, 8, 6, 0, 4, 0],
  leader: [2, 0, 0, 10, 8, 2, 0, 10, 0],
  back: [13, 0, 4, 1, 1, 12, 0, 0, 1],
};

interface PlayerItems {
  item: ItemKind | null;
  rollingUntil: number;
  rolled: ItemKind | null;
  coins: number;
  lap: number;
  progress: number;
}

type Send = (to: number | 'all', msg: ServerMsg, except?: number) => void;

export class ItemAuthority {
  private players = new Map<number, PlayerItems>();
  private entities = new Map<number, NetEntity>();
  private usedBoxes = new Map<number, { tiles: number[]; restoreAt: number }>();
  private takenCoins = new Set<number>();
  private nextEntity = 1;

  constructor(
    private odds: ItemOdds,
    private send: Send,
    private raceStartMs: number,
    private now: () => number = Date.now,
    private random: () => number = Math.random,
    /** Solo practice has nobody to compare with: roll as if mid-pack. */
    private forceSituation: keyof ItemOdds | null = null,
    /** Tiles on the floor (a course has 128 x 128; the Battle Royale world more). */
    private tileCount = 128 * 128,
  ) {}

  addPlayer(id: number) {
    this.players.set(id, { item: null, rollingUntil: 0, rolled: null, coins: START_COINS, lap: 0, progress: 0 });
  }

  removePlayer(id: number) {
    this.players.delete(id);
  }

  updateKart(id: number, lap: number, progress: number) {
    const p = this.players.get(id);
    if (p) { p.lap = lap; p.progress = progress; }
  }

  /** Handles item messages from a player; returns false for anything else. */
  handle(id: number, msg: ClientMsg): boolean {
    // CPUs' hits (and Battle Royale bots' boxes, coins and items) come from whoever simulates them.
    if ((msg.t === 'hit' || msg.t === 'box' || msg.t === 'coin' || msg.t === 'use') && msg.cpu !== undefined) id = msg.cpu;
    const p = this.players.get(id);
    if (!p) return false;
    switch (msg.t) {
      case 'box': this.onBox(id, p, msg.tiles); return true;
      case 'coin': this.onCoin(id, p, msg.tiles); return true;
      case 'use': this.onUse(id, p, msg); return true;
      case 'hit': this.hitEntity(id, msg.entity); return true;
      default: return false;
    }
  }

  /** Call regularly (each server tick): finishes roulettes, brings item boxes back. */
  tick() {
    const now = this.now();
    for (const p of this.players.values()) {
      if (p.rolled && now >= p.rollingUntil) {
        p.item = p.rolled;
        p.rolled = null;
      }
    }
    for (const [key, box] of this.usedBoxes) {
      if (now >= box.restoreAt) {
        this.usedBoxes.delete(key);
        this.send('all', { t: 'tiles', tiles: box.tiles, restore: true });
      }
    }
  }

  private frame() {
    return Math.floor((this.now() - this.raceStartMs) / STEP_MS);
  }

  private onBox(id: number, p: PlayerItems, tiles: number[]) {
    tiles = cleanTiles(tiles, 16, this.tileCount);
    if (!tiles.length) return;
    const key = Math.min(...tiles);
    if (this.usedBoxes.has(key) || p.item || p.rolled) return;
    this.usedBoxes.set(key, { tiles, restoreAt: this.now() + BOX_RESPAWN_MS });
    this.send('all', { t: 'tiles', tiles, restore: false });
    p.rolled = this.roll(id, p);
    p.rollingUntil = this.now() + ROULETTE_MS;
    this.send(id, { t: 'item', item: p.rolled, roll: true });
  }

  private onCoin(id: number, p: PlayerItems, tiles: number[]) {
    tiles = cleanTiles(tiles, 4, this.tileCount);
    if (!tiles.length || tiles.some((t) => this.takenCoins.has(t))) return;
    tiles.forEach((t) => this.takenCoins.add(t));
    this.send('all', { t: 'tiles', tiles, restore: false });
    p.coins = Math.min(MAX_COINS, p.coins + 1);
    this.send(id, { t: 'coins', coins: p.coins });
  }

  private onUse(id: number, p: PlayerItems, msg: Extract<ClientMsg, { t: 'use' }>) {
    if (!p.item || p.rolled) return;
    if (![msg.x, msg.y, msg.a].every(Number.isFinite)) return;
    const item = p.item;
    p.item = null;
    this.send(id, { t: 'item', item: null });

    switch (item) {
      case 'mushroom':
      case 'star':
      case 'feather':
        this.send('all', { t: 'effect', id, kind: item });
        break;
      case 'ghost': {
        // Boo steals a random rival's item.
        const victims = [...this.players.entries()].filter(([vid, v]) => vid !== id && v.item && !v.rolled);
        if (victims.length) {
          const [vid, v] = victims[Math.floor(this.random() * victims.length)];
          p.item = v.item;
          v.item = null;
          this.send(vid, { t: 'item', item: null });
          this.send(id, { t: 'item', item: p.item });
        }
        this.send('all', { t: 'effect', id, kind: 'ghost' });
        break;
      }
      case 'coins':
        p.coins = Math.min(MAX_COINS, p.coins + 2);
        this.send(id, { t: 'coins', coins: p.coins });
        break;
      case 'lightning':
        // Everyone else shrinks and drops their item.
        for (const [vid, v] of this.players) {
          if (vid === id) continue;
          if (v.item || v.rolled) {
            v.item = v.rolled = null;
            this.send(vid, { t: 'item', item: null });
          }
        }
        this.send('all', { t: 'effect', id, kind: 'lightning' });
        break;
      default: {
        const kind = item as EntityKind;
        // Bananas are dropped behind; shells are thrown forward unless `back`.
        const behind = kind === 'banana' || msg.back;
        const a = behind && kind !== 'banana' ? msg.a + Math.PI : msg.a;
        const dist = behind ? -14 : 12;
        const e: NetEntity = {
          id: this.nextEntity++, kind, owner: id,
          x: msg.x + Math.sin(msg.a) * dist, y: msg.y - Math.cos(msg.a) * dist, a,
          frame: this.frame(),
          target: kind === 'redShell' && !behind ? this.playerAhead(id) : null,
        };
        this.entities.set(e.id, e);
        this.send('all', { t: 'spawn', e });
      }
    }
  }

  /** Brings a player who arrives mid-race (spectator) up to date: taken boxes/coins and items on the track. */
  snapshot(to: number) {
    const tiles = [...[...this.usedBoxes.values()].flatMap((b) => b.tiles), ...this.takenCoins];
    if (tiles.length) this.send(to, { t: 'tiles', tiles, restore: false });
    for (const e of this.entities.values()) this.send(to, { t: 'spawn', e });
  }

  /** A CPU drops a banana behind it (CPUs don't use item boxes). */
  cpuDrop(cpu: number, x: number, y: number, a: number, kind: EntityKind = 'banana') {
    if (!this.players.has(cpu) || ![x, y, a].every(Number.isFinite)) return;
    if (!CPU_DROPS.includes(kind)) return;
    const e: NetEntity = {
      id: this.nextEntity++, kind, owner: cpu,
      x: x - Math.sin(a) * 14, y: y + Math.cos(a) * 14, a, frame: this.frame(), target: null,
    };
    this.entities.set(e.id, e);
    this.send('all', { t: 'spawn', e });
  }

  /** A player (or CPU) reports being hit by an entity; false if it was already gone. */
  hitEntity(id: number, entity: number): boolean {
    const p = this.players.get(id);
    if (!p || !this.entities.delete(entity)) return false;
    this.send('all', { t: 'despawn', id: entity, victim: id });
    if (p.coins > 0) {
      p.coins = Math.max(0, p.coins - 2);
      this.send(id, { t: 'coins', coins: p.coins });
    }
    return true;
  }

  private ranked(): number[] {
    return [...this.players.entries()].sort((a, b) => b[1].progress - a[1].progress).map(([id]) => id);
  }

  private playerAhead(id: number): number | null {
    const order = this.ranked();
    const i = order.indexOf(id);
    return i > 0 ? order[i - 1] : null;
  }

  private roll(id: number, p: PlayerItems): ItemKind {
    let situation: keyof ItemOdds;
    if (this.forceSituation) situation = this.forceSituation;
    else {
      const rank = this.ranked().indexOf(id) + 1;
      situation = p.lap <= 1 || rank === 1 ? 'leader' : rank <= 4 ? 'middle' : 'back';
    }
    const weights = this.odds[situation];
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return ITEM_KINDS[i];
    }
    return 'banana';
  }
}

function cleanTiles(tiles: unknown, max: number, count: number): number[] {
  if (!Array.isArray(tiles)) return [];
  return tiles.slice(0, max).filter((t): t is number => Number.isInteger(t) && t >= 0 && t < count);
}

const CPU_DROPS: EntityKind[] = ['banana', 'greenShell', 'poison', 'fireball', 'egg'];

export function validOdds(o: unknown): o is ItemOdds {
  const ok = (w: unknown) => Array.isArray(w) && w.length === 9 && w.every((n) => Number.isInteger(n) && n >= 0 && n <= 32);
  return !!o && typeof o === 'object' && ok((o as ItemOdds).leader) && ok((o as ItemOdds).middle) && ok((o as ItemOdds).back);
}
