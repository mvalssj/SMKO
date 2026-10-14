import {
  CHARACTER_NAMES, COUNTDOWN_MS, CPU_ID_BASE, type Cc, type PlayerInfo, type ResultEntry, type ServerMsg, type Standing,
} from '../shared/protocol';
import { SmkRom, type DriverSprites, type TrackInfo } from './rom/rom';
import { loadRaceGfx } from './rom/race-gfx';
import { NetClient } from './net/client';
import { LocalChannel } from './net/local';
import { Race, formatTime } from './game/race';
import { Renderer } from './game/renderer';
import { MenuApp, type LobbyView } from './menu/app';
import { BoardPlayer } from './menu/board-player';
import { Ceremony } from './menu/ceremony';
import { MUSIC, Sound } from './audio/sound';
import { saveTrial, winCup } from './menu/progress';
import type { Board } from './menu/results';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let rom: SmkRom | null = null;
let menu: MenuApp | null = null;
let renderer: Renderer | null = null;
let race: Race | null = null;
let solo: LocalChannel | null = null;
let net: NetClient | null = null;
let selfId = 0;
let room: Extract<ServerMsg, { t: 'room' }> | null = null;

/** Solo Grand Prix in progress: the 5 races of a cup against the 7 CPUs; 3 lives, one lost per race finished 5th or worse. */
let gp: { tracks: TrackInfo[]; cc: Cc; players: PlayerInfo[]; round: number; points: Map<number, number>; lives: number } | null = null;
/** Plays the RESULTS / STANDINGS boards. */
let boards: BoardPlayer | null = null;
/** Driver frames of the last race, for the karts driving across the boards. */
let lastDrivers = new Map<number, DriverSprites | null>();
let lastTrack: TrackInfo | null = null;
let lastTrackData: ReturnType<SmkRom['loadTrack']> | null = null;
let ceremony: Ceremony | null = null;
/** The game's music and sound (starts on the first key or click: browsers need a gesture first). */
let sound: Sound | null = null;
let lastCc: Cc = 50;

// ---------- Screens ----------

function show(screen: 'rom' | 'menu' | 'game') {
  for (const s of ['rom', 'menu', 'game']) $(`screen-${s}`).hidden = s !== screen;
  if (screen === 'menu') menu?.show(); else menu?.hide();
  if (screen === 'menu' && sound) { sound.engine(0); sound.menu(); sound.music(MUSIC.menu); }
}

function localStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

// Sound: started by the first gesture, ports sent every frame; M mutes.
for (const ev of ['keydown', 'pointerdown'] as const) addEventListener(ev, () => void sound?.start(), { once: false });
setInterval(() => sound?.frame(), 1000 / 60);
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || !sound || e.target instanceof HTMLInputElement) return;
  sound.setMuted(!sound.muted);
  try { localStorage.setItem('smko-mute', sound.muted ? '1' : '0'); } catch { /* private mode */ }
});

function status(id: string, text: string, error = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', error);
}

// ---------- ROM ----------

async function loadRom(bytes: Uint8Array, remember: boolean) {
  try {
    rom = new SmkRom(bytes);
    if (rom.region !== 'US') throw new Error('Use a ROM americana (USA): as telas e os sprites originais foram mapeados nela.');
    menu = new MenuApp(rom, $('menu-canvas') as HTMLCanvasElement, {
      solo: startSolo,
      online: ({ code }) => void connect(code ?? randomRoom()),
      onlineCharacter: (character, ready) => net?.send({ t: 'character', character, ready }),
      onlineStart: ({ cc, tracks, mode }) => net?.send({
        t: 'start', cc, cpus: mode !== 'battle', battle: mode === 'battle',
        tracks: tracks.map((t) => rom!.tracks.indexOf(t)),
        odds: tracks.map((t) => rom!.itemOdds(t)),
      }),
      onlineLeave: leaveOnline,
    });
  } catch (e) {
    rom = null;
    status('rom-status', (e as Error).message, true);
    return;
  }
  if (remember) await saveRom(bytes);
  boards = new BoardPlayer(rom, $('board') as HTMLCanvasElement);
  sound = new Sound(rom);
  sound.setMuted(localStorageGet('smko-mute') === '1');
  sound.menu();
  sound.music(MUSIC.menu);
  const raceGfx = loadRaceGfx(rom);
  ceremony = raceGfx ? new Ceremony(rom, $('board') as HTMLCanvasElement, raceGfx) : null;
  show('menu');
  // Invite link (?sala=CODE): straight into that room (its lobby, or watching the race in progress).
  const invited = roomFromUrl();
  if (invited) void connect(invited);
}

function roomFromUrl(): string | null {
  const code = new URLSearchParams(location.search).get('sala')?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return code || null;
}

const fileInput = $('rom-file') as HTMLInputElement;
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (f) await loadRom(new Uint8Array(await f.arrayBuffer()), true);
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (f) await loadRom(new Uint8Array(await f.arrayBuffer()), true);
});

// The ROM is remembered in this browser only (IndexedDB) so it doesn't have to be picked every time.
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('smko', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('rom');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveRom(bytes: Uint8Array) {
  try {
    const db = await idb();
    db.transaction('rom', 'readwrite').objectStore('rom').put(bytes, 'rom');
  } catch { /* storage unavailable: just ask again next time */ }
}
async function loadSavedRom(): Promise<Uint8Array | null> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const req = db.transaction('rom').objectStore('rom').get('rom');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ---------- Solo: Grand Prix and Time Trial ----------

function startSolo(choice: { mode: 'gp' | 'tt'; cc: Cc; character: number; tracks: TrackInfo[] }) {
  const me: PlayerInfo = { id: 1, name: CHARACTER_NAMES[choice.character], character: choice.character, ready: true };
  if (choice.mode === 'tt') {
    gp = null;
    runSoloRace(choice.tracks[0], choice.cc, [me], [], false);
    return;
  }
  const cpus: PlayerInfo[] = CHARACTER_NAMES.map((name, c) => ({ id: CPU_ID_BASE + c, name, character: c, ready: true, cpu: true }))
    .filter((p) => p.character !== choice.character);
  gp = { tracks: choice.tracks, cc: choice.cc, players: [me, ...cpus], round: 0, points: new Map(), lives: 3 };
  nextGpRace();
}

function nextGpRace() {
  const g = gp!;
  // First race: you start last, as in the original. Then the grid follows the points.
  const ids = g.players.map((p) => p.id);
  if (g.round === 0) ids.push(ids.shift()!);
  else ids.sort((a, b) => (g.points.get(b) ?? 0) - (g.points.get(a) ?? 0));
  const cpus = g.players.filter((p) => p.cpu);
  runSoloRace(g.tracks[g.round], g.cc, g.players, cpus.map((c) => ({ id: c.id, slot: ids.indexOf(c.id), skill: 0.55 + Math.random() * 0.45 })), true, ids.indexOf(1), g.lives);
}

function runSoloRace(track: TrackInfo, cc: Cc, players: PlayerInfo[], cpus: { id: number; slot: number; skill: number }[], items: boolean, slot = 0, lives?: number) {
  solo?.close();
  solo = new LocalChannel(1, rom!.itemOdds(track), COUNTDOWN_MS, cpus.map((c) => c.id));
  lastTrack = track;
  lastCc = cc;
  startRace({ track: rom!.loadTrack(track), cc, players, cpus, items, selfId: 1, slot, startInMs: COUNTDOWN_MS, online: false, lives });
  const check = () => {
    if (!race || net) return;
    if (!race.finished) { setTimeout(check, 250); return; }
    // As in the original: the race goes on for a few seconds (lap times on screen), then the results.
    setTimeout(() => { if (race && !net) finishSoloRace(race.results()); }, 5500);
  };
  check();
}

function finishSoloRace(results: ResultEntry[] | { id: number; timeMs: number | null }[]) {
  if (!gp) {
    // Time Trial: the lap times stay on screen; the run goes into the course's records.
    const t = race!.times;
    const rec = lastTrack ? saveTrial(rom!.tracks.indexOf(lastTrack), t.totalMs, t.laps) : { best: false, lap: false };
    status('results-hint', `${rec.best ? 'NOVO RECORDE! ' : ''}${rec.lap ? 'Melhor volta! ' : ''}Pressione Enter para voltar`);
    $('results').hidden = false;
    onContinue = () => { endRace(); menu?.toCupSelect(); };
    return;
  }
  const g = gp;
  const place = results.findIndex((r) => r.id === 1) + 1;
  if (place > 4) {
    // Ranked out: a life is lost and the race is run again (no points); no lives left = game over.
    g.lives--;
    playBoards([resultsBoard(results, g.round)], g.lives > 0 ? 'RANKED OUT: você perdeu uma vida. Enter para correr de novo' : 'GAME OVER. Enter para voltar', () => {
      if (g.lives > 0) nextGpRace();
      else { gp = null; endRace(); menu?.toCupSelect(); }
    });
    return;
  }
  const points = rom!.rankPoints();
  const before = new Map(g.points);
  results.forEach((r, i) => g.points.set(r.id, (g.points.get(r.id) ?? 0) + (points[i] ?? 0)));
  const last = g.round >= g.tracks.length - 1;
  playBoards([resultsBoard(results, g.round), ...standingsBoards(g.players.map((p) => p.id), before, g.points, g.round)], '', () => {
    if (!last) { g.round++; nextGpRace(); return; }
    const order = [...g.players].sort((a, b) => (g.points.get(b.id) ?? 0) - (g.points.get(a.id) ?? 0));
    // The gold opens the Special Cup / 150cc (saved in this browser, like the cartridge's battery memory).
    if (order[0]?.id === 1 && lastTrack) winCup(g.cc, lastTrack.cup);
    const top = order.slice(0, 3).map((p) => p.character);
    showCeremony(top, g.players[0].character, () => { gp = null; endRace(); menu?.toCupSelect(); });
  });
}

// ---------- Boards (RESULTS / STANDINGS) ----------

const characterOf = (id: number) => race?.player(id)?.character ?? room?.players.find((p) => p.id === id)?.character ?? 0;

function resultsBoard(results: { id: number; timeMs: number | null }[], round: number): Board {
  return {
    kind: 'results', cc: lastCc, cup: boardCup(), round: round + 1,
    rows: results.map((r, i) => ({ character: characterOf(r.id), timeMs: r.timeMs, place: i + 1, self: r.id === selfOrSolo() })),
  };
}

/** Standings: first with the points just won (+n) in the old order, then sorted. */
function standingsBoards(ids: number[], before: Map<number, number>, after: Map<number, number>, round: number): Board[] {
  const rank = (m: Map<number, number>) => [...ids].sort((a, b) => (m.get(b) ?? 0) - (m.get(a) ?? 0));
  const places = (order: number[], m: Map<number, number>) => order.map((id) => 1 + order.filter((o) => (m.get(o) ?? 0) > (m.get(id) ?? 0)).length);
  const old = rank(before), now = rank(after);
  const board = (order: number[], gained: boolean): Board => {
    const pl = places(order, gained ? before : after);
    return {
      kind: 'standings', cc: lastCc, cup: boardCup(), round: round + 1,
      rows: order.map((id, i) => ({
        character: characterOf(id), place: pl[i], points: after.get(id) ?? 0, self: id === selfOrSolo(),
        gained: gained ? (after.get(id) ?? 0) - (before.get(id) ?? 0) : 0,
      })),
    };
  };
  return [board(old, true), board(now, false)];
}

const selfOrSolo = () => (net ? selfId : 1);
/** Cup shown on the boards (-1 = Battle Mode). */
const boardCup = () => (lastTrack?.battle ? -1 : Math.min(3, lastTrack?.cup ?? 0));

/** Award ceremony after the last race; `done` on Enter. */
function showCeremony(top: number[], self: number, done: () => void) {
  if (!ceremony || !lastTrackData) { done(); return; }
  ceremony.play(top, self, lastCc, Math.min(3, lastTrack?.cup ?? 0), lastDrivers, lastTrackData, done);
}

/** Shows the boards one after the other (Enter / X / Space skips); then `done`. `hint` is shown under them. */
function playBoards(seq: Board[], hint: string, done: (() => void) | null, autoMs = 0) {
  race?.stop();
  $('results').hidden = !hint;
  status('results-hint', hint);
  ($('btn-continue') as HTMLButtonElement).hidden = true;
  boards!.play(seq, lastDrivers, autoMs, () => {
    if (done) done();
  });
}

// ---------- Online ----------

function randomRoom() {
  return Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
}

async function connect(code: string) {
  net?.close();
  net = new NetClient();
  status('menu-status', 'Conectando…');
  try {
    await net.opened;
  } catch (e) {
    status('menu-status', (e as Error).message, true);
    net = null;
    menu?.toTitle();
    return;
  }
  net.on(onServer);
  menu?.showMessage(['ROOM ' + code.toUpperCase(), 'CONNECTING']);
  net.onClose = () => {
    status('menu-status', 'Conexão com o servidor perdida.', true);
    leaveOnline();
  };
  net.send({ t: 'join', room: code, name: '', romCrc: rom!.crc, character: 0 });
}

function leaveOnline() {
  net?.close();
  net = null;
  room = null;
  $('menu-room').hidden = true;
  endRace();
  menu?.toTitle();
  history.replaceState(null, '', location.pathname);
}

function lobbyView(): LobbyView {
  return {
    code: room!.room, isHost: room!.hostId === selfId, selfId,
    players: room!.players.filter((p) => !p.cpu).map((p) => ({
      id: p.id, character: p.character, cursor: p.cursor ?? p.character, ready: p.ready, name: p.name,
    })),
    status: '',
  };
}

function onServer(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome':
      selfId = msg.id;
      status('menu-status', '');
      break;
    case 'error':
      status('menu-status', msg.message, true);
      if (!room) {
        net?.close();
        net = null;
        menu?.toTitle();
        history.replaceState(null, '', location.pathname);
      } else menu?.backToSelect();
      break;
    case 'room': {
      const arriving = !room || room.phase !== 'lobby';
      room = msg;
      history.replaceState(null, '', `?sala=${msg.room}`);
      $('menu-room').hidden = false;
      $('menu-room-code').textContent = msg.room;
      if (msg.phase === 'lobby') {
        if (race) endRace();
        if (arriving) menu?.enterLobby(lobbyView());
        else menu?.updateLobby(lobbyView());
      } else {
        menu?.updateLobby(lobbyView());
        // Arrived between two races of a cup: the next one starts by itself.
        if (!race && msg.phase === 'results') menu?.showMessage(['RACE RUNNING', 'WAIT FOR THE', 'NEXT RACE']);
      }
      break;
    }
    case 'race': {
      // Not on the grid: arrived during this race, so watch it.
      const spectate = !msg.grid.includes(selfId);
      startRace({
        spectate,
        track: rom!.loadTrack(rom!.tracks[msg.track]), cc: msg.cc, players: msg.players, items: true, battle: msg.battle,
        // The CPU host simulates the CPUs for everyone.
        cpus: msg.cpuHost === selfId && !spectate
          ? msg.players.filter((p) => p.cpu).map((p) => ({ id: p.id, slot: msg.grid.indexOf(p.id), skill: 0.55 + Math.random() * 0.45 }))
          : [],
        selfId, slot: msg.grid.indexOf(selfId), startInMs: msg.startInMs, online: true,
      });
      lastTrack = rom!.tracks[msg.track];
      lastCc = msg.cc;
      onlinePoints = msg.round === 0 ? new Map() : onlinePoints;
      const round = msg.rounds > 1 ? `Corrida ${msg.round + 1} de ${msg.rounds}` : '';
      status('results-hint', spectate ? `Você entrou com a corrida em andamento: assistindo. Você corre na próxima.${round ? ' ' + round + '.' : ''}` : round);
      break;
    }
    case 'finished':
      if (msg.id === selfId) status('results-hint', `Você terminou em ${msg.place}º — ${formatTime(msg.timeMs)}. Aguardando os outros…`);
      break;
    case 'results': {
      const isHost = room?.hostId === selfId;
      const after = new Map(msg.standings.map((s) => [s.id, s.points]));
      const seq = [resultsBoard(msg.results, msg.round)];
      if (msg.rounds > 1) seq.push(...standingsBoards(msg.standings.map((s) => s.id), onlinePoints, after, msg.round));
      onlinePoints = after;
      // Between GP races the server starts the next one by itself: the boards just play on a timer.
      const hint = !msg.final ? 'A próxima corrida começa em alguns segundos…' : isHost ? 'Enter: voltar ao lobby' : 'Aguardando o anfitrião…';
      const top = msg.standings.slice(0, 3).map((st) => characterOf(st.id));
      const me = characterOf(selfId);
      const toLobby = isHost ? () => net?.send({ t: 'lobby' }) : () => {};
      // Battle Mode ends on the results (no trophy in the original's battles).
      if (msg.final && lastTrack?.battle) { playBoards(seq, hint, toLobby); break; }
      playBoards(seq, hint, !msg.final ? null : () => showCeremony(msg.rounds > 1 ? top : msg.results.slice(0, 3).map((r) => characterOf(r.id)), me,
        isHost ? () => net?.send({ t: 'lobby' }) : () => {}), msg.final ? 0 : 2900);
      break;
    }
  }
}

$('btn-copy').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?sala=${room?.room}`;
  try { await navigator.clipboard.writeText(url); status('menu-status', 'Link copiado! Mande para os amigos.'); }
  catch { status('menu-status', url); }
});

// ---------- Race ----------

interface StartArgs {
  track: ReturnType<SmkRom['loadTrack']>;
  cc: Cc;
  players: PlayerInfo[];
  cpus: { id: number; slot: number; skill: number }[];
  items: boolean;
  selfId: number;
  slot: number;
  startInMs: number;
  online: boolean;
  spectate?: boolean;
  lives?: number;
  battle?: boolean;
}

function startRace(a: StartArgs) {
  race?.stop();
  boards?.stop();
  ceremony?.stop();
  show('game');
  $('results').hidden = true;
  status('results-hint', '');
  renderer ??= new Renderer($('floor') as HTMLCanvasElement, $('overlay') as HTMLCanvasElement, loadRaceGfx(rom!), $('place-fx') as HTMLCanvasElement);
  const drivers = new Map<number, DriverSprites | null>();
  for (const p of a.players) if (!drivers.has(p.character)) drivers.set(p.character, rom!.loadDriverSprites(p.character, a.track.colors));
  lastDrivers = drivers;
  lastTrackData = a.track;
  race = new Race({
    drivers, cc: a.cc, items: a.items, cpus: a.cpus, spectate: a.spectate,
    track: a.track, slot: Math.max(0, a.slot), selfId: a.selfId, players: a.players, startInMs: a.startInMs,
    net: a.online ? net : null, renderer,
    channel: a.online ? net! : solo!,
    itemGfx: rom!.loadItemGraphics(a.track.colors),
    hud: { note: $('hud-note') },
    lives: a.lives,
    battle: a.battle,
    sound,
  });
  race.start();
}

/** Online GP points before the last race (for the "(+n)" on the standings). */
let onlinePoints = new Map<number, number>();

let onContinue: (() => void) | null = null;
$('btn-continue').addEventListener('click', () => onContinue?.());
addEventListener('keydown', (e) => {
  if (onContinue && !$('results').hidden && ['Enter', 'Space', 'KeyX'].includes(e.code)) {
    const go = onContinue;
    onContinue = null;
    go();
  }
});

function endRace() {
  race?.stop();
  boards?.stop();
  ceremony?.stop();
  $('results').hidden = true;
  race = null;
  solo?.close();
  solo = null;
  show(rom ? 'menu' : 'rom');
}

addEventListener('keydown', (e) => {
  // Esc leaves a solo race (back to the menu).
  if (e.code === 'Escape' && race && !net) { gp = null; endRace(); menu?.toCupSelect(); }
});

// Fullscreen toggle (the button hides itself while in fullscreen; Esc or F11 leaves).
$('btn-fullscreen').addEventListener('click', () => {
  document.documentElement.requestFullscreen?.().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  $('btn-fullscreen').hidden = !!document.fullscreenElement;
});

// ---------- Boot ----------

(async () => {
  const saved = await loadSavedRom();
  if (saved) await loadRom(saved, false);
  else show('rom');
})();

// Dev builds only: lets the browser tests reach into the running race (e.g. jump to the last lap).
if (import.meta.env.DEV) (window as unknown as { __smko: object }).__smko = { get race() { return race; }, get gp() { return gp; }, get sound() { return sound; } };
