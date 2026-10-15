// Administrator panel against a running server started with a password, e.g.
//   SMKO_ADMIN_PASSWORD=teste123 SMKO_DATA_DIR=.scratch/admin-data SMKO_TRUST_PROXY=1 npx tsx server/index.ts
// The test's players come from made-up addresses (203.0.113.x, kept for examples), sent as X-Forwarded-For:
// banning one of them must never ban this computer, where real players may be on the same server. Without
// SMKO_TRUST_PROXY=1 the server sees this computer's address instead, so the banning part is skipped.
// Login, the live views (rooms, players, Battle Royale), warnings, kicking, banning, modes turned off,
// notices, settings and the statistics.
// Usage: npx tsx tools/admin-test.ts "Super Mario Kart (USA).sfc" [password] [http://localhost:3077]
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { SmkRom } from '../src/rom/rom';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const PASSWORD = process.argv[3] ?? 'teste123';
const BASE = process.argv[4] ?? 'http://localhost:3077';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
let failed = false;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FALHA'} ${msg}`); if (!ok) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function api(path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}/admin/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, ...(body ? { 'content-type': 'application/json', 'x-smko-admin': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** Made-up addresses (RFC 5737) for the test's players. */
const ADDR_A = '203.0.113.10', ADDR_B = '203.0.113.11', ADDR_E = '203.0.113.12';

class Client {
  ws: WebSocket;
  got: ServerMsg[] = [];
  open: Promise<void>;
  closed = false;
  constructor(address: string) {
    this.ws = new WebSocket(WS_URL, { headers: { 'x-forwarded-for': address } });
    this.open = new Promise((r) => this.ws.on('open', () => r()));
    this.ws.on('message', (d) => this.got.push(JSON.parse(String(d))));
    this.ws.on('close', () => { this.closed = true; });
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  async wait<T extends ServerMsg['t']>(t: T, ms = 3000): Promise<Extract<ServerMsg, { t: T }> | null> {
    const t0 = Date.now();
    for (;;) {
      const i = this.got.findIndex((m) => m.t === t);
      if (i >= 0) return this.got.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      if (Date.now() - t0 > ms) return null;
      await sleep(20);
    }
  }
  async waitClosed(ms = 3000) {
    const t0 = Date.now();
    while (!this.closed && Date.now() - t0 < ms) await sleep(20);
    return this.closed;
  }
}

// 1. Password.
check((await api('overview')).status === 401, 'sem senha: recusado');
const noHeader = await fetch(`${BASE}/admin/api/login`, { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
check(noHeader.status === 403, 'pedido sem o cabeçalho do painel: recusado');
check((await api('login', { password: 'errada' })).status === 401, 'senha errada: recusado');
check((await api('login', { password: PASSWORD })).status === 200 && cookie.startsWith('smko_admin='), 'senha certa: entra');
const page = await fetch(`${BASE}/admin`);
check(page.status === 200 && (await page.text()).includes('PAINEL'), 'página do painel servida');

// 2. A room with two people.
const code = 'ADM' + Math.floor(Math.random() * 900 + 100);
const a = new Client(ADDR_A), b = new Client(ADDR_B);
await Promise.all([a.open, b.open]);
a.send({ t: 'join', room: code, name: '', romCrc: rom.crc, character: 0 });
const wa = await a.wait('welcome');
b.send({ t: 'join', room: code, name: '', romCrc: rom.crc, character: 1 });
const wb = await b.wait('welcome');
await sleep(200);
const ov = (await api('overview')).data;
check(ov.players >= 2 && ov.rooms.lobby >= 1 && ov.people.lobby >= 2, `visão geral: ${ov.players} conectados, ${ov.rooms.lobby} sala(s) no lobby`);
check(typeof ov.health.cpu === 'number' && ov.health.rss > 0 && ov.history.length > 0, `saúde: CPU ${ov.health.cpu}%, ${ov.health.rss} MB`);
const rooms = (await api('rooms')).data;
const room = rooms.rooms.find((r: any) => r.code === code);
check(room?.people === 2 && room.mode === 'lobby', 'sala aparece com 2 pessoas');
const players = (await api('players')).data;
const pa = players.find((p: any) => p.id === wa?.id);
check(!!pa && pa.where === `Sala ${code}` && /x\.x|…|\?/.test(pa.masked) && pa.hash.length === 12, `jogador: ${pa?.where}, IP mascarado ${pa?.masked}`);
/** The server sees the made-up addresses (it trusts X-Forwarded-For): banning is safe to try. */
const fakeAddresses = pa?.masked === '203.0.x.x';

// 3. Modes turned off.
const before = (await api('settings')).data.settings;
await api('settings', { settings: { ...before, modes: { ...before.modes, vs: false } } });
a.send({ t: 'start', tracks: [0] });
const err = await a.wait('error', 2000);
check(!!err && err.message.includes('desativado'), 'modo desligado: a corrida não começa');
await api('settings', { settings: before });

// 4. A race: a move no kart could make is a warning; a person who isn't host starting is another.
a.send({ t: 'start', tracks: [0] });
await a.wait('race');
await b.wait('race');
b.send({ t: 'state', k: { x: 100, y: 100, a: 0, s: 0, lap: 0, p: 0, f: 0, h: 0, e: 0 } });
await sleep(100);
b.send({ t: 'state', k: { x: 900, y: 900, a: 0, s: 0, lap: 0, p: 0, f: 0, h: 0, e: 0 } });
await sleep(300);
const pb = (await api('players')).data.find((p: any) => p.id === wb?.id);
check(pb?.warnings === 1, `velocidade impossível vira aviso (${pb?.warnings})`);
const feed = (await api('moderation')).data.feed;
check(feed.some((w: any) => w.id === wb?.id && w.kind === 'speed'), 'aviso aparece na moderação');
const live = (await api(`live?room=${code}`)).data;
check(Array.isArray(live.karts) && live.karts.some((k: any) => k.id === wa?.id || k.id === wb?.id), `mapa ao vivo da sala (${live.karts?.length} karts)`);

// 5. Notice to everyone.
await api('notice', { message: 'Teste de aviso' });
const na = await a.wait('notice'), nb = await b.wait('notice');
check(na?.message === 'Teste de aviso' && nb?.message === 'Teste de aviso', 'aviso chega a todos');

// 6. Kick.
await api('kick', { id: wb?.id, reason: 'teste' });
const kn = await b.wait('notice');
check((await b.waitClosed()) && !!kn?.message.includes('teste'), 'expulsar: recebe o motivo e é desconectado');

// 7. Ban (by address: everyone from that address), then unban. Only with made-up addresses: banning this
// computer's would also throw out anyone playing here.
if (fakeAddresses) {
  await api('ban', { id: wa?.id, reason: 'teste de banimento', hours: 1 });
  check(await a.waitClosed(), 'banir: desconectado');
  const c = new Client(ADDR_A);
  await c.open.catch(() => {});
  const banned = await c.wait('error', 2000);
  check(!!banned?.message.includes('banido') && (await c.waitClosed()), 'banido não consegue voltar');
  const other = new Client(ADDR_E);
  await other.open;
  other.send({ t: 'join', room: code + 'C', name: '', romCrc: rom.crc, character: 0 });
  check(!!(await other.wait('welcome')), 'outro endereço continua entrando');
  other.ws.close();
  const mod = (await api('moderation')).data;
  const ban = mod.bans.find((x: any) => x.active);
  check(!!ban && mod.log.some((l: any) => l.what.includes('Baniu')), 'banimento listado e registrado');
  await api('unban', { hash: ban?.hash });
  const d = new Client(ADDR_A);
  await d.open;
  d.send({ t: 'join', room: code + 'B', name: '', romCrc: rom.crc, character: 0 });
  check(!!(await d.wait('welcome')), 'banimento removido: volta a entrar');
  d.ws.close();
} else {
  console.log('PULADO banimento: o servidor não aceita os endereços de teste (inicie-o com SMKO_TRUST_PROXY=1)');
  a.ws.close();
}

// 8. Battle Royale: the match in the panel, its live map, ending it. (If someone is already playing one on
// this server, the test's player takes a bot's place in it: then it is looked at, never ended.)
const e = new Client(ADDR_E);
await e.open;
e.send({ t: 'royaleJoin', romCrc: rom.crc, character: 2 });
const rs = await e.wait('royaleStart', 4000);
check(!!rs && rs.zoneScale === before.zoneScale, `Battle Royale começa (zona ×${rs?.zoneScale})`);
await sleep(200);
const m = (await api('rooms')).data.matches.find((x: any) => x.people.some((p: any) => p.id === rs?.selfId));
const ownMatch = m?.people.length === 1;
if (ownMatch) check(!!m && m.alive === 100 && m.bots === 99 && m.host === rs?.selfId, `partida no painel: ${m?.alive} vivos, ${m?.bots} bots`);
else check(!!m && m.alive > 1, `partida (de outras pessoas) no painel: ${m?.alive} vivos, ${m?.bots} bots`);
e.send({ t: 'telemetry', fps: 57.5, mobile: true, gamepad: false, wide: true, falls: [['Rainbow Road', 3], ['Nada', 1]] });
e.send({ t: 'state', k: { x: 500, y: 500, a: 0, s: 0, lap: 0, p: 0, f: 0, h: 0, e: 0 } });
await sleep(300);
const lm = (await api(`live?match=${m?.id}`)).data;
check(lm?.grid?.names?.length === 24 && lm.zone?.r > 0 && lm.karts.some((k: any) => !k.cpu), 'mapa ao vivo do Battle Royale (pistas, zona, pessoas)');
const pe = (await api('players')).data.find((p: any) => p.id === rs?.selfId);
check(pe?.fps === 57.5 && pe.mobile === true && pe.botHost === ownMatch, 'FPS e aparelho do navegador');
if (ownMatch) {
  await api('end-match', { id: m?.id });
  check(await e.waitClosed(), 'encerrar partida: desconectado');
} else {
  console.log('PULADO encerrar partida: há outras pessoas jogando nela');
  e.ws.close();
}

// 9. Statistics (the race above was recorded when it ended? it didn't: picks and telemetry were).
const st = (await api('stats?days=7')).data;
check(st.courses.some(([n]: [string]) => n === 'Mario Circuit 1') && st.drivers.length > 0, 'estatísticas: pista e pilotos escolhidos');
check(st.falls.some(([n, k]: [string, number]) => n === 'Rainbow Road' && k >= 3) && !st.falls.some(([n]: [string]) => n === 'Nada'), 'estatísticas: quedas dos bots (só pistas que existem)');
check(st.devices.total >= 1 && st.fps.mobile !== null, 'estatísticas: aparelhos e FPS');
check(st.perDay.length === 7 && st.peaks.length === 7, 'estatísticas: 7 dias');

// 10. Settings are cleaned; logout.
const bad = (await api('settings', { settings: { ...before, maxRoomPlayers: 99, zoneScale: 50 } })).data.settings;
check(bad.maxRoomPlayers === 8 && bad.zoneScale === 3, 'configurações fora dos limites são corrigidas');
await api('settings', { settings: before });
await api('logout', {});
check((await api('overview')).status === 401, 'sair: sessão encerrada');

console.log(failed ? 'houve falhas' : 'tudo certo');
process.exit(failed ? 1 : 0);
