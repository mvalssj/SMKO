// Room server: lobby, race start, state relay and results for up to 8 players per room.
// It never sees the ROM; clients prove they use the same ROM by its CRC32.
// Serves the built client from dist/ in production.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BATTLE_BALLOONS, BATTLE_MAX_MS, CHARACTER_NAMES, COUNTDOWN_MS, CPU_ID_BASE, GP_NEXT_RACE_MS, GP_POINTS, MAX_PLAYERS, NET_HZ, TOTAL_LAPS,
  type ClientMsg, type Cc, type ItemOdds, type KartNetState, type Standing, type Phase, type PlayerInfo, type ResultEntry, type ServerMsg,
} from '../shared/protocol';
import { DEFAULT_ODDS, ItemAuthority, validOdds } from '../shared/items';
import { royaleClose, royaleMessage } from './royale';
import { COURSE_NAMES } from '../shared/names';
import {
  adminConnect, adminDisconnect, adminHttp, adminIncoming, adminOut, adminTelemetry, adminTick, adminWarn, record, registerAdminSource, settings,
  type RoomView,
} from './admin';

const PORT = Number(process.env.PORT ?? 3077);
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
/** After the first kart finishes, the others get this long before results are shown. */
const FINISH_GRACE_MS = 30_000;
const MIN_RACE_MS = 15_000;

interface Player {
  id: number;
  /** null for CPU players. */
  ws: WebSocket | null;
  info: PlayerInfo;
  kart: KartNetState | null;
  finishMs: number | null;
  /** When the last accepted kart state arrived, and impossible moves refused in a row (speed check). */
  lastStateAt?: number;
  rejected?: number;
}

interface Room {
  code: string;
  romCrc: number;
  hostId: number;
  phase: Phase;
  track: number;
  players: Map<number, Player>;
  raceStart: number;
  finishOrder: number[];
  firstFinishAt: number;
  timer: NodeJS.Timeout | null;
  items: ItemAuthority | null;
  /** Player whose browser simulates the CPUs of the current race. */
  cpuHost: number;
  /** Starting order of the current race (racers only). */
  grid: number[];
  /** The event being run: one race, the 5 races of a cup, or a battle. */
  gp: { tracks: number[]; odds: ItemOdds[]; round: number; points: Map<number, number>; cc: Cc; cpus: boolean; battle: boolean } | null;
  nextRace: NodeJS.Timeout | null;
  /** Battle: balloons left per player, and who went out, in order. */
  balloons: Map<number, number>;
  outOrder: number[];
  /** Map tiles broken this race (fences, ice blocks), for players who arrive mid-race. */
  broken: Set<number>;
}

const rooms = new Map<string, Room>();
let nextId = 1;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const http = createServer((req, res) => {
  if (adminHttp(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Rode "npm run build" ou use "npm run dev".');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (ws, req) => {
  const id = nextId++;
  if (!adminConnect(ws, req, id)) return;
  let room: Room | null = null;

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    const text = String(raw);
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    adminIncoming(id, text.length, msg);
    if (msg.t === 'telemetry') { adminTelemetry(id, msg); return; }
    // Battle Royale matches are their own thing (server/royale.ts).
    if (!room && msg && typeof msg === 'object' && royaleMessage(ws, id, msg)) return;

    if (msg.t === 'join') {
      if (room) return;
      const code = String(msg.room ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!code) return send(ws, { t: 'error', message: 'Código de sala inválido.' });
      let r = rooms.get(code);
      if (!r && rooms.size >= settings.maxRooms) return send(ws, { t: 'error', message: 'Servidor cheio: o limite de salas foi atingido. Tente mais tarde.' });
      if (!r) {
        r = { code, romCrc: msg.romCrc >>> 0, hostId: id, phase: 'lobby', track: 0, players: new Map(),
              raceStart: 0, finishOrder: [], firstFinishAt: 0, timer: null, items: null, cpuHost: 0, grid: [], gp: null, nextRace: null,
              balloons: new Map(), outOrder: [], broken: new Set() };
        rooms.set(code, r);
      }
      if (r.romCrc !== msg.romCrc >>> 0) return send(ws, { t: 'error', message: 'Sua ROM é diferente da ROM do anfitrião da sala (use a mesma versão/região).' });
      const limit = Math.min(MAX_PLAYERS, settings.maxRoomPlayers);
      if (humans(r).length >= limit) return send(ws, { t: 'error', message: `Sala cheia (${limit} jogadores).` });

      // The cursor starts on the first driver nobody has confirmed.
      const used = new Set(humans(r).filter((p) => p.info.ready).map((p) => p.info.character));
      const wanted = Number.isInteger(msg.character) && msg.character >= 0 && msg.character < CHARACTER_NAMES.length ? msg.character : 0;
      const character = used.has(wanted) ? [...CHARACTER_NAMES.keys()].find((c) => !used.has(c)) ?? 0 : wanted;
      const spectator = r.phase !== 'lobby';
      r.players.set(id, { id, ws, info: { id, name: CHARACTER_NAMES[character], character, cursor: character, ready: false, spectator }, kart: null, finishMs: null });
      room = r;
      send(ws, { t: 'welcome', id });
      broadcastRoom(r);
      // Mid-race: watch it from where it is now.
      if (r.phase === 'countdown' || r.phase === 'racing') {
        send(ws, raceMsg(r, r.raceStart - Date.now()));
        r.items?.snapshot(id);
        if (r.broken.size) send(ws, { t: 'break', tiles: [...r.broken] });
        for (const [pid, n] of r.balloons) send(ws, { t: 'balloons', id: pid, n });
      }
      return;
    }

    if (!room) return;
    const r = room;
    const me = r.players.get(id)!;
    const isHost = r.hostId === id;
    // Spectators only watch: nothing they send touches the race.
    if (me.info.spectator && msg.t !== 'character' && msg.t !== 'lobby') return;
    // Only the host chooses the course and starts (the game never sends these otherwise).
    if (!isHost && (msg.t === 'track' || msg.t === 'start')) { adminWarn(id, 'order'); return; }

    switch (msg.t) {
      case 'track':
        if (isHost && r.phase === 'lobby' && Number.isInteger(msg.track) && msg.track >= 0 && msg.track < 24) {
          r.track = msg.track;
          broadcastRoom(r);
        }
        break;

      case 'character': {
        // Cursor moves are shown to everyone; a driver can be confirmed by one player only.
        const c = msg.character;
        if (r.phase !== 'lobby' || !Number.isInteger(c) || c < 0 || c >= CHARACTER_NAMES.length) break;
        me.info.cursor = c;
        if (msg.ready) {
          const taken = humans(r).some((p) => p.id !== id && p.info.ready && p.info.character === c);
          if (taken) {
            me.info.ready = false;
            send(ws, { t: 'error', message: `${CHARACTER_NAMES[c]} já foi escolhido por outro jogador.` });
          } else {
            me.info.ready = true;
            me.info.character = c;
            me.info.name = CHARACTER_NAMES[c];
          }
        } else me.info.ready = false;
        broadcastRoom(r);
        break;
      }

      case 'start':
        if (isHost && r.phase === 'lobby') {
          const tracks = Array.isArray(msg.tracks) ? msg.tracks.filter((t) => Number.isInteger(t) && t >= 0 && t < 24).slice(0, 5) : [];
          if (!tracks.length) tracks.push(r.track);
          const odds = tracks.map((_, i) => (Array.isArray(msg.odds) && validOdds(msg.odds[i]) ? msg.odds[i] : DEFAULT_ODDS));
          const cc: Cc = msg.cc === 50 || msg.cc === 150 ? msg.cc : 100;
          const battle = msg.battle === true;
          const mode = battle ? 'battle' : tracks.length > 1 ? 'gp' : 'vs';
          if (!settings.modes[mode]) {
            send(ws, { t: 'error', message: 'Este modo foi desativado pelo administrador do servidor.' });
            break;
          }
          // Battle Mode is one arena, people only (no CPUs in the original's battles).
          r.gp = { tracks: battle ? tracks.slice(0, 1) : tracks, odds, round: 0, points: new Map(), cc, cpus: msg.cpus === true && !battle, battle };
          assignDrivers(r);
          startRace(r);
        }
        break;

      case 'box':
      case 'coin':
      case 'use':
      case 'stopRoll':
        if (r.phase === 'racing' && me.finishMs === null) r.items?.handle(id, msg);
        break;

      case 'hit': {
        if (r.phase !== 'racing') break;
        const victim = msg.cpu === undefined ? id : id === r.cpuHost && r.players.get(msg.cpu)?.info.cpu ? msg.cpu : null;
        if (victim !== null && r.items?.hitEntity(victim, msg.entity)) popBalloon(r, victim);
        break;
      }

      case 'pop':
        if (r.phase === 'racing') popBalloon(r, id);
        break;

      case 'cpu':
        if (id !== r.cpuHost && r.phase === 'racing') adminWarn(id, 'order');
        if (id !== r.cpuHost || (r.phase !== 'countdown' && r.phase !== 'racing') || !Array.isArray(msg.karts)) break;
        for (const k of msg.karts) {
          const cpu = r.players.get(k?.id);
          if (cpu?.info.cpu) updateKart(r, cpu, k);
        }
        break;

      case 'cpuDrop':
        if (id === r.cpuHost && r.phase === 'racing' && r.players.get(msg.cpu)?.info.cpu) r.items?.cpuDrop(msg.cpu, msg.x, msg.y, msg.a, msg.kind);
        break;

      case 'lobby':
        if (isHost && r.phase === 'results') {
          if (r.nextRace) clearTimeout(r.nextRace);
          r.nextRace = null;
          r.gp = null;
          removeCpus(r);
          // Everyone (spectators too) picks a driver again.
          for (const p of r.players.values()) { p.info.spectator = false; p.info.ready = false; p.info.cursor = p.info.character; }
          r.phase = 'lobby';
          broadcastRoom(r);
        }
        break;

      case 'state':
        if (r.phase === 'countdown' || r.phase === 'racing') updateKart(r, me, { ...msg.k, id });
        break;

      case 'break': {
        if (r.phase !== 'racing' || !Array.isArray(msg.tiles)) break;
        const tiles = msg.tiles.slice(0, 64).filter((i) => Number.isInteger(i) && i >= 0 && i < 128 * 128);
        tiles.forEach((t) => r.broken.add(t));
        if (tiles.length) broadcast(r, { t: 'break', tiles }, id);
        break;
      }

      case 'finish': {
        // The CPU host also reports its CPUs finishing.
        const who = msg.cpu === undefined ? me : id === r.cpuHost ? r.players.get(msg.cpu) : undefined;
        if (!who || (msg.cpu !== undefined && !who.info.cpu)) break;
        if (r.phase !== 'racing' || who.finishMs !== null) break;
        const elapsed = Date.now() - r.raceStart;
        if ((who.kart?.lap ?? 0) < TOTAL_LAPS || elapsed < MIN_RACE_MS) { if (msg.cpu === undefined) adminWarn(id, 'order'); break; }
        // Trust the client's own timer, but not beyond what the server observed.
        who.finishMs = clamp(Math.round(msg.timeMs), MIN_RACE_MS, elapsed + 1000);
        r.finishOrder.push(who.id);
        if (r.finishOrder.length === 1) r.firstFinishAt = Date.now();
        broadcast(r, { t: 'finished', id: who.id, place: r.finishOrder.length, timeMs: who.finishMs });
        break;
      }
    }
  });

  ws.on('close', () => {
    adminDisconnect(id);
    royaleClose(id);
    if (!room) return;
    const r = room;
    r.players.delete(id);
    r.items?.removePlayer(id);
    if (!humans(r).length) {
      if (r.timer) clearInterval(r.timer);
      if (r.nextRace) clearTimeout(r.nextRace);
      rooms.delete(r.code);
      return;
    }
    if (r.hostId === id) r.hostId = humans(r)[0].id;
    // The CPUs' browser left mid-race: another player takes them over from where they are.
    if (r.cpuHost === id && (r.phase === 'countdown' || r.phase === 'racing')) {
      r.cpuHost = r.hostId;
      broadcast(r, { t: 'cpuHost', id: r.cpuHost });
    }
    if (r.gp?.battle && r.phase === 'racing') checkBattleOver(r);
    broadcastRoom(r);
  });
});

function startRace(r: Room) {
  const gp = r.gp!;
  r.track = gp.tracks[gp.round];
  const odds = gp.odds[gp.round];
  // CPUs join for the whole event (added once, on the first race).
  if (gp.round === 0) removeCpus(r);
  if (gp.round === 0 && gp.cpus) {
    // One CPU per free driver, up to 8 karts.
    const used = new Set([...r.players.values()].map((p) => p.info.character));
    let n = 0;
    for (let c = 0; c < CHARACTER_NAMES.length && r.players.size < MAX_PLAYERS; c++) {
      if (used.has(c)) continue;
      const cid = CPU_ID_BASE + n++;
      r.players.set(cid, { id: cid, ws: null, info: { id: cid, name: CHARACTER_NAMES[c], character: c, ready: true, cpu: true }, kart: null, finishMs: null });
    }
  }
  for (const p of humans(r).filter((h) => h.info.spectator)) {
    const cpu = [...r.players.values()].find((c) => c.info.cpu);
    const used = new Set(racers(r).map((x) => x.info.character));
    let character: number | undefined;
    if (cpu) { character = cpu.info.character; r.players.delete(cpu.id); gp.points.delete(cpu.id); }
    else if (racers(r).length < MAX_PLAYERS) character = [...CHARACTER_NAMES.keys()].find((c) => !used.has(c));
    if (character === undefined) continue; // full: keeps watching
    p.info = { ...p.info, character, cursor: character, name: CHARACTER_NAMES[character], spectator: false, ready: true };
  }
  r.cpuHost = r.hostId;
  const ids = racers(r).map((p) => p.id);
  // First race: random grid. Then by Grand Prix points, the leader on pole.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  if (gp.round > 0) ids.sort((a, b) => (gp.points.get(b) ?? 0) - (gp.points.get(a) ?? 0));
  for (const p of r.players.values()) { p.kart = null; p.finishMs = null; }
  r.finishOrder = [];
  r.firstFinishAt = 0;
  r.grid = ids;
  r.broken.clear();
  r.outOrder = [];
  r.balloons = new Map(gp.battle ? ids.map((id) => [id, BATTLE_BALLOONS]) : []);
  r.phase = 'countdown';
  r.raceStart = Date.now() + COUNTDOWN_MS;
  r.items = new ItemAuthority(odds, (to, msg, except) => {
    if (to === 'all') broadcast(r, msg, except);
    else { const ws = r.players.get(to)?.ws; if (ws?.readyState === WebSocket.OPEN) send(ws, msg); }
  }, r.raceStart);
  r.items.onReject = (who) => adminWarn(who, 'item');
  // Statistics: the course and the drivers people picked.
  for (const p of racers(r)) if (!p.info.cpu) record('pick', { mode: modeOf(r), course: COURSE_NAMES[r.track] ?? '?', character: p.info.character });
  for (const id of ids) r.items.addPlayer(id);
  broadcastRoom(r);
  broadcast(r, raceMsg(r, COUNTDOWN_MS));

  if (r.timer) clearInterval(r.timer);
  r.timer = setInterval(() => {
    const t0 = performance.now();
    tick(r);
    adminTick(performance.now() - t0);
  }, 1000 / NET_HZ);
}

function modeOf(r: Room): RoomView['mode'] {
  if (r.phase === 'lobby' || !r.gp) return 'lobby';
  return r.gp.battle ? 'battle' : r.gp.tracks.length > 1 ? 'gp' : 'vs';
}

/** What the administrator panel shows of the rooms. */
registerAdminSource({
  rooms: () => [...rooms.values()].map((r) => ({
    code: r.code, mode: modeOf(r), phase: r.phase, course: COURSE_NAMES[r.track] ?? '?', cc: r.gp?.cc ?? null,
    round: r.gp ? r.gp.round + 1 : 0, rounds: r.gp?.tracks.length ?? 0, host: r.hostId,
    cpuHost: r.phase === 'countdown' || r.phase === 'racing' ? r.cpuHost : null,
    raceStart: r.phase === 'lobby' ? null : r.raceStart,
    players: [...r.players.values()].filter((p) => !p.info.cpu || r.phase !== 'lobby').map((p) => ({
      id: p.id, character: p.info.character, cpu: !!p.info.cpu, spectator: !!p.info.spectator, ready: !!p.info.ready,
    })),
  })),
  liveRoom: (code) => {
    const r = rooms.get(code);
    if (!r) return null;
    return {
      w: 1024, h: 1024,
      karts: [...r.players.values()].flatMap((p) => (p.kart && !(r.gp?.battle && r.balloons.get(p.id) === 0)
        ? [{ id: p.id, x: Math.round(p.kart.x), y: Math.round(p.kart.y), cpu: !!p.info.cpu, character: p.info.character }] : [])),
    };
  },
});

function raceMsg(r: Room, startInMs: number): ServerMsg {
  const gp = r.gp!;
  return {
    t: 'race', track: r.track, laps: TOTAL_LAPS, grid: r.grid, startInMs,
    players: racers(r).map((p) => p.info), cpuHost: r.cpuHost,
    cc: gp.cc, round: gp.round, rounds: gp.tracks.length, battle: gp.battle,
  };
}

/** Battle: one balloon less; at none the player is out; the last one with balloons wins. */
function popBalloon(r: Room, id: number) {
  if (!r.gp?.battle) return;
  const n = r.balloons.get(id);
  if (!n) return;
  r.balloons.set(id, n - 1);
  broadcast(r, { t: 'balloons', id, n: n - 1 });
  if (n - 1 === 0) {
    r.outOrder.push(id);
    const p = r.players.get(id);
    if (p) { p.finishMs = Date.now() - r.raceStart; p.kart = null; }
    checkBattleOver(r);
  }
}

function checkBattleOver(r: Room) {
  const alive = racers(r).filter((p) => (r.balloons.get(p.id) ?? 0) > 0);
  if (alive.length <= 1 && r.phase === 'racing') endRace(r);
}

/** Connected people (not CPUs), in joining order. */
function humans(r: Room) {
  return [...r.players.values()].filter((p) => !p.info.cpu);
}

/** Karts in the race: people who aren't watching, and CPUs. */
function racers(r: Room) {
  return [...r.players.values()].filter((p) => !p.info.spectator);
}

/** Race start: unconfirmed players get the driver under their cursor if it's free, else the first free one. */
function assignDrivers(r: Room) {
  const used = new Set(humans(r).filter((p) => p.info.ready).map((p) => p.info.character));
  for (const p of humans(r)) {
    if (p.info.ready) continue;
    const c = p.info.cursor !== undefined && !used.has(p.info.cursor) ? p.info.cursor : [...CHARACTER_NAMES.keys()].find((x) => !used.has(x))!;
    used.add(c);
    p.info = { ...p.info, character: c, name: CHARACTER_NAMES[c], ready: true };
  }
}

function tick(r: Room) {
  const now = Date.now();
  if (r.phase === 'countdown' && now >= r.raceStart) {
    r.phase = 'racing';
    broadcastRoom(r);
  }

  r.items?.tick();
  const karts = [...r.players.values()].flatMap((p) => (p.kart ? [p.kart] : []));
  broadcast(r, { t: 'states', karts });

  if (r.gp?.battle) {
    if (r.phase === 'racing' && now - r.raceStart > BATTLE_MAX_MS) endRace(r);
    return;
  }
  const allDone = racers(r).every((p) => p.finishMs !== null);
  if (r.phase === 'racing' && r.finishOrder.length > 0 && (allDone || now - r.firstFinishAt > FINISH_GRACE_MS)) {
    endRace(r);
  }
}

/** Fastest a kart can really move (px per second: boosts, ramps), and slack for network jitter. */
// px per second: a mushroom pushes a kart to 2016 game units (about 8 px a frame), a little over it for some.
const MAX_KART_SPEED = 560;
const MOVE_SLACK = 48;

function updateKart(r: Room, p: Player, k: KartNetState) {
  if (![k.x, k.y, k.a, k.s, k.lap, k.p, k.f, k.h, k.e].every(Number.isFinite)) return;
  // Out of a battle: no kart any more.
  if (r.gp?.battle && r.balloons.get(p.id) === 0) return;
  // Kart physics run in the browsers; the server refuses moves no kart could make (except Lakitu's
  // rescue, which puts a kart that fell back on the course).
  const now = Date.now();
  if (p.kart && p.lastStateAt) {
    const dt = (now - p.lastStateAt) / 1000;
    const dist = Math.hypot(k.x - p.kart.x, k.y - p.kart.y);
    const rescued = p.kart.f > 0 || k.f > 0;
    // A kart put back on the course by Lakitu (or a CPU taken back to its path) is accepted after a moment.
    if (!rescued && dist > MAX_KART_SPEED * dt + MOVE_SLACK && (p.rejected = (p.rejected ?? 0) + 1) < 10) {
      // A warning only for a jump far beyond what messages arriving in a bunch (a bad connection) explain,
      // and only once for a run of refused snapshots (one jump must not add up to an automatic kick).
      if (p.rejected === 1 && p.ws && dist > 2 * (MAX_KART_SPEED * dt + MOVE_SLACK) + 64) adminWarn(p.id, 'speed');
      return;
    }
    p.rejected = 0;
  }
  p.lastStateAt = now;
  const prevLap = p.kart?.lap ?? 0;
  p.kart = {
    id: p.id,
    x: clamp(k.x, -64, 1088), y: clamp(k.y, -64, 1088), a: k.a, d: Number.isFinite(k.d) ? clamp(k.d!, -1, 1) : 0, s: clamp(k.s, -4, 6),
    // Laps can only move one at a time.
    lap: clamp(Math.round(k.lap), prevLap - 1, prevLap + 1),
    p: k.p, f: clamp(k.f, 0, 255), h: clamp(k.h, 0, 64), e: k.e & 15,
  };
  r.items?.updateKart(p.id, p.kart.lap, p.kart.p);
}

function removeCpus(r: Room) {
  for (const p of [...r.players.values()]) if (p.info.cpu) r.players.delete(p.id);
}

function endRace(r: Room) {
  if (r.timer) clearInterval(r.timer);
  r.timer = null;
  record('match', {
    mode: modeOf(r), course: COURSE_NAMES[r.track] ?? '?', cc: r.gp?.cc ?? 100, ms: Math.max(0, Date.now() - r.raceStart),
    people: racers(r).filter((p) => !p.info.cpu).length, bots: racers(r).filter((p) => p.info.cpu).length,
  });
  r.phase = 'results';
  if (r.gp?.battle) {
    // Winner first (most balloons left), then the last ones out; the time is how long each lasted.
    const elapsed = Date.now() - r.raceStart;
    const alive = racers(r).filter((p) => (r.balloons.get(p.id) ?? 0) > 0)
      .sort((a, b) => (r.balloons.get(b.id) ?? 0) - (r.balloons.get(a.id) ?? 0));
    const out = [...r.outOrder].reverse().flatMap((id) => { const p = r.players.get(id); return p ? [p] : []; });
    const results: ResultEntry[] = [...alive.map((p) => ({ id: p.id, name: p.info.name, timeMs: elapsed })), ...out.map((p) => ({ id: p.id, name: p.info.name, timeMs: p.finishMs }))];
    broadcast(r, { t: 'results', results, standings: [], round: 0, rounds: 1, final: true });
    broadcastRoom(r);
    return;
  }
  const finished = r.finishOrder.flatMap((id) => {
    const p = r.players.get(id);
    return p ? [{ id, name: p.info.name, timeMs: p.finishMs }] : [];
  });
  const rest: ResultEntry[] = racers(r)
    .filter((p) => p.finishMs === null)
    .sort((a, b) => (b.kart?.p ?? -1e9) - (a.kart?.p ?? -1e9))
    .map((p) => ({ id: p.id, name: p.info.name, timeMs: null }));
  const results = [...finished, ...rest];
  const gp = r.gp!;
  results.forEach((e, place) => gp.points.set(e.id, (gp.points.get(e.id) ?? 0) + GP_POINTS[place]));
  const standings: Standing[] = racers(r)
    .map((p) => ({ id: p.id, name: p.info.name, points: gp.points.get(p.id) ?? 0 }))
    .sort((a, b) => b.points - a.points);
  const final = gp.round >= gp.tracks.length - 1;
  broadcast(r, { t: 'results', results, standings, round: gp.round, rounds: gp.tracks.length, final });
  broadcastRoom(r);
  // Grand Prix: next race of the cup after a short pause.
  if (!final) {
    r.nextRace = setTimeout(() => {
      r.nextRace = null;
      if (r.phase !== 'results' || !r.gp) return;
      r.gp.round++;
      startRace(r);
    }, GP_NEXT_RACE_MS);
  }
}

function broadcastRoom(r: Room) {
  broadcast(r, {
    t: 'room', room: r.code, hostId: r.hostId, phase: r.phase, track: r.track,
    // CPUs only exist during a race; the lobby shows the people.
    players: [...r.players.values()].filter((p) => !p.info.cpu || r.phase !== 'lobby').map((p) => p.info),
  });
}

function broadcast(r: Room, msg: ServerMsg, exceptId?: number) {
  const data = JSON.stringify(msg);
  for (const p of r.players.values()) if (p.id !== exceptId && p.ws?.readyState === WebSocket.OPEN) { p.ws.send(data); adminOut(data.length); }
}

function send(ws: WebSocket, msg: ServerMsg) {
  const data = JSON.stringify(msg);
  ws.send(data);
  adminOut(data.length);
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

http.listen(PORT, () => console.log(`SMKO servidor em http://localhost:${PORT}  (WebSocket em /ws, painel em /admin${process.env.SMKO_ADMIN_PASSWORD ? '' : ' — defina SMKO_ADMIN_PASSWORD para ativar'})`));
