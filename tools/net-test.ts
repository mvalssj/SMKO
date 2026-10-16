// Dev check: N bot clients join one room over WebSocket and race to the finish.
// Usage: (server running) npx tsx tools/net-test.ts "<rom.sfc>" [players=8] [track=0] [cpus=0|1]
// With cpus=1 the host fills the empty slots with CPUs and simulates them, like the browser does.
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { Genre, SmkRom } from '../src/rom/rom';
import { createKart, raceGeometry, stepKart, kartHeight, spinOut, tileCluster, type Kart } from '../src/game/physics';
import { CpuDriver } from '../src/game/cpu';
import { advanceEntity, createEntity, ITEM_HIT_DISTANCE, OWNER_GRACE_FRAMES, type Entity } from '../src/game/items';
import type { ServerMsg } from '../shared/protocol';
import { Bot } from './bot';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const N = Number(process.argv[3] ?? 8);
const TRACK = Number(process.argv[4] ?? 0);
const CPUS = process.argv[5] === '1';
/** Races in the event (2+ = Grand Prix with points). */
const ROUNDS = Number(process.argv[6] ?? 1);
const URL_ = process.env.WS_URL ?? 'ws://localhost:3077/ws';
const room = 'T' + Math.floor(Math.random() * 1e6);
const stats = { cpus: 0, results: 0, boxes: 0, items: new Map<string, number>(), spawns: 0, hits: 0, effects: 0 };

function client(n: number): Promise<{ name: string; results?: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_);
    const send = (m: object) => ws.send(JSON.stringify(m));
    let id = 0, seenOthers = 0, broken = 0;
    let item: string | null = null, heldAt = 0, boxCooldown = 0, stoppedAt = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const entities = new Map<number, Entity>();
    ws.on('error', reject);
    ws.on('open', () => send({ t: 'join', room, name: `bot${n}`, romCrc: rom.crc, character: n % 8 }));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      if (m.t === 'welcome') id = m.id;
      if (m.t === 'error') reject(new Error(m.message));
      if (m.t === 'room' && m.phase === 'lobby' && m.hostId === id && m.players.length === N) {
        send({ t: 'track', track: TRACK });
        send({ t: 'start', cpus: CPUS, cc: 150, tracks: Array.from({ length: ROUNDS }, (_, i) => (TRACK + i) % 20) });
      }
      if (m.t === 'states') seenOthers = Math.max(seenOthers, m.karts.filter((k) => k.id !== id).length);
      if (m.t === 'break') broken += m.tiles.length;
      if (m.t === 'item') { item = m.item; heldAt = Date.now(); stoppedAt = 0; if (m.item && m.roll) stats.items.set(m.item, (stats.items.get(m.item) ?? 0) + 1); }
      if (m.t === 'spawn') { entities.set(m.e.id, createEntity(m.e)); if (n === 0) stats.spawns++; }
      if (m.t === 'despawn') entities.delete(m.id);
      if (m.t === 'effect' && n === 0) stats.effects++;
      if (m.t === 'race') {
        const track = rom.loadTrack(rom.tracks[m.track]);
        const geo = raceGeometry(track);
        const k = createKart(track, m.grid.indexOf(id));
        const bot = new Bot(track, geo, k);
        // The CPU host simulates the CPUs too.
        const cpus: { id: number; k: Kart; d: CpuDriver; done: boolean }[] = m.cpuHost === id
          ? m.players.filter((p) => p.cpu).map((p) => { const ck = createKart(track, m.grid.indexOf(p.id)); return { id: p.id, k: ck, d: new CpuDriver(track, ck, 0.8), done: false }; })
          : [];
        if (cpus.length) stats.cpus = cpus.length;
        const t0 = Date.now() + m.startInMs;
        let frame = 0, done = false;
        // Simulate 4x faster than real time to keep the test short; the server only checks a minimum race time.
        if (timer) clearInterval(timer);
        entities.clear();
        timer = setInterval(() => {
          for (let i = 0; i < 4; i++) {
            if (Date.now() < t0) break;
            stepKart(k, bot.input(k), track, geo, [], frame);
            frame++;
            // Items: grab boxes, use what we get after a second, get hit by shells/bananas.
            if (boxCooldown > 0) boxCooldown--;
            const tx = Math.floor(k.x / 8), ty = Math.floor(k.y / 8);
            if (!item && boxCooldown === 0 && track.genres[ty * 128 + tx] === Genre.ItemBlock) {
              send({ t: 'box', tiles: tileCluster(track, tx, ty, Genre.ItemBlock, 2) }); boxCooldown = 30; stats.boxes++;
            }
            // The roulette: stop it after half a second (as a player would), use the item once it is ready.
            if (item && !stoppedAt && Date.now() - heldAt > 500) { send({ t: 'stopRoll' }); stoppedAt = Date.now(); }
            if (item && stoppedAt && Date.now() - stoppedAt > 1400) { send({ t: 'use', x: k.x, y: k.y, a: k.angle, back: false }); item = null; }
            const serverFrame = Math.floor((Date.now() - t0) / (1000 / 60));
            for (const e of entities.values()) {
              advanceEntity(e, track, serverFrame, () => null);
              if (e.dead) { entities.delete(e.id); continue; }
              if (e.owner === id && serverFrame - e.frame < OWNER_GRACE_FRAMES) continue;
              if (Math.hypot(e.x - k.x, e.y - k.y) < ITEM_HIT_DISTANCE) { send({ t: 'hit', entity: e.id }); entities.delete(e.id); spinOut(k); stats.hits++; }
            }
            for (const c of cpus) {
              stepKart(c.k, c.d.input(c.k), track, geo, [], frame);
              if (c.k.lap > m.laps && !c.done) { c.done = true; send({ t: 'finish', timeMs: Math.round((frame * 1000) / 60), cpu: c.id }); }
            }
            if (cpus.length && frame % 3 === 0) send({ t: 'cpu', karts: cpus.map((c) => ({ id: c.id, x: c.k.x, y: c.k.y, a: c.k.angle, s: c.k.speed, lap: c.k.lap, p: c.k.progress, f: c.k.fall, h: 0, e: 0 })) });
            if (frame % 3 === 0) send({ t: 'state', k: { x: k.x, y: k.y, a: k.angle, s: k.speed, lap: k.lap, p: k.progress, f: k.fall, h: kartHeight(k), e: 0 } });
            if (k.lap > m.laps && !done) {
              done = true;
              send({ t: 'finish', timeMs: Math.round((frame * 1000) / 60) });
            }
          }
        }, 1000 / 60);
        ws.on('close', () => timer && clearInterval(timer));
      }
      if (m.t === 'results') {
        stats.results = m.results.length;
        if (n === 0) console.log(`Corrida ${m.round + 1}/${m.rounds}: ${m.results.map((r, i) => `${i + 1}. ${r.name}`).join(' ')} | pontos: ${m.standings.map((p) => `${p.name}=${p.points}`).join(' ')}`);
        if (!m.final) return;
        if (n === 0) console.log('Resultado:', m.results.map((r, i) => `${i + 1}. ${r.name} ${r.timeMs === null ? 'DNF' : (r.timeMs / 1000).toFixed(1) + 's'}`).join(' | '));
        console.log(`bot${n}: via ${seenOthers}/${(CPUS ? 8 : N) - 1} oponentes nos states`);
        ws.close();
        resolve({ name: `bot${n}`, results: m.results });
      }
    });
  });
}

const t = Date.now();
Promise.all(Array.from({ length: N }, (_, i) => client(i)))
  .then(() => {
    if (CPUS) console.log(`CPUs simuladas pelo anfitrião: ${stats.cpus}; linhas no resultado: ${stats.results}`);
    console.log(`OK: ${N} jogadores completaram a corrida em ${((Date.now() - t) / 1000).toFixed(1)}s reais`);
    console.log(`Itens: ${stats.boxes} caixas pegas, sorteados ${JSON.stringify(Object.fromEntries(stats.items))}, ${stats.spawns} lançados, ${stats.effects} efeitos, ${stats.hits} acertos`);
    process.exit(0);
  })
  .catch((e) => { console.error('FALHA:', e.message); process.exit(1); });
setTimeout(() => { console.error("FALHA: timeout"); process.exit(1); }, 240000);
