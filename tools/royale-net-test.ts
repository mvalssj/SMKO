// Online Battle Royale against a running server (npm start, or npx tsx server/index.ts):
// the first player gets a new match with 99 bots (and runs them), a second takes a bot's place, the bots
// move to the second when the first leaves, balloons and going out, and karts far away sent less often.
// Usage: npx tsx tools/royale-net-test.ts "Super Mario Kart (USA).sfc" [ws://localhost:3077/ws]
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { SmkRom } from '../src/rom/rom';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const URL = process.argv[3] ?? 'ws://localhost:3077/ws';
let failed = false;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FALHA'} ${msg}`); if (!ok) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  ws: WebSocket;
  got: ServerMsg[] = [];
  open: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.open = new Promise((r) => this.ws.on('open', () => r()));
    this.ws.on('message', (d) => this.got.push(JSON.parse(String(d))));
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  async wait<T extends ServerMsg['t']>(t: T, ms = 3000): Promise<Extract<ServerMsg, { t: T }>> {
    const t0 = Date.now();
    for (;;) {
      const i = this.got.findIndex((m) => m.t === t);
      if (i >= 0) return this.got.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      if (Date.now() - t0 > ms) throw new Error(`sem ${t}`);
      await sleep(20);
    }
  }
}

const a = new Client();
await a.open;
a.send({ t: 'royaleJoin', romCrc: rom.crc, character: 0 });
const sa = await a.wait('royaleStart');
check(sa.players.length === 100 && sa.players.filter((p) => p.cpu).length === 99, `nova partida: 100 pilotos, 99 bots (${sa.players.length})`);
check(sa.host === sa.selfId, 'quem cria a partida roda os bots');
check(sa.startInMs > 3000, `contagem antes da largada (${sa.startInMs} ms)`);

// The host reports its bots spread over the world; its own kart in one corner.
const bots = sa.players.filter((p) => p.cpu);
const spread = () => a.send({ t: 'cpu', karts: bots.map((b, i) => ({ id: b.id, x: 200 + (i % 10) * 700, y: 200 + Math.floor(i / 10) * 450, a: 0, s: 0, lap: 0, p: 0, f: 0, h: 0, e: 0 })) });
spread();
a.send({ t: 'state', k: { x: 210, y: 210, a: 0, s: 0, lap: 0, p: 0, f: 0, h: 0, e: 0 } });
await sleep(400);

const b = new Client();
await b.open;
b.send({ t: 'royaleJoin', romCrc: rom.crc, character: 3 });
const sb = await b.wait('royaleStart');
const swap = await a.wait('royaleSwap');
check(sb.seed === sa.seed, 'a segunda pessoa entra na mesma partida');
check(!!sb.at && swap.player.id === sb.selfId && swap.player.character === 3, 'ela assume o lugar de um bot (posição dele, com o piloto escolhido)');
check(sb.host === sa.selfId, 'os bots continuam no navegador da primeira');
check(sb.players.filter((p) => p.cpu).length === 98, 'agora 98 bots');

// B near its bot's place; far karts come less often.
b.send({ t: 'state', k: { x: sb.at!.x, y: sb.at!.y, a: 0, s: 0, lap: 0, p: 0, f: 0, h: 0, e: 0 } });
b.got = [];
for (let i = 0; i < 10; i++) { spread(); await sleep(50); }
await sleep(500);
const sizes = b.got.filter((m): m is Extract<ServerMsg, { t: 'states' }> => m.t === 'states').map((m) => m.karts.length);
check(sizes.length >= 5 && Math.min(...sizes) < Math.max(...sizes) && Math.max(...sizes) >= 90, `karts distantes menos vezes (por mensagem: ${Math.min(...sizes)}..${Math.max(...sizes)})`);

// Balloons: B pops three times after the start and is out.
await sleep(Math.max(0, sa.startInMs - 1200));
for (let i = 0; i < 3; i++) b.send({ t: 'pop' });
const out = await a.wait('royaleOut', 3000).catch(() => null);
check(!!out && out.id === sb.selfId && out.place === 100, `três balões furados: fora (${out ? `${out.place}º` : 'nada'})`);

// A leaves: B runs the bots.
a.ws.close();
const host = await b.wait('cpuHost', 3000).catch(() => null);
check(host?.id === sb.selfId, 'quem fica passa a rodar os bots');
b.ws.close();
console.log(failed ? 'houve falhas' : 'tudo certo');
process.exit(failed ? 1 : 0);
