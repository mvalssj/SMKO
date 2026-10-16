// Battle Royale matches: 100 karts, people and bots. Whoever comes in takes the place of a bot still in the
// match (its kart, its balloons); with nobody to replace, a new match starts with 99 bots. The bots run in
// one player's browser (the "host"; another takes over if they leave). The server keeps the items, the
// balloons and the safe area (shared/royale.ts) and sends each player the karts near them often, the rest
// a few times a second. It never sees the ROM: players prove they use the same one by its CRC32.

import { WebSocket } from 'ws';
import {
  CHARACTER_NAMES, COUNTDOWN_MS, CPU_ID_BASE, NET_HZ,
  type ClientMsg, type ItemOdds, type KartNetState, type PlayerInfo, type ServerMsg,
} from '../shared/protocol';
import { DEFAULT_ODDS, ItemAuthority, validOdds } from '../shared/items';
import {
  COURSE_TILES, GAP_TILES, GRID_COLS, GRID_ROWS, MARGIN_TILES, ROYALE_PLAYERS, RoyaleAuthority, WORLD_COLS, WORLD_H, WORLD_ROWS, WORLD_W,
  WORLD_LAYOUT, worldCourseAt, wrapDX, wrapDY, wrapDist, wrapX, wrapY, zoneAt,
} from '../shared/royale';
import { COURSE_NAMES } from '../shared/names';
import { adminOut, adminTick, adminWarn, record, registerAdminSource, settings } from './admin';

/** Karts within this distance of a player are sent every tick; the others every FAR_EVERY ticks. */
const NEAR_PX = 1600;
const FAR_EVERY = 5;
/** Nobody new comes into a match once the safe area is down to its last circles. */
const JOIN_UNTIL_PHASE = 3;
/** A finished match stays a little (the last results), then goes. */
const OVER_KEEP_MS = 30_000;
// px per second: a mushroom pushes a kart to 2016 game units (about 8 px a frame), a little over it for some.
const MAX_KART_SPEED = 560;
const MOVE_SLACK = 48;

interface RPlayer {
  id: number;
  ws: WebSocket | null;
  info: PlayerInfo;
  kart: KartNetState | null;
  lastStateAt?: number;
  rejected?: number;
  /** Out of balloons: where the camera is (for the karts we send). */
  focus?: { x: number; y: number };
}

interface Match {
  /** Number shown in the administrator panel. */
  id: number;
  createdAt: number;
  /** Everyone who played in it as a person (for the statistics). */
  people: Set<number>;
  romCrc: number;
  seed: number;
  start: number;
  players: Map<number, RPlayer>;
  /** Slot order (index = starting place). */
  order: number[];
  host: number;
  items: ItemAuthority;
  royale: RoyaleAuthority;
  broken: Set<number>;
  timer: NodeJS.Timeout;
  tickN: number;
  overAt: number;
}

const matches = new Set<Match>();
/** Which match a connection is in. */
const byConn = new Map<number, Match>();
let nextBot = 0;
let nextMatch = 1;

/** Handles a Battle Royale message from connection `id`; false if it isn't one (the room server's). */
export function royaleMessage(ws: WebSocket, id: number, msg: ClientMsg): boolean {
  if (msg.t === 'royaleJoin') {
    if (byConn.has(id)) return true;
    join(ws, id, msg.romCrc >>> 0, msg.character, validOdds(msg.odds) ? msg.odds : DEFAULT_ODDS);
    return true;
  }
  const m = byConn.get(id);
  if (!m) return false;
  const me = m.players.get(id);
  if (!me) return true;
  const racing = Date.now() >= m.start && m.royale.winner === null;
  const isHost = id === m.host;
  const bot = (cpu: number | undefined) => (cpu !== undefined && isHost && m.players.get(cpu)?.info.cpu ? cpu : null);
  switch (msg.t) {
    case 'state':
      updateKart(m, me, { ...msg.k, id });
      break;
    case 'cpu':
      if (!isHost && racing) adminWarn(id, 'order');
      if (!isHost || !Array.isArray(msg.karts)) break;
      for (const k of msg.karts.slice(0, ROYALE_PLAYERS)) {
        const p = m.players.get(k?.id);
        if (p?.info.cpu) updateKart(m, p, k);
      }
      break;
    case 'focus':
      if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) me.focus = { x: msg.x, y: msg.y };
      break;
    case 'box':
    case 'coin':
    case 'use':
    case 'stopRoll': {
      if (!racing) break;
      if (msg.cpu !== undefined && bot(msg.cpu) === null) break;
      if (msg.cpu === undefined && !(m.royale.balloons.get(id)! > 0)) break;
      m.items.handle(id, msg);
      break;
    }
    case 'hit': {
      if (!racing) break;
      const victim = msg.cpu === undefined ? id : bot(msg.cpu);
      if (victim !== null && m.items.hitEntity(victim, msg.entity)) m.royale.pop(victim);
      break;
    }
    case 'pop': {
      if (!racing) break;
      const victim = msg.cpu === undefined ? id : bot(msg.cpu);
      if (victim !== null) m.royale.pop(victim);
      break;
    }
    case 'cpuDrop':
      break;
    case 'break': {
      if (!racing || !Array.isArray(msg.tiles)) break;
      const tiles = msg.tiles.slice(0, 64).filter((i) => Number.isInteger(i) && i >= 0 && i < WORLD_COLS * WORLD_ROWS);
      tiles.forEach((t) => m.broken.add(t));
      if (tiles.length) broadcast(m, { t: 'break', tiles }, id);
      break;
    }
  }
  return true;
}

/** A connection closed: out of its match (the bots move to another browser if it was running them). */
export function royaleClose(id: number) {
  const m = byConn.get(id);
  if (!m) return;
  byConn.delete(id);
  m.players.delete(id);
  m.items.removePlayer(id);
  m.royale.removePlayer(id);
  const people = humans(m);
  if (!people.length) { end(m); return; }
  if (m.host === id) {
    m.host = people[0].id;
    broadcast(m, { t: 'cpuHost', id: m.host });
  }
}

function join(ws: WebSocket, id: number, romCrc: number, wanted: number, odds: ItemOdds) {
  const character = Number.isInteger(wanted) && wanted >= 0 && wanted < CHARACTER_NAMES.length ? wanted : 0;
  const refuse = (message: string) => {
    const data = JSON.stringify({ t: 'error', message } satisfies ServerMsg);
    if (ws.readyState === WebSocket.OPEN) { ws.send(data); adminOut(data.length); }
  };
  if (!settings.modes.royale) return refuse('O Battle Royale online foi desativado pelo administrador do servidor.');
  const now = Date.now();
  // A match in progress with the same ROM, still early enough, room for one more person, and a bot to replace.
  const open = [...matches].find((m) => m.romCrc === romCrc && m.royale.winner === null
    && zoneAt(m.royale.circles, now - m.start, m.royale.zoneScale).phase < JOIN_UNTIL_PHASE
    && humans(m).length < settings.royaleMaxPeople && bots(m, true).length > 0);
  if (open) takeOver(open, ws, id, character);
  else if (matches.size >= settings.maxMatches) refuse('Servidor cheio: o limite de partidas de Battle Royale foi atingido.');
  else create(ws, id, romCrc, character, odds);
}

function create(ws: WebSocket, id: number, romCrc: number, character: number, odds: ItemOdds) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const start = Date.now() + COUNTDOWN_MS;
  const send = (to: number | 'all', msg: ServerMsg) => {
    // Statistics: how long each person lasted.
    if (msg.t === 'royaleOut' && m.people.has(msg.id)) record('survival', { ms: Math.max(0, Date.now() - m.start), won: false });
    if (to === 'all') broadcast(m, msg); else sendTo(m, to, msg);
  };
  const items = new ItemAuthority(odds, send, start, Date.now, Math.random, 'middle', WORLD_COLS * WORLD_ROWS);
  items.onReject = (who) => adminWarn(who, 'item');
  const royale = new RoyaleAuthority(seed, start, send, Date.now, settings.zoneScale);
  const m: Match = {
    id: nextMatch++, createdAt: Date.now(), people: new Set([id]),
    romCrc, seed, start, players: new Map(), order: [], host: id, items, royale, broken: new Set(),
    timer: setInterval(() => {
      const t0 = performance.now();
      tick(m);
      adminTick(performance.now() - t0);
    }, 1000 / NET_HZ), tickN: 0, overAt: 0,
  };
  const people: RPlayer[] = [{ id, ws, info: { id, name: CHARACTER_NAMES[character], character, ready: true }, kart: null }];
  for (let i = 0; i < ROYALE_PLAYERS - 1; i++) {
    const c = (character + 1 + i) % CHARACTER_NAMES.length, bid = CPU_ID_BASE + (nextBot++ % 1_000_000);
    people.push({ id: bid, ws: null, info: { id: bid, name: CHARACTER_NAMES[c], character: c, ready: true, cpu: true }, kart: null });
  }
  // Starting places: shuffled.
  for (let i = people.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [people[i], people[j]] = [people[j], people[i]];
  }
  for (const p of people) {
    m.players.set(p.id, p);
    m.order.push(p.id);
    items.addPlayer(p.id);
    royale.addPlayer(p.id);
  }
  matches.add(m);
  byConn.set(id, m);
  sendStart(m, id);
}

/** A person takes the place of a bot still in the match (the one furthest from the people, inside the safe area). */
function takeOver(m: Match, ws: WebSocket, id: number, character: number) {
  const zone = zoneAt(m.royale.circles, Date.now() - m.start, m.royale.zoneScale).now;
  const people = humans(m).flatMap((p) => (p.kart ? [p.kart] : []));
  const score = (b: RPlayer) => {
    if (!b.kart) return 0;
    const inZone = wrapDist(b.kart.x, b.kart.y, zone.x, zone.y) < zone.r * 0.8 ? 1e6 : 0;
    const away = people.length ? Math.min(...people.map((k) => wrapDist(k.x, k.y, b.kart!.x, b.kart!.y))) : 0;
    return inZone + away;
  };
  const bot = bots(m, true).sort((a, b) => score(b) - score(a))[0];
  const info: PlayerInfo = { id, name: CHARACTER_NAMES[character], character, ready: true };
  m.players.delete(bot.id);
  m.players.set(id, { id, ws, info, kart: bot.kart ? { ...bot.kart, id } : null, lastStateAt: Date.now() });
  m.order[m.order.indexOf(bot.id)] = id;
  m.items.rename(bot.id, id);
  m.royale.rename(bot.id, id);
  m.people.add(id);
  byConn.set(id, m);
  broadcast(m, { t: 'royaleSwap', bot: bot.id, player: info }, id);
  sendStart(m, id, bot.kart ? { x: bot.kart.x, y: bot.kart.y, a: bot.kart.a } : undefined);
  m.items.snapshot(id);
}

function sendStart(m: Match, to: number, at?: { x: number; y: number; a: number }) {
  sendTo(m, to, {
    t: 'royaleStart', seed: m.seed, startInMs: m.start - Date.now(), selfId: to,
    players: m.order.flatMap((id) => { const p = m.players.get(id); return p ? [p.info] : []; }),
    host: m.host, balloons: [...m.royale.balloons], at, broken: [...m.broken], zoneScale: m.royale.zoneScale,
  });
}

function tick(m: Match) {
  m.tickN++;
  m.items.tick();
  m.royale.tick();
  if (m.royale.winner !== null) {
    if (!m.overAt) {
      // Statistics: who won (a person or a bot), where the safe area closed, how long it took.
      const w = m.royale.winner, last = m.royale.circles[m.royale.circles.length - 1];
      const person = m.people.has(w);
      if (person) record('survival', { ms: Math.max(0, Date.now() - m.start), won: true });
      record('royale', {
        ms: Math.max(0, Date.now() - m.start), people: m.people.size, bots: ROYALE_PLAYERS - m.people.size,
        winner: w < 0 ? 'none' : person ? 'person' : 'bot', zone: worldCourseAt(last.x, last.y),
      });
    }
    m.overAt ||= Date.now();
    if (Date.now() - m.overAt > OVER_KEEP_MS) end(m);
  }
  const karts = [...m.players.values()].flatMap((p) => (p.kart && (m.royale.balloons.get(p.id) ?? 0) > 0 ? [p] : []));
  const all = m.tickN % FAR_EVERY === 0;
  for (const p of humans(m)) {
    if (p.ws?.readyState !== WebSocket.OPEN) continue;
    // Near this player's kart (or camera, once out); the host also gets every person (its bots meet them).
    const f = p.focus && !(m.royale.balloons.get(p.id)! > 0) ? p.focus : p.kart;
    const list = karts.filter((k) => {
      if (k.id === p.id || (p.id === m.host && k.info.cpu)) return false;
      if (all || (p.id === m.host && !k.info.cpu)) return true;
      return !!f && Math.abs(wrapDX(k.kart!.x - f.x)) < NEAR_PX && Math.abs(wrapDY(k.kart!.y - f.y)) < NEAR_PX;
    }).map((k) => k.kart!);
    if (list.length) p.ws.send(JSON.stringify({ t: 'states', karts: list } satisfies ServerMsg));
  }
}

function updateKart(m: Match, p: RPlayer, k: KartNetState) {
  if (![k.x, k.y, k.a, k.s, k.f, k.h, k.e].every(Number.isFinite)) return;
  if (!(m.royale.balloons.get(p.id)! > 0)) return;
  const now = Date.now();
  if (p.kart && p.lastStateAt) {
    const dt = (now - p.lastStateAt) / 1000;
    const dist = wrapDist(k.x, k.y, p.kart.x, p.kart.y);
    const rescued = p.kart.f > 0 || k.f > 0;
    if (!rescued && dist > MAX_KART_SPEED * dt + MOVE_SLACK && (p.rejected = (p.rejected ?? 0) + 1) < 10) {
      // Refused: the kart stays where it was last accepted, and that time stays too, so the allowance grows
      // with every following snapshot until an honest kart is believed again (and after 10 it is anyway).
      // Only the first snapshot of such a run may warn: a single jump (a bad connection's bunch of messages)
      // must not add up to the warnings that disconnect a player automatically.
      if (p.rejected === 1 && p.ws && dist > 2 * (MAX_KART_SPEED * dt + MOVE_SLACK) + 64) adminWarn(p.id, 'speed');
      return;
    }
    p.rejected = 0;
  }
  p.lastStateAt = now;
  p.kart = {
    id: p.id, x: wrapX(k.x), y: wrapY(k.y), a: k.a, d: Number.isFinite(k.d) ? clamp(k.d!, -1, 1) : 0,
    s: clamp(k.s, -4, 6), lap: 0, p: 0, f: clamp(k.f, 0, 255), h: clamp(k.h, 0, 64), e: k.e & 15,
  };
  m.royale.updatePos(p.id, p.kart.x, p.kart.y);
}

function end(m: Match) {
  clearInterval(m.timer);
  matches.delete(m);
  for (const id of [...byConn.keys()]) if (byConn.get(id) === m) byConn.delete(id);
}

function humans(m: Match) {
  return [...m.players.values()].filter((p) => !p.info.cpu);
}

function bots(m: Match, alive = false) {
  return [...m.players.values()].filter((p) => p.info.cpu && (!alive || (m.royale.balloons.get(p.id) ?? 0) > 0));
}

function broadcast(m: Match, msg: ServerMsg, exceptId?: number) {
  const data = JSON.stringify(msg);
  for (const p of m.players.values()) if (p.id !== exceptId && p.ws?.readyState === WebSocket.OPEN) { p.ws.send(data); adminOut(data.length); }
}

/** To one player; a bot's news (its item, its coins) goes to the browser running the bots, marked as the bot's. */
function sendTo(m: Match, to: number, msg: ServerMsg) {
  const p = m.players.get(to);
  if (p?.info.cpu) {
    if (msg.t === 'item' || msg.t === 'coins') sendTo(m, m.host, { ...msg, cpu: to });
    return;
  }
  if (p?.ws?.readyState === WebSocket.OPEN) { const data = JSON.stringify(msg); p.ws.send(data); adminOut(data.length); }
}

/** What the administrator panel shows of the matches. */
registerAdminSource({
  matches: () => [...matches].map((m) => {
    const z = zoneAt(m.royale.circles, Date.now() - m.start, m.royale.zoneScale);
    const all = bots(m), alive = m.royale.alive();
    return {
      id: m.id, createdAt: m.createdAt, start: m.start, zonePhase: z.phase, shrinking: z.shrinking, zoneScale: m.royale.zoneScale,
      alive: alive.length, bots: all.length, botsAlive: bots(m, true).length, host: m.host, winner: m.royale.winner,
      people: humans(m).map((p) => ({ id: p.id, character: p.info.character, alive: (m.royale.balloons.get(p.id) ?? 0) > 0, balloons: m.royale.balloons.get(p.id) ?? 0 })),
    };
  }),
  liveMatch: (id) => {
    const m = [...matches].find((x) => x.id === id);
    if (!m) return null;
    const z = zoneAt(m.royale.circles, Date.now() - m.start, m.royale.zoneScale);
    const round = (c: { x: number; y: number; r: number }) => ({ x: Math.round(c.x), y: Math.round(c.y), r: Math.round(c.r) });
    return {
      w: WORLD_W, h: WORLD_H,
      grid: { cols: GRID_COLS, rows: GRID_ROWS, course: COURSE_TILES * 8, gap: GAP_TILES * 8, margin: MARGIN_TILES * 8, names: WORLD_LAYOUT.flat().map((i) => COURSE_NAMES[i]) },
      zone: round(z.now), next: round(z.next),
      karts: [...m.players.values()].flatMap((p) => (p.kart && (m.royale.balloons.get(p.id) ?? 0) > 0
        ? [{ id: p.id, x: Math.round(p.kart.x), y: Math.round(p.kart.y), cpu: !!p.info.cpu, character: p.info.character }] : [])),
    };
  },
});

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
