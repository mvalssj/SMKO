// Dev check: online lobby and spectators, against a running server.
// Host A and guest B: B's cursor moves reach A live, a confirmed driver can't be taken twice.
// Then a 2-race cup starts; C joins mid-race (spectator, gets the race and watches), and from race 2 C races
// in place of a CPU. Karts "drive" by reporting laps; no physics here (see net-test for that).
// Usage: (server running) npx tsx tools/lobby-test.ts "<rom.sfc>"
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { SmkRom } from '../src/rom/rom';
import { TOTAL_LAPS, type ClientMsg, type ServerMsg } from '../shared/protocol';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const URL_ = process.env.WS_URL ?? 'ws://localhost:3077/ws';
const ROOM = 'L' + Math.floor(Math.random() * 1e5);

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

class Client {
  ws: WebSocket;
  id = 0;
  msgs: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];

  constructor(public label: string) {
    this.ws = new WebSocket(URL_);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      if (m.t === 'welcome') this.id = m.id;
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
    });
  }

  open() { return this.ws.readyState === WebSocket.OPEN ? Promise.resolve() : new Promise<void>((r) => this.ws.once('open', () => r())); }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }

  /** Messages before this index were already matched by an earlier wait. */
  private consumed = 0;

  /** Next message (already received or still to come) matching `pred`. */
  wait<T extends ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 5000): Promise<T> {
    for (let i = this.consumed; i < this.msgs.length; i++) {
      if (pred(this.msgs[i])) { this.consumed = i + 1; return Promise.resolve(this.msgs[i] as T); }
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.label}: timeout`)), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); this.consumed = this.msgs.length; resolve(m as T); } });
    });
  }

  async join() {
    await this.open();
    this.send({ t: 'join', room: ROOM, name: '', romCrc: rom.crc, character: 0 });
    await this.wait((m) => m.t === 'welcome');
  }
}

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type RaceMsg = Extract<ServerMsg, { t: 'race' }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Racers report laps 1..5 and finish (the server wants 15 s of race at least). The CPU host does its CPUs too. */
async function driveToFinish(race: RaceMsg, drivers: Client[]) {
  await sleep(race.startInMs + 15_500);
  const cpuIds = race.players.filter((p) => p.cpu).map((p) => p.id);
  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    for (const c of drivers) {
      c.send({ t: 'state', k: { x: 0, y: 0, a: 0, s: 0, lap, p: lap * 1000 + c.id, f: 0, h: 0, e: 0 } });
      if (c.id === race.cpuHost) c.send({ t: 'cpu', karts: cpuIds.map((id) => ({ id, x: 0, y: 0, a: 0, s: 0, lap, p: lap * 1000, f: 0, h: 0, e: 0 })) });
    }
    await sleep(80);
  }
  for (const c of drivers) {
    c.send({ t: 'finish', timeMs: 16_000 });
    if (c.id === race.cpuHost) for (const id of cpuIds) c.send({ t: 'finish', timeMs: 17_000, cpu: id });
  }
}

const A = new Client('A'), B = new Client('B');
await A.join();
await B.join();

// --- Lobby ---
let room = await A.wait<RoomMsg>((m) => m.t === 'room' && m.players.length === 2);
check(room.players.length === 2, 'host sees the guest who joined');
check(room.players.every((p) => !p.ready), 'nobody has confirmed a driver yet');

B.send({ t: 'character', character: 3, ready: false });
room = await A.wait<RoomMsg>((m) => m.t === 'room' && m.players.find((p) => p.id === B.id)?.cursor === 3);
check(!room.players.find((p) => p.id === B.id)!.ready, "host sees the guest's cursor move (on Peach, not confirmed)");

B.send({ t: 'character', character: 3, ready: true });
room = await A.wait<RoomMsg>((m) => m.t === 'room' && !!m.players.find((p) => p.id === B.id)?.ready);
check(room.players.find((p) => p.id === B.id)!.character === 3, 'host sees the guest confirm Peach');

A.send({ t: 'character', character: 3, ready: true });
const err = await A.wait((m) => m.t === 'error');
check(err.t === 'error', 'a driver confirmed by someone else is refused');
A.send({ t: 'character', character: 0, ready: true });
await A.wait<RoomMsg>((m) => m.t === 'room' && !!m.players.find((p) => p.id === A.id)?.ready);

// --- Cup of 2 races; C arrives during race 1 ---
A.send({ t: 'start', cpus: true, cc: 100, tracks: [0, 1] });
const race1 = await A.wait<RaceMsg>((m) => m.t === 'race');
check(race1.players.length === 8 && race1.grid.length === 8, 'race 1: 2 players + 6 CPUs');
await sleep(1500);
A.send({ t: 'state', k: { x: 100, y: 100, a: 0, s: 0, lap: 0, p: 0, f: 0, h: 0, e: 0 } });

const C = new Client('C');
await C.join();
const cRoom = await C.wait<RoomMsg>((m) => m.t === 'room');
check(cRoom.phase !== 'lobby' && !!cRoom.players.find((p) => p.id === C.id)?.spectator, 'joining mid-race: in the room as a spectator');
const cRace = await C.wait<RaceMsg>((m) => m.t === 'race');
check(!cRace.grid.includes(C.id) && cRace.track === race1.track, 'spectator gets the running race, without a kart');
check(cRace.startInMs < race1.startInMs, 'spectator joins the race clock where it is');
const states = await C.wait<Extract<ServerMsg, { t: 'states' }>>((m) => m.t === 'states' && m.karts.length > 0);
check(states.karts.length > 0, 'spectator receives the karts');

await driveToFinish(race1, [A, B]);
const res1 = await C.wait<Extract<ServerMsg, { t: 'results' }>>((m) => m.t === 'results', 40_000);
check(!res1.results.some((r) => r.id === C.id) && res1.results.length === 8, 'spectator is not in the results');

// --- Race 2: C races instead of a CPU ---
const race2 = await C.wait<RaceMsg>((m) => m.t === 'race', 15_000);
check(race2.grid.includes(C.id) && race2.grid.length === 8, 'race 2: the spectator races (in place of a CPU)');
const cInfo = race2.players.find((p) => p.id === C.id)!;
check(!race2.players.some((p) => p.id !== C.id && p.character === cInfo.character), `spectator drives a free driver (${cInfo.name})`);

await driveToFinish(race2, [A, B, C]);
const res2 = await A.wait<Extract<ServerMsg, { t: 'results' }>>((m) => m.t === 'results' && m.final, 40_000);
check(res2.standings.some((s) => s.id === C.id), 'final standings include the new player');

// --- Back to the lobby: everyone picks again ---
A.send({ t: 'lobby' });
room = await C.wait<RoomMsg>((m) => m.t === 'room' && m.phase === 'lobby');
check(room.players.length === 3 && room.players.every((p) => !p.ready && !p.spectator && !p.cpu), 'lobby: 3 players, no CPUs, all choosing again');

for (const c of [A, B, C]) c.ws.close();
console.log(failures ? `${failures} falha(s)` : 'tudo certo');
process.exit(failures ? 1 : 0);
