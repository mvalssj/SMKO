// Battle Royale checks: the world joins every course (you can drive from any course to any other), it wraps
// round (a kart driving off one edge comes in at the other; distances and the safe area go the short way
// round), the safe area always closes inside the world, and 99 bots get about without the items (distance,
// falls).
// Usage: npx tsx tools/royale-test.ts "Super Mario Kart (USA).sfc" [seconds]
import { readFileSync } from 'node:fs';
import { SmkRom, TILE } from '../src/rom/rom';
import { buildWorld } from '../src/royale/world';
import { RoyaleState, royaleBotSlots } from '../src/royale/state';
import { BotDriver } from '../src/royale/bot';
import { createKart, raceGeometry, stepKart, terrainAt, terrainOf } from '../src/game/physics';
import { worldMapPoint } from '../src/game/renderer';
import {
  MARGIN_TILES, COURSE_TILES, GAP_TILES, WORLD_H, WORLD_REGIONS, WORLD_W, insideZone, mulberry32, worldCourseAt, wrapDist,
  zoneAt, zoneCircles,
} from '../shared/royale';
import { NO_INPUT } from '../src/game/physics';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const secs = +(process.argv[3] ?? 30);
let failed = false;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FALHA'} ${msg}`); if (!ok) failed = true; };

const world = buildWorld(rom);
const { cols, rows, regions, courses } = world.world;

// 1. Every course reachable by road (anything you can drive on) from the first course's racing line.
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
    const j = ((ny + rows) % rows) * cols + ((nx + cols) % cols);
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
    const inside = wrapDist(c[i].x, c[i].y, c[i - 1].x, c[i - 1].y) + c[i].r <= c[i - 1].r + 0.5;
    const inWorld = c[i].x > 0 && c[i].y > 0 && c[i].x < WORLD_W && c[i].y < WORLD_H;
    if (!inside || !inWorld) circlesOk = false;
  }
}
check(circlesOk, 'zona: cada círculo dentro do anterior e dentro do mundo (50 partidas)');
const deadly = new Set(WORLD_REGIONS.filter((r) => r.deadly).flatMap((r) => r.courses));
let deadlyEnds = 0;
for (let seed = 1; seed <= 200; seed++) {
  const c = zoneCircles(seed), last = c[c.length - 1];
  if (deadly.has(worldCourseAt(last.x, last.y))) deadlyEnds++;
}
check(deadlyEnds <= 10, `zona: o fim quase nunca cai no vazio ou na lava (${deadlyEnds} de 200 partidas)`);

// 3. Round the world: a kart driving north up the road between the 3rd and 4th columns goes off the top
// edge and comes in at the bottom, on road all the way; distances and the safe area go the short way.
{
  const x = (MARGIN_TILES + 2 * (COURSE_TILES + GAP_TILES) + COURSE_TILES + GAP_TILES / 2) * TILE;
  const k = createKart(world, 0, 0, 100);
  Object.assign(k, { x, y: 300, angle: 0 });
  const geo0 = raceGeometry(world);
  let fell = false, wrapped = false, prevY = k.y;
  for (let f = 0; f < 240; f++) {
    stepKart(k, { ...NO_INPUT, accel: true }, world, geo0, [], f);
    if (k.fall > 0) fell = true;
    if (k.y > prevY + WORLD_H / 2) wrapped = true;
    prevY = k.y;
  }
  check(wrapped && !fell && k.y > WORLD_H - 2000 && k.y < WORLD_H && k.speed > 2,
    `o mundo dá a volta: saiu por cima e voltou por baixo pela estrada (y = ${Math.round(k.y)}, ${k.speed.toFixed(1)} px/quadro)`);
  const a = { x: 10, y: 10 }, b = { x: WORLD_W - 10, y: WORLD_H - 10 };
  check(Math.abs(wrapDist(a.x, a.y, b.x, b.y) - Math.hypot(20, 20)) < 1e-6, 'distância pelo lado mais curto, atravessando a borda');
  check(insideZone({ x: 0, y: 0, r: 100 }, WORLD_W - 30, WORLD_H - 30), 'a zona também atravessa a borda');
  let wrapOk = true;
  for (let seed = 1; seed <= 50; seed++) {
    const c = zoneCircles(seed);
    for (let t = 0; t < 600_000; t += 1000) {
      const z = zoneAt(c, t).now;
      if (!(z.x >= 0 && z.x < WORLD_W && z.y >= 0 && z.y < WORLD_H)) wrapOk = false;
    }
  }
  check(wrapOk, 'zona encolhendo: o centro anda pelo lado mais curto e fica dentro do mundo');
}

// 4. Bots driving about for a while.
const st = new RoyaleState(world, 777);
const roster = [{ id: 1, name: 'human', character: 0, ready: true },
  ...Array.from({ length: 99 }, (_, i) => ({ id: 1000 + i, name: 'bot', character: i % 8, ready: true, cpu: true }))];
const adopted = royaleBotSlots(roster, new Map([[1000, 0]]), new Set([1, 1001]));
check(adopted.length === 97 && adopted.every(({ p }) => p.id !== 1000 && p.id !== 1001),
  'troca de anfitrião assume todos os bots vivos mesmo sem snapshots remotos');
// Every possible human slot must start on solid ground in Battle Course 4, and be visible on
// the same world map as the bots (on narrow and wide screens alike).
const arena = regions.find((r) => r.info.name === 'Battle Course 4')!;
const starts = Array.from({ length: 100 }, (_, slot) => st.spawn(slot));
check(starts.every((s) => s.x >= arena.x0 * TILE && s.x < (arena.x0 + COURSE_TILES) * TILE
  && s.y >= arena.y0 * TILE && s.y < (arena.y0 + COURSE_TILES) * TILE
  && !['wall', 'fall'].includes(terrainAt(world, s.x, s.y))), '100 lugares de largada sobre o chão da arena');
check(Array.from({ length: 99 }, (_, i) => {
  const char = i % 8, b = st.spawn(i + 1, char, true);
  const home = ['Mario Circuit', 'Ghost Valley', 'Bowser Castle', 'Donut Plains', 'Choco Island', 'Koopa Beach', 'Vanilla Lake', 'Rainbow Road'][char];
  const reg = regions.find((r) => b.x >= r.x0 * TILE && b.x < (r.x0 + COURSE_TILES) * TILE
    && b.y >= r.y0 * TILE && b.y < (r.y0 + COURSE_TILES) * TILE);
  return reg && WORLD_REGIONS[reg.land].name === home && !['wall', 'fall'].includes(terrainAt(world, b.x, b.y));
}).every(Boolean), 'bots largam em suas regiões, sobre chão transitável');
for (const width of [256, 384]) {
  const pad = (width - 256) / 2;
  check(starts.every((s) => {
    const p = worldMapPoint(s.x, s.y, WORLD_W, WORLD_H, width, pad);
    return p && p.x >= -pad && p.x <= width - pad && p.y >= 0 && p.y < 224;
  }), `largada visível no minimapa ${width}px`);
}
const rand = mulberry32(5);
const geo = raceGeometry(world);
const bots = Array.from({ length: 99 }, (_, i) => {
  const k = createKart(world, 0, i % 8, 100);
  // Match Race's CPU placement: a bot starts in its driver's region, not on the human arena grid.
  const s = st.spawn(i + 1, i % 8, true);
  Object.assign(k, { x: s.x, y: s.y, angle: s.angle });
  k.safe = { ...s };
  return { k, d: new BotDriver(world, 1000 + i, 0.6 + rand() * 0.4, rand), falls: 0, dist: 0, px: s.x, py: s.y, sx: s.x, sy: s.y };
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
const centre = { x: (arena.x0 + COURSE_TILES / 2) * TILE, y: (arena.y0 + COURSE_TILES / 2) * TILE };
const initial = bots.reduce((n, b) => n + wrapDist(b.sx, b.sy, centre.x, centre.y), 0) / bots.length;
const final = bots.reduce((n, b) => n + wrapDist(b.k.x, b.k.y, centre.x, centre.y), 0) / bots.length;
check(final < initial * 0.85, `bots procuram o combate: distância média à arena ${Math.round(initial)} → ${Math.round(final)} px`);
check(dist > 4000, `bots andam: ${Math.round(dist)} px por minuto em média`);
check(bots.filter((b) => b.dist > 120).length >= 60,
  `maioria dos bots sai da largada: ${bots.filter((b) => b.dist > 120).length} de 99`);
check(falls < 5, `bots caem pouco: ${falls.toFixed(1)} quedas por minuto em média`);
check(ms < 8, `99 bots: ${ms.toFixed(2)} ms por quadro`);
console.log(failed ? 'houve falhas' : 'tudo certo');
process.exit(failed ? 1 : 0);
