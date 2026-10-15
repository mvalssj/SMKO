// Administrator panel: a live view of the server (connections, rooms, Battle Royale matches, its health),
// moderation (warnings, kicks, bans), statistics kept in a SQLite file, and settings changed without a
// restart. Served at /admin behind the password in SMKO_ADMIN_PASSWORD (no password set: no panel).
// Like the rest of the server it never sees the ROM; whole IP addresses are never shown (a masked one, and a
// salted hash to recognise a banned player coming back).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { CHARACTER_NAMES, MAX_PLAYERS, NET_HZ, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { COURSE_NAMES } from '../shared/names';
import { ROYALE_PLAYERS } from '../shared/royale';

const PASSWORD = process.env.SMKO_ADMIN_PASSWORD ?? '';
const DATA_DIR = process.env.SMKO_DATA_DIR ?? join(process.cwd(), 'data');
/** Behind a reverse proxy (nginx, Render, Fly...): take the player's address from X-Forwarded-For. */
const TRUST_PROXY = process.env.SMKO_TRUST_PROXY === '1';
const PAGE = fileURLToPath(new URL('./admin.html', import.meta.url));
const SESSION_MS = 12 * 3600_000;
/** Warnings older than this no longer count towards sending a player away. */
const WARN_WINDOW_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

// ---------- Settings (changed from the panel, kept on disk) ----------

export interface Settings {
  modes: { vs: boolean; gp: boolean; battle: boolean; royale: boolean };
  /** Rooms (VS, Grand Prix, Battle) at once. */
  maxRooms: number;
  /** People per room (up to 8). */
  maxRoomPlayers: number;
  /** Battle Royale matches at once. */
  maxMatches: number;
  /** People per Battle Royale match (bots fill the rest of the 100). */
  royaleMaxPeople: number;
  /** How slowly the safe area closes in new matches (1 = normal, 2 = twice as slow). */
  zoneScale: number;
  /** Warnings within 10 minutes that send a player away (0 = never). */
  autoKick: number;
}

const DEFAULTS: Settings = {
  modes: { vs: true, gp: true, battle: true, royale: true },
  maxRooms: 200, maxRoomPlayers: MAX_PLAYERS, maxMatches: 20, royaleMaxPeople: ROYALE_PLAYERS, zoneScale: 1, autoKick: 30,
};

export const settings: Settings = structuredClone(DEFAULTS);

function cleanSettings(input: unknown): Settings {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const modes = (o.modes && typeof o.modes === 'object' ? o.modes : {}) as Record<string, unknown>;
  const int = (v: unknown, min: number, max: number, def: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v as number))) : def);
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    modes: { vs: bool(modes.vs, settings.modes.vs), gp: bool(modes.gp, settings.modes.gp), battle: bool(modes.battle, settings.modes.battle), royale: bool(modes.royale, settings.modes.royale) },
    maxRooms: int(o.maxRooms, 0, 10_000, settings.maxRooms),
    maxRoomPlayers: int(o.maxRoomPlayers, 1, MAX_PLAYERS, settings.maxRoomPlayers),
    maxMatches: int(o.maxMatches, 0, 1000, settings.maxMatches),
    royaleMaxPeople: int(o.royaleMaxPeople, 1, ROYALE_PLAYERS, settings.royaleMaxPeople),
    zoneScale: Number.isFinite(o.zoneScale) ? Math.min(3, Math.max(0.5, Math.round((o.zoneScale as number) * 100) / 100)) : settings.zoneScale,
    autoKick: int(o.autoKick, 0, 1000, settings.autoKick),
  };
}

// ---------- What is kept on disk ----------

interface Ban { hash: string; masked: string; who: string; reason: string; at: number; until: number | null }
interface LogEntry { at: number; what: string }

const store = {
  /** Salt of the address hashes (so a hash can't be turned back into an address by trying them all). */
  salt: randomBytes(16).toString('hex'),
  settings: DEFAULTS,
  bans: [] as Ban[],
  /** Most people connected at once, per day (YYYY-MM-DD). */
  peaks: {} as Record<string, number>,
  /** What the administrators did, newest last. */
  log: [] as LogEntry[],
};

mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = join(DATA_DIR, 'admin.json');
if (existsSync(STORE_FILE)) {
  try { Object.assign(store, JSON.parse(readFileSync(STORE_FILE, 'utf8'))); } catch { /* damaged: start again */ }
}
Object.assign(settings, cleanSettings(store.settings));

let saveTimer: NodeJS.Timeout | null = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    store.settings = settings;
    store.log = store.log.slice(-500);
    try { writeFileSync(STORE_FILE, JSON.stringify(store, null, 1)); } catch (e) { console.error('admin: não foi possível salvar', e); }
  }, 2000);
}

function logAction(what: string) {
  store.log.push({ at: Date.now(), what });
  saveSoon();
}

// ---------- Statistics: events in SQLite (node:sqlite), or in memory if this Node has none ----------

type EventRow = { at: number; kind: string; data: Record<string, unknown> };
interface EventDb { add(kind: string, data: object): void; since(at: number): EventRow[]; kind: 'sqlite' | 'memory' }

const eventDb: EventDb = await (async () => {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(DATA_DIR, 'stats.db'));
    db.exec('CREATE TABLE IF NOT EXISTS events (at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_at ON events (at);');
    const insert = db.prepare('INSERT INTO events (at, kind, data) VALUES (?, ?, ?)');
    const select = db.prepare('SELECT at, kind, data FROM events WHERE at >= ? ORDER BY at');
    return {
      kind: 'sqlite',
      add: (kind, data) => { insert.run(Date.now(), kind, JSON.stringify(data)); },
      since: (at) => (select.all(at) as { at: number; kind: string; data: string }[]).map((r) => ({ at: Number(r.at), kind: r.kind, data: JSON.parse(r.data) })),
    };
  } catch {
    console.warn('admin: node:sqlite indisponível (Node 22.5 ou mais novo); estatísticas só em memória.');
    const rows: EventRow[] = [];
    return {
      kind: 'memory',
      add: (kind, data) => { rows.push({ at: Date.now(), kind, data: data as Record<string, unknown> }); if (rows.length > 100_000) rows.shift(); },
      since: (at) => rows.filter((r) => r.at >= at),
    };
  }
})();

/** Something to count in the statistics: a race or battle played, a driver picked, a Battle Royale... */
export function record(kind: 'match' | 'pick' | 'royale' | 'survival', data: object) {
  try { eventDb.add(kind, data); } catch (e) { console.error('admin: estatística não gravada', e); }
}

// ---------- Connections ----------

interface Conn {
  id: number;
  ws: WebSocket;
  hash: string;
  masked: string;
  at: number;
  ping: number | null;
  pingSentAt: number;
  msgs: number;
  bytes: number;
  /** Kart states received, and those that came much later than the one before (a bad connection). */
  states: number;
  late: number;
  lastStateAt: number;
  telemetry: { fps: number; mobile: boolean; gamepad: boolean; wide: boolean; at: number } | null;
  warnings: { at: number; kind: string }[];
  warnTotal: number;
}

const conns = new Map<number, Conn>();
/** When each address connected lately (reconnections). */
const recentConnects = new Map<string, number[]>();
/** Latest warnings, for the moderation page. */
const warnFeed: { at: number; id: number; masked: string; kind: string }[] = [];

function clientAddress(req: IncomingMessage): string {
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  return (fwd || req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
}

function hashAddress(ip: string) {
  return createHash('sha256').update(store.salt + ip).digest('hex').slice(0, 12);
}

function maskAddress(ip: string) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 2).join('.') + '.x.x';
  if (ip.includes(':')) return ip.split(':').slice(0, 2).join(':') + ':…';
  return '?';
}

function activeBan(hash: string): Ban | undefined {
  const now = Date.now();
  return store.bans.find((b) => b.hash === hash && (b.until === null || b.until > now));
}

function sendTo(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify(msg);
  ws.send(data);
  adminOut(data.length);
}

/** A new connection: refused (with the reason) if its address is banned. */
export function adminConnect(ws: WebSocket, req: IncomingMessage, id: number): boolean {
  const ip = clientAddress(req);
  const hash = hashAddress(ip);
  const ban = activeBan(hash);
  if (ban) {
    sendTo(ws, { t: 'error', message: `Você foi banido deste servidor${ban.until ? ` até ${new Date(ban.until).toLocaleString('pt-BR')}` : ''}. Motivo: ${ban.reason}` });
    sendTo(ws, { t: 'notice', message: `Você foi banido deste servidor. Motivo: ${ban.reason}` });
    ws.close(4003, 'banned');
    return false;
  }
  const now = Date.now();
  conns.set(id, {
    id, ws, hash, masked: maskAddress(ip), at: now, ping: null, pingSentAt: 0, msgs: 0, bytes: 0,
    states: 0, late: 0, lastStateAt: 0, telemetry: null, warnings: [], warnTotal: 0,
  });
  const recent = (recentConnects.get(hash) ?? []).filter((t) => now - t < 3600_000);
  recent.push(now);
  recentConnects.set(hash, recent);
  ws.on('pong', () => {
    const c = conns.get(id);
    if (!c || !c.pingSentAt) return;
    const ms = Date.now() - c.pingSentAt;
    c.ping = c.ping === null ? ms : Math.round(c.ping * 0.7 + ms * 0.3);
  });
  const day = dayOf(now);
  if ((store.peaks[day] ?? 0) < conns.size) { store.peaks[day] = conns.size; saveSoon(); }
  return true;
}

export function adminDisconnect(id: number) {
  conns.delete(id);
}

/** Every message received (for the counters, and late kart states). */
export function adminIncoming(id: number, bytes: number, msg: ClientMsg) {
  counters.msgsIn++;
  counters.bytesIn += bytes;
  const c = conns.get(id);
  if (!c) return;
  c.msgs++;
  c.bytes += bytes;
  if (msg.t === 'state') {
    const now = Date.now();
    // States come NET_HZ times a second; one four times later than due (but not after a pause) is late.
    if (c.lastStateAt && now - c.lastStateAt > (4000 / NET_HZ) && now - c.lastStateAt < 5000) c.late++;
    c.states++;
    c.lastStateAt = now;
  }
}

/** Every message sent (bytes). */
export function adminOut(bytes: number) {
  counters.msgsOut++;
  counters.bytesOut += bytes;
}

/** A browser's report (frame rate, device; the bots' falls per course). */
export function adminTelemetry(id: number, msg: Extract<ClientMsg, { t: 'telemetry' }>) {
  const c = conns.get(id);
  if (!c || (c.telemetry && Date.now() - c.telemetry.at < 20_000)) return;
  if (!Number.isFinite(msg.fps) || msg.fps < 0 || msg.fps > 500) return;
  const t = { fps: Math.round(msg.fps * 10) / 10, mobile: msg.mobile === true, gamepad: msg.gamepad === true, wide: msg.wide === true, at: Date.now() };
  // The device once per connection; the frame rate every time.
  try {
    if (!c.telemetry) eventDb.add('device', { mobile: t.mobile, gamepad: t.gamepad, wide: t.wide });
    eventDb.add('fps', { fps: t.fps, mobile: t.mobile });
    if (Array.isArray(msg.falls)) {
      for (const f of msg.falls.slice(0, 30)) {
        if (Array.isArray(f) && COURSE_NAMES.includes(f[0]) && Number.isInteger(f[1]) && f[1] > 0 && f[1] <= 1000) eventDb.add('falls', { course: f[0], n: f[1] });
      }
    }
  } catch (e) { console.error('admin: telemetria não gravada', e); }
  c.telemetry = t;
}

const WARN_LABELS: Record<string, string> = {
  speed: 'velocidade impossível',
  item: 'item usado sem ter',
  order: 'mensagem fora de hora ou sem permissão',
};

/** Something only a modified game would do; enough of them in a while and the player is sent away. */
export function adminWarn(id: number, kind: keyof typeof WARN_LABELS) {
  const c = conns.get(id);
  if (!c) return; // a bot (its browser's mistakes aren't the person's)
  const now = Date.now();
  c.warnings = c.warnings.filter((w) => now - w.at < WARN_WINDOW_MS);
  c.warnings.push({ at: now, kind });
  c.warnTotal++;
  warnFeed.push({ at: now, id, masked: c.masked, kind });
  if (warnFeed.length > 300) warnFeed.shift();
  if (settings.autoKick > 0 && c.warnings.length >= settings.autoKick) {
    logAction(`Expulsão automática de #${id} (${c.masked}): ${c.warnings.length} avisos em 10 min`);
    kick(id, 'Você foi desconectado automaticamente: o servidor recebeu mensagens que o jogo normal não envia.');
  }
}

function kick(id: number, message: string): boolean {
  const c = conns.get(id);
  if (!c) return false;
  sendTo(c.ws, { t: 'notice', message });
  c.ws.close(4000, 'kick');
  return true;
}

/** Sends a message to everyone connected (shown over the game). */
function noticeAll(message: string) {
  for (const c of conns.values()) sendTo(c.ws, { t: 'notice', message });
}

// Ping everyone every few seconds (the WebSocket's own ping; the browser answers by itself).
setInterval(() => {
  const now = Date.now();
  for (const c of conns.values()) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    c.pingSentAt = now;
    try { c.ws.ping(); } catch { /* closing */ }
  }
}, 5000).unref();

// ---------- Rooms and matches (the room server and the Battle Royale server describe theirs) ----------

export interface RoomView {
  code: string;
  mode: 'lobby' | 'vs' | 'gp' | 'battle';
  phase: string;
  course: string;
  cc: number | null;
  round: number;
  rounds: number;
  host: number;
  cpuHost: number | null;
  raceStart: number | null;
  players: { id: number; character: number; cpu: boolean; spectator: boolean; ready: boolean }[];
}

export interface MatchView {
  id: number;
  createdAt: number;
  start: number;
  zonePhase: number;
  shrinking: boolean;
  zoneScale: number;
  alive: number;
  botsAlive: number;
  bots: number;
  host: number;
  winner: number | null;
  people: { id: number; character: number; alive: boolean; balloons: number }[];
}

export interface LiveView {
  /** World size (px) and, for the Battle Royale, the course grid and the safe area. */
  w: number;
  h: number;
  grid?: { cols: number; rows: number; course: number; gap: number; margin: number; names: string[] };
  zone?: { x: number; y: number; r: number };
  next?: { x: number; y: number; r: number };
  karts: { id: number; x: number; y: number; cpu: boolean; character: number }[];
}

interface Source {
  rooms: () => RoomView[];
  liveRoom: (code: string) => LiveView | null;
  matches: () => MatchView[];
  liveMatch: (id: number) => LiveView | null;
}

const source: Source = { rooms: () => [], liveRoom: () => null, matches: () => [], liveMatch: () => null };
export function registerAdminSource(part: Partial<Source>) {
  Object.assign(source, part);
}

/** Where each connection is: a room, a Battle Royale match, or still in the menus. */
function whereAll(rooms: RoomView[], matches: MatchView[]) {
  const where = new Map<number, { label: string; role: string; character: number | null; botHost: boolean }>();
  for (const r of rooms) {
    for (const p of r.players) {
      if (p.cpu) continue;
      const role = r.phase === 'lobby' ? 'lobby' : p.spectator ? 'assistindo' : 'correndo';
      where.set(p.id, { label: `Sala ${r.code}`, role, character: p.character, botHost: r.cpuHost === p.id && r.players.some((x) => x.cpu) });
    }
  }
  for (const m of matches) {
    for (const p of m.people) {
      where.set(p.id, { label: `Battle Royale #${m.id}`, role: m.winner !== null ? 'fim' : p.alive ? 'correndo' : 'assistindo', character: p.character, botHost: m.host === p.id });
    }
  }
  return where;
}

// ---------- Health ----------

const counters = { msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0 };
const ticks: number[] = [];
/** A room's or match's update took this long (ms). */
export function adminTick(ms: number) {
  ticks.push(ms);
}

const startedAt = Date.now();
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let lastCpu = process.cpuUsage();
let lastSampleAt = performance.now();
let lastCounters = { ...counters };
interface Sample { t: number; players: number; cpu: number; tickAvg: number; tickMax: number; loop: number; msgsIn: number; msgsOut: number; kbIn: number; kbOut: number }
let health: Sample = { t: Date.now(), players: 0, cpu: 0, tickAvg: 0, tickMax: 0, loop: 0, msgsIn: 0, msgsOut: 0, kbIn: 0, kbOut: 0 };
const history: Sample[] = [];

setInterval(() => {
  const now = performance.now();
  const secs = (now - lastSampleAt) / 1000;
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  const tickAvg = ticks.length ? ticks.reduce((a, b) => a + b, 0) / ticks.length : 0;
  const rate = (k: keyof typeof counters) => (counters[k] - lastCounters[k]) / secs;
  health = {
    t: Date.now(),
    players: conns.size,
    cpu: Math.round(((cpu.user + cpu.system) / 1000 / (secs * 1000)) * 1000) / 10,
    tickAvg: Math.round(tickAvg * 100) / 100,
    tickMax: Math.round(Math.max(0, ...ticks) * 100) / 100,
    loop: Math.round((loop.percentile(99) / 1e6) * 10) / 10,
    msgsIn: Math.round(rate('msgsIn')), msgsOut: Math.round(rate('msgsOut')),
    kbIn: Math.round(rate('bytesIn') / 102.4) / 10, kbOut: Math.round(rate('bytesOut') / 102.4) / 10,
  };
  ticks.length = 0;
  loop.reset();
  lastCounters = { ...counters };
  lastSampleAt = now;
  history.push(health);
  if (history.length > 300) history.shift();
}, 1000).unref();

function dayOf(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- The panel's answers ----------

function overview() {
  const rooms = source.rooms(), matches = source.matches();
  const where = whereAll(rooms, matches);
  const count = (role: string) => [...where.values()].filter((w) => w.role === role).length;
  const today = dayOf(Date.now());
  const week = Array.from({ length: 7 }, (_, i) => store.peaks[dayOf(Date.now() - i * DAY_MS)] ?? 0);
  const mem = process.memoryUsage();
  return {
    now: Date.now(),
    players: conns.size,
    peakToday: store.peaks[today] ?? conns.size,
    peakWeek: Math.max(conns.size, ...week),
    rooms: {
      lobby: rooms.filter((r) => r.mode === 'lobby').length,
      vs: rooms.filter((r) => r.mode === 'vs').length,
      gp: rooms.filter((r) => r.mode === 'gp').length,
      battle: rooms.filter((r) => r.mode === 'battle').length,
      royale: matches.length,
    },
    people: { menu: conns.size - where.size, lobby: count('lobby'), racing: count('correndo'), watching: count('assistindo') + count('fim') },
    health: { ...health, uptime: Date.now() - startedAt, rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576), node: process.version },
    history,
    stats: eventDb.kind,
  };
}

function roomsAndMatches() {
  const rooms = source.rooms(), matches = source.matches();
  return {
    rooms: rooms.map((r) => ({
      ...r,
      people: r.players.filter((p) => !p.cpu).length,
      bots: r.players.filter((p) => p.cpu).length,
      spectators: r.players.filter((p) => p.spectator).length,
      hostFps: conns.get(r.cpuHost ?? -1)?.telemetry?.fps ?? null,
    })),
    matches: matches.map((m) => ({ ...m, hostFps: conns.get(m.host)?.telemetry?.fps ?? null, hostPing: conns.get(m.host)?.ping ?? null })),
  };
}

function players() {
  const where = whereAll(source.rooms(), source.matches());
  const now = Date.now();
  return [...conns.values()].map((c) => {
    const w = where.get(c.id);
    return {
      id: c.id, masked: c.masked, hash: c.hash, since: now - c.at, ping: c.ping,
      where: w?.label ?? 'Menu', role: w?.role ?? 'menu', character: w?.character ?? null, driver: w?.character != null ? CHARACTER_NAMES[w.character] : null,
      botHost: w?.botHost ?? false,
      reconnects: Math.max(0, (recentConnects.get(c.hash)?.filter((t) => now - t < 3600_000).length ?? 1) - 1),
      late: c.states ? Math.round((c.late / c.states) * 1000) / 10 : 0,
      msgs: c.msgs, kb: Math.round(c.bytes / 102.4) / 10,
      fps: c.telemetry?.fps ?? null, mobile: c.telemetry?.mobile ?? null, gamepad: c.telemetry?.gamepad ?? null, wide: c.telemetry?.wide ?? null,
      warnings: c.warnings.filter((x) => now - x.at < WARN_WINDOW_MS).length, warnTotal: c.warnTotal,
    };
  });
}

function moderation() {
  const now = Date.now();
  return {
    feed: warnFeed.slice(-100).reverse().map((w) => ({ ...w, label: WARN_LABELS[w.kind] ?? w.kind })),
    bans: store.bans.map((b) => ({ ...b, active: b.until === null || b.until > now })).reverse(),
    log: store.log.slice(-100).reverse(),
    autoKick: settings.autoKick,
  };
}

function stats(days: number) {
  const since = Date.now() - days * DAY_MS;
  const rows = eventDb.since(since);
  const perDay: Record<string, Record<string, number>> = {};
  for (let i = days - 1; i >= 0; i--) perDay[dayOf(Date.now() - i * DAY_MS)] = {};
  const durations: Record<string, { n: number; ms: number }> = {};
  const courses: Record<string, number> = {}, drivers: Record<string, number> = {}, falls: Record<string, number> = {}, zone: Record<string, number> = {};
  const royale = { matches: 0, personWins: 0, botWins: 0, survivalMs: 0, survivalN: 0, wonN: 0, people: 0 };
  const devices = { total: 0, mobile: 0, gamepad: 0, wide: 0 };
  const fps = { mobile: { n: 0, sum: 0 }, desktop: { n: 0, sum: 0 } };
  const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
  for (const { at, kind, data: d } of rows) {
    const day = dayOf(at);
    if (kind === 'match' || kind === 'royale') {
      const mode = kind === 'royale' ? 'royale' : String(d.mode);
      if (perDay[day]) inc(perDay[day], mode);
      const dur = (durations[mode] ??= { n: 0, ms: 0 });
      dur.n++;
      dur.ms += Number(d.ms) || 0;
    }
    if (kind === 'pick') { inc(courses, String(d.course)); inc(drivers, CHARACTER_NAMES[Number(d.character)] ?? '?'); }
    if (kind === 'royale') {
      royale.matches++;
      royale.people += Number(d.people) || 0;
      if (d.winner === 'person') royale.personWins++;
      else if (d.winner === 'bot') royale.botWins++;
      inc(zone, Number(d.zone) >= 0 ? COURSE_NAMES[Number(d.zone)] : 'Estradas');
    }
    if (kind === 'survival') { royale.survivalN++; royale.survivalMs += Number(d.ms) || 0; if (d.won) royale.wonN++; }
    if (kind === 'falls') inc(falls, String(d.course), Number(d.n) || 0);
    if (kind === 'device') { devices.total++; if (d.mobile) devices.mobile++; if (d.gamepad) devices.gamepad++; if (d.wide) devices.wide++; }
    if (kind === 'fps') { const f = d.mobile ? fps.mobile : fps.desktop; f.n++; f.sum += Number(d.fps) || 0; }
  }
  const sorted = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return {
    days,
    perDay: Object.entries(perDay),
    durations: Object.entries(durations).map(([mode, v]) => ({ mode, n: v.n, avgMs: v.n ? Math.round(v.ms / v.n) : 0 })),
    courses: sorted(courses), drivers: sorted(drivers), falls: sorted(falls), zone: sorted(zone),
    royale: { ...royale, survivalAvgMs: royale.survivalN ? Math.round(royale.survivalMs / royale.survivalN) : 0 },
    devices,
    fps: { mobile: fps.mobile.n ? Math.round((fps.mobile.sum / fps.mobile.n) * 10) / 10 : null, desktop: fps.desktop.n ? Math.round((fps.desktop.sum / fps.desktop.n) * 10) / 10 : null, samples: fps.mobile.n + fps.desktop.n },
    peaks: Object.keys(perDay).map((day) => [day, store.peaks[day] ?? 0]),
  };
}

// ---------- HTTP ----------

const sessions = new Map<string, number>();
const loginFails = new Map<string, number[]>();

function cookie(req: IncomingMessage, name: string) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function signedIn(req: IncomingMessage) {
  const token = cookie(req, 'smko_admin');
  const until = token ? sessions.get(token) : undefined;
  if (!until || until < Date.now()) { if (token) sessions.delete(token); return false; }
  return true;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 16_384) { req.destroy(); resolve({}); } });
    req.on('end', () => { try { const v = JSON.parse(data || '{}'); resolve(v && typeof v === 'object' ? v : {}); } catch { resolve({}); } });
  });
}

function samePassword(given: string) {
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(PASSWORD).digest();
  return timingSafeEqual(a, b);
}

/** Handles /admin and /admin/api/*; false for any other address. */
export function adminHttp(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;
  void handle(req, res, url).catch((e) => { console.error('admin:', e); json(res, 500, { error: 'Erro interno.' }); });
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname.replace(/\/+$/, '') || '/admin';
  if (path === '/admin') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
    }).end(readFileSync(PAGE));
    return;
  }
  if (!path.startsWith('/admin/api/')) { json(res, 404, { error: 'Não encontrado.' }); return; }
  const route = path.slice('/admin/api/'.length);
  const post = req.method === 'POST';
  // Changes only from the panel's own page (a form on another site can't add this header).
  if (post && req.headers['x-smko-admin'] !== '1') { json(res, 403, { error: 'Pedido recusado.' }); return; }

  if (route === 'me') { json(res, 200, { configured: !!PASSWORD, signedIn: !!PASSWORD && signedIn(req) }); return; }

  if (route === 'login' && post) {
    if (!PASSWORD) { json(res, 403, { error: 'Painel desativado: defina SMKO_ADMIN_PASSWORD no servidor.' }); return; }
    const who = hashAddress(clientAddress(req));
    const now = Date.now();
    const fails = (loginFails.get(who) ?? []).filter((t) => now - t < 10 * 60_000);
    if (fails.length >= 5) { json(res, 429, { error: 'Muitas tentativas. Espere alguns minutos.' }); return; }
    const body = await readBody(req);
    if (typeof body.password !== 'string' || !samePassword(body.password)) {
      fails.push(now);
      loginFails.set(who, fails);
      json(res, 401, { error: 'Senha incorreta.' });
      return;
    }
    loginFails.delete(who);
    const token = randomBytes(24).toString('hex');
    sessions.set(token, now + SESSION_MS);
    const secure = (req.socket as { encrypted?: boolean }).encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    json(res, 200, { ok: true }, { 'set-cookie': `smko_admin=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${secure}` });
    return;
  }

  if (!PASSWORD || !signedIn(req)) { json(res, 401, { error: 'Entre com a senha.' }); return; }

  if (route === 'logout' && post) {
    sessions.delete(cookie(req, 'smko_admin'));
    json(res, 200, { ok: true }, { 'set-cookie': 'smko_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0' });
    return;
  }
  if (!post) {
    switch (route) {
      case 'overview': json(res, 200, overview()); return;
      case 'rooms': json(res, 200, roomsAndMatches()); return;
      case 'players': json(res, 200, players()); return;
      case 'moderation': json(res, 200, moderation()); return;
      case 'stats': json(res, 200, stats(Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30)))); return;
      case 'settings': json(res, 200, { settings, defaults: DEFAULTS }); return;
      case 'live': {
        const room = url.searchParams.get('room'), match = url.searchParams.get('match');
        const v = room ? source.liveRoom(room) : match ? source.liveMatch(Number(match)) : null;
        json(res, v ? 200 : 404, v ?? { error: 'Partida não encontrada.' });
        return;
      }
    }
    json(res, 404, { error: 'Não encontrado.' });
    return;
  }

  const body = await readBody(req);
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'sem motivo informado';
  switch (route) {
    case 'kick': {
      const id = Number(body.id);
      const ok = kick(id, `Você foi desconectado pelo administrador. Motivo: ${reason}`);
      if (ok) logAction(`Expulsou #${id}: ${reason}`);
      json(res, ok ? 200 : 404, ok ? { ok } : { error: 'Jogador não está conectado.' });
      return;
    }
    case 'ban': {
      const id = Number(body.id);
      const c = conns.get(id);
      if (!c) { json(res, 404, { error: 'Jogador não está conectado.' }); return; }
      const hours = Number(body.hours);
      const until = Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3600_000 : null;
      const where = whereAll(source.rooms(), source.matches()).get(id);
      const who = `#${id}${where?.character != null ? ` (${CHARACTER_NAMES[where.character]})` : ''}`;
      store.bans = store.bans.filter((b) => b.hash !== c.hash);
      store.bans.push({ hash: c.hash, masked: c.masked, who, reason, at: Date.now(), until });
      logAction(`Baniu ${who} (${c.masked}) ${until ? `por ${hours} h` : 'para sempre'}: ${reason}`);
      // Everyone from that address goes.
      for (const other of [...conns.values()]) if (other.hash === c.hash) kick(other.id, `Você foi banido deste servidor. Motivo: ${reason}`);
      json(res, 200, { ok: true });
      return;
    }
    case 'unban': {
      const before = store.bans.length;
      store.bans = store.bans.filter((b) => b.hash !== body.hash);
      if (store.bans.length !== before) logAction(`Removeu o banimento de ${String(body.hash)}`);
      saveSoon();
      json(res, 200, { ok: store.bans.length !== before });
      return;
    }
    case 'close-room': {
      const r = source.rooms().find((x) => x.code === body.code);
      if (!r) { json(res, 404, { error: 'Sala não encontrada.' }); return; }
      for (const p of r.players) if (!p.cpu) kick(p.id, 'A sala foi encerrada pelo administrador.');
      logAction(`Encerrou a sala ${r.code}`);
      json(res, 200, { ok: true });
      return;
    }
    case 'end-match': {
      const m = source.matches().find((x) => x.id === Number(body.id));
      if (!m) { json(res, 404, { error: 'Partida não encontrada.' }); return; }
      for (const p of m.people) kick(p.id, 'A partida foi encerrada pelo administrador.');
      logAction(`Encerrou a partida de Battle Royale #${m.id}`);
      json(res, 200, { ok: true });
      return;
    }
    case 'notice': {
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 200) : '';
      if (!message) { json(res, 400, { error: 'Escreva a mensagem.' }); return; }
      noticeAll(message);
      logAction(`Aviso para todos (${conns.size}): ${message}`);
      json(res, 200, { ok: true, sent: conns.size });
      return;
    }
    case 'settings': {
      const next = cleanSettings(body.settings);
      Object.assign(settings, next);
      logAction(`Mudou as configurações: ${JSON.stringify(next)}`);
      saveSoon();
      json(res, 200, { ok: true, settings });
      return;
    }
  }
  json(res, 404, { error: 'Não encontrado.' });
}
