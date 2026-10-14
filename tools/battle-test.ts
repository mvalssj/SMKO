// Dev check: online Battle Mode, against a running server.
// Three players battle on Battle Course 1: balloons pop (self-reported here), the last one with balloons wins;
// broken blocks are sent to a player who joins mid-battle.
// Usage: (server running) npx tsx tools/battle-test.ts "<rom.sfc>"
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { SmkRom } from '../src/rom/rom';
import { type ClientMsg, type ServerMsg } from '../shared/protocol';

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

type RaceMsg = Extract<ServerMsg, { t: 'race' }>;
type ResultsMsg = Extract<ServerMsg, { t: 'results' }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const [a, b, c] = [new Client('A'), new Client('B'), new Client('C')];
await a.join(); await b.join(); await c.join();
const battleTrack = rom.tracks.findIndex((t) => t.battle);
a.send({ t: 'start', tracks: [battleTrack], battle: true, cpus: true });
const race = await a.wait<RaceMsg>((m) => m.t === 'race');
check(race.battle === true, 'race is a battle');
check(race.players.every((p) => !p.cpu) && race.players.length === 3, 'no CPUs in a battle, 3 karts');
await sleep(race.startInMs + 300);

// B breaks a block; then loses all three balloons.
b.send({ t: 'break', tiles: [1234] });
for (let i = 0; i < 3; i++) { b.send({ t: 'pop' }); await sleep(50); }
const out = await a.wait<Extract<ServerMsg, { t: 'balloons' }>>((m) => m.t === 'balloons' && m.id === b.id && m.n === 0);
check(out.n === 0, 'B is out after 3 pops (everyone hears it)');

// D arrives mid-battle: gets the race, the broken block and everyone's balloons.
const d = new Client('D');
await d.join();
await d.wait((m) => m.t === 'race');
const brk = await d.wait<Extract<ServerMsg, { t: 'break' }>>((m) => m.t === 'break');
check(brk.tiles.includes(1234), 'late arrival gets the broken blocks');
const bal = await d.wait<Extract<ServerMsg, { t: 'balloons' }>>((m) => m.t === 'balloons' && m.id === b.id);
check(bal.n === 0, 'late arrival sees B out');

// C pops twice (still in), A once; then C pops once more: A wins.
c.send({ t: 'pop' }); c.send({ t: 'pop' }); a.send({ t: 'pop' });
await sleep(200);
c.send({ t: 'pop' });
const res = await a.wait<ResultsMsg>((m) => m.t === 'results', 5000);
check(res.final && res.results[0].id === a.id, 'A wins (last one with balloons)');
check(res.results[1].id === c.id && res.results[2].id === b.id, 'then the last ones out, in reverse order');

for (const x of [a, b, c, d]) x.ws.close();
console.log(failures ? `${failures} falha(s)` : 'tudo certo');
process.exit(failures ? 1 : 0);
