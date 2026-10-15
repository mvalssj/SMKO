// Battle Royale checks: the world joins every course (you can drive from any course to any other), the safe
// area always closes inside the world, and 99 bots get about without the items (distance, falls).
// Usage: npx tsx tools/royale-test.ts "Super Mario Kart (USA).sfc" [seconds]
import { readFileSync } from 'node:fs';
import { SmkRom, TILE } from '../src/rom/rom';
import { buildWorld } from '../src/royale/world';
import { RoyaleState } from '../src/royale/state';
import { BotDriver } from '../src/royale/bot';
import { createKart, raceGeometry, stepKart, terrainOf } from '../src/game/physics';
import { WORLD_H, WORLD_W, mulberry32, zoneCircles } from '../shared/royale';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const secs = +(process.argv[3] ?? 30);
let failed = false;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FALHA'} ${msg}`); if (!ok) failed = true; };

const world = buildWorld(rom);
const { cols, rows, regions, courses } = world.world;

// 1. Every course reachable by road (anything you can drive on) from Mario Circuit 1's racing line.
const seen = new Uint8Array(cols * rows);
const start = courses[0].path[0];
const queue = [Math.floor(start.y / TILE) * cols + Math.floor(start.x / TILE)];
seen[queue[0]] = 1;
const ok = (i: number) => { const t = terrainOf(world.genres[i]); return t !== 'wall' && t !== 'fall'; };
while (queue.length) {
  const i = queue.pop()!;
  const x = i % cols, y = (i - x) / cols;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
    const j = ny * cols + nx;
    if (!seen[j] && ok(j)) { seen[j] = 1; queue.push(j); }
  }
}
const unreached = regions.filter((r, i) => !courses[i].path.some((p) => seen[Math.floor(p.y / TILE) * cols + Math.floor(p.x / TILE)]));
check(unreached.length === 0, `todas as ${regions.length} pistas ligadas por estrada${unreached.length ? ` (faltam: ${unreached.map((r) => r.info.name).join(', ')})` : ''}`);

// 2. The safe area: each circle inside the last, all inside the world.
let circlesOk = true;
for (let seed = 1; seed <= 50; seed++) {
  const c = zoneCircles(seed);
  for (let i = 1; i < c.length; i++) {
    const inside = Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y) + c[i].r <= c[i - 1].r + 0.5;
    const inWorld = c[i].x > 0 && c[i].y > 0 && c[i].x < WORLD_W && c[i].y < WORLD_H;
    if (!inside || !inWorld) circlesOk = false;
  }
}
check(circlesOk, 'zona: cada círculo dentro do anterior e dentro do mundo (50 partidas)');

// 3. Bots driving about for a while.
const st = new RoyaleState(world, 777);
const rand = mulberry32(5);
const geo = raceGeometry(world);
const bots = Array.from({ length: 99 }, (_, i) => {
  const k = createKart(world, 0, i % 8, 100);
  const s = st.spawn(i + 1);
  Object.assign(k, { x: s.x, y: s.y, angle: s.angle });
  k.safe = { ...s };
  return { k, d: new BotDriver(world, 1000 + i, 0.6 + rand() * 0.4, rand), falls: 0, dist: 0, px: s.x, py: s.y };
});
const t0 = performance.now();
for (let f = 0; f < secs * 60; f++) {
  const z = st.zone((f * 1000) / 60);
  for (const b of bots) {
    const before = b.k.fall;
    const input = b.d.input(b.k, { frame: f, zone: z.now, next: z.next, nav: st.nav, rivals: [], boxes: st.boxes, spawns: st.spawns, item: null });
    stepKart(b.k, input, world, geo, [], f);
    if (b.k.fall > 0 && before === 0) b.falls++;
    b.dist += Math.hypot(b.k.x - b.px, b.k.y - b.py);
    b.px = b.k.x; b.py = b.k.y;
  }
}
const ms = (performance.now() - t0) / (secs * 60);
const perMin = (n: number) => (n / bots.length) * (60 / secs);
const dist = perMin(bots.reduce((a, b) => a + b.dist, 0));
const falls = perMin(bots.reduce((a, b) => a + b.falls, 0));
check(dist > 4000, `bots andam: ${Math.round(dist)} px por minuto em média`);
check(falls < 5, `bots caem pouco: ${falls.toFixed(1)} quedas por minuto em média`);
check(ms < 8, `99 bots: ${ms.toFixed(2)} ms por quadro`);
console.log(failed ? 'houve falhas' : 'tudo certo');
process.exit(failed ? 1 : 0);
