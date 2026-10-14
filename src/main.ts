import {
  CHARACTER_NAMES, CPU_ID_BASE, type Cc, type PlayerInfo, type ResultEntry, type ServerMsg, type Standing,
} from '../shared/protocol';
import { SmkRom, type DriverSprites, type TrackInfo } from './rom/rom';
import { NetClient } from './net/client';
import { LocalChannel } from './net/local';
import { Race, formatTime } from './game/race';
import { Renderer } from './game/renderer';
import { MenuApp, type LobbyView } from './menu/app';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let rom: SmkRom | null = null;
let menu: MenuApp | null = null;
let renderer: Renderer | null = null;
let race: Race | null = null;
let solo: LocalChannel | null = null;
let net: NetClient | null = null;
let selfId = 0;
let room: Extract<ServerMsg, { t: 'room' }> | null = null;

/** Solo Grand Prix in progress: the 5 races of a cup against the 7 CPUs. */
let gp: { tracks: TrackInfo[]; cc: Cc; players: PlayerInfo[]; round: number; points: Map<number, number> } | null = null;

// ---------- Screens ----------

function show(screen: 'rom' | 'menu' | 'game') {
  for (const s of ['rom', 'menu', 'game']) $(`screen-${s}`).hidden = s !== screen;
  if (screen === 'menu') menu?.show(); else menu?.hide();
}

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
      onlineStart: ({ cc, tracks }) => net?.send({
        t: 'start', cc, cpus: true,
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
  gp = { tracks: choice.tracks, cc: choice.cc, players: [me, ...cpus], round: 0, points: new Map() };
  nextGpRace();
}

function nextGpRace() {
  const g = gp!;
  // First race: you start last, as in the original. Then the grid follows the points.
  const ids = g.players.map((p) => p.id);
  if (g.round === 0) ids.push(ids.shift()!);
  else ids.sort((a, b) => (g.points.get(b) ?? 0) - (g.points.get(a) ?? 0));
  const cpus = g.players.filter((p) => p.cpu);
  runSoloRace(g.tracks[g.round], g.cc, g.players, cpus.map((c) => ({ id: c.id, slot: ids.indexOf(c.id), skill: 0.55 + Math.random() * 0.45 })), true, ids.indexOf(1));
}

function runSoloRace(track: TrackInfo, cc: Cc, players: PlayerInfo[], cpus: { id: number; slot: number; skill: number }[], items: boolean, slot = 0) {
  solo?.close();
  solo = new LocalChannel(1, rom!.itemOdds(track), 3500, cpus.map((c) => c.id));
  startRace({ track: rom!.loadTrack(track), cc, players, cpus, items, selfId: 1, slot, startInMs: 3500, online: false });
  const check = () => {
    if (!race || net) return;
    if (!race.finished) { setTimeout(check, 250); return; }
    finishSoloRace(race.results());
  };
  check();
}

function finishSoloRace(results: ResultEntry[] | { id: number; timeMs: number | null }[]) {
  const nameOf = (id: number) => race?.player(id)?.name ?? '?';
  const rows = results.map((r) => ({ id: r.id, name: nameOf(r.id), timeMs: r.timeMs }));
  if (!gp) {
    showResults('Time Trial', rows, null, 'Voltar', () => { endRace(); menu?.toCupSelect(); });
    return;
  }
  const g = gp;
  const points = rom!.rankPoints();
  rows.forEach((r, place) => g.points.set(r.id, (g.points.get(r.id) ?? 0) + (points[place] ?? 0)));
  const standings = g.players.map((p) => ({ id: p.id, name: p.name, points: g.points.get(p.id) ?? 0 })).sort((a, b) => b.points - a.points);
  const last = g.round >= g.tracks.length - 1;
  showResults(`Corrida ${g.round + 1}/${g.tracks.length}`, rows, standings, last ? 'Fim do Grand Prix' : 'Próxima corrida', () => {
    if (last) { gp = null; endRace(); menu?.toCupSelect(); }
    else { g.round++; nextGpRace(); }
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
        track: rom!.loadTrack(rom!.tracks[msg.track]), cc: msg.cc, players: msg.players, items: true,
        // The CPU host simulates the CPUs for everyone.
        cpus: msg.cpuHost === selfId && !spectate
          ? msg.players.filter((p) => p.cpu).map((p) => ({ id: p.id, slot: msg.grid.indexOf(p.id), skill: 0.55 + Math.random() * 0.45 }))
          : [],
        selfId, slot: msg.grid.indexOf(selfId), startInMs: msg.startInMs, online: true,
      });
      const round = msg.rounds > 1 ? `Corrida ${msg.round + 1} de ${msg.rounds}` : '';
      status('results-hint', spectate ? `Você entrou com a corrida em andamento: assistindo. Você corre na próxima.${round ? ' ' + round + '.' : ''}` : round);
      break;
    }
    case 'finished':
      if (msg.id === selfId) status('results-hint', `Você terminou em ${msg.place}º — ${formatTime(msg.timeMs)}. Aguardando os outros…`);
      break;
    case 'results': {
      const isHost = room?.hostId === selfId;
      const title = msg.rounds > 1 ? `Corrida ${msg.round + 1}/${msg.rounds}` : 'Resultado';
      if (!msg.final) showResults(title, msg.results, msg.standings, null, null, 'A próxima corrida começa em alguns segundos…');
      else showResults(title, msg.results, msg.rounds > 1 ? msg.standings : null, isHost ? 'Voltar ao lobby' : null,
        isHost ? () => net?.send({ t: 'lobby' }) : null, isHost ? '' : 'Aguardando o anfitrião…');
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
}

function startRace(a: StartArgs) {
  race?.stop();
  show('game');
  $('results').hidden = true;
  status('results-hint', '');
  renderer ??= new Renderer($('floor') as HTMLCanvasElement, $('overlay') as HTMLCanvasElement);
  const drivers = new Map<number, DriverSprites | null>();
  for (const p of a.players) if (!drivers.has(p.character)) drivers.set(p.character, rom!.loadDriverSprites(p.character, a.track.colors));
  race = new Race({
    drivers, cc: a.cc, items: a.items, cpus: a.cpus, spectate: a.spectate,
    track: a.track, slot: Math.max(0, a.slot), selfId: a.selfId, players: a.players, startInMs: a.startInMs,
    net: a.online ? net : null, renderer,
    channel: a.online ? net! : solo!,
    itemGfx: rom!.loadItemGraphics(a.track.colors),
    hud: {
      lap: $('hud-lap'), place: $('hud-place'), time: $('hud-time'), countdown: $('countdown'),
      minimap: $('minimap') as HTMLCanvasElement, item: $('hud-item') as HTMLCanvasElement, coins: $('hud-coins'),
    },
  });
  race.start();
}

let onContinue: (() => void) | null = null;
$('btn-continue').addEventListener('click', () => onContinue?.());

function showResults(
  title: string, rows: { id: number; name: string; timeMs: number | null }[], standings: Standing[] | null,
  button: string | null, action: (() => void) | null, hint = '',
) {
  $('results-title').textContent = title;
  fillList($('results-list'), rows.map((r) => `${r.name} — ${r.timeMs === null ? 'não terminou' : formatTime(r.timeMs)}`));
  $('standings-title').hidden = !standings;
  fillList($('standings-list'), standings ? standings.map((s) => `${s.name} — ${s.points} pts`) : []);
  const btn = $('btn-continue') as HTMLButtonElement;
  btn.hidden = !button;
  btn.textContent = button ?? '';
  onContinue = action;
  status('results-hint', hint);
  $('results').hidden = false;
}

function fillList(ol: HTMLElement, lines: string[]) {
  ol.innerHTML = '';
  for (const l of lines) {
    const li = document.createElement('li');
    li.textContent = l;
    ol.append(li);
  }
}

function endRace() {
  race?.stop();
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
