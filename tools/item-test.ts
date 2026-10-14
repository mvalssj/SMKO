// Dev check: item authority rules and shell simulation.
// Usage: npx tsx tools/item-test.ts "<rom.sfc>"
import { readFileSync } from 'node:fs';
import { ItemAuthority, DEFAULT_ODDS, ROULETTE_MS, BOX_RESPAWN_MS } from '../shared/items';
import type { ServerMsg } from '../shared/protocol';
import { SmkRom } from '../src/rom/rom';
import { createKart } from '../src/game/physics';
import { advanceEntity, createEntity } from '../src/game/items';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- Authority ----
let clock = 1_000_000;
const sent: { to: number | 'all'; msg: ServerMsg }[] = [];
const seq = [0.1, 0.5, 0.9, 0.3, 0.7];
let si = 0;
const auth = new ItemAuthority(DEFAULT_ODDS, (to, msg) => sent.push({ to, msg }), clock, () => clock, () => seq[si++ % seq.length]);
[1, 2, 3].forEach((id) => auth.addPlayer(id));
auth.updateKart(1, 2, 100); auth.updateKart(2, 2, 50); auth.updateKart(3, 2, 10);
const last = (t: ServerMsg['t'], to?: number) => [...sent].reverse().find((s) => s.msg.t === t && (to === undefined || s.to === to))?.msg as any;

auth.handle(2, { t: 'box', tiles: [1000, 1001, 1128, 1129] });
const rolled = last('item', 2);
check('caixa sorteia item para o jogador', !!rolled?.item && rolled.roll === true, rolled?.item);
check('caixa some para todos', last('tiles')?.restore === false);
auth.handle(3, { t: 'box', tiles: [1000, 1001] });
check('caixa usada não dá item de novo', !sent.some((s) => s.to === 3 && s.msg.t === 'item'));
auth.handle(2, { t: 'use', x: 100, y: 100, a: 0, back: false });
check('item não pode ser usado durante a roleta', !sent.some((s) => s.msg.t === 'spawn' || s.msg.t === 'effect'));
clock += ROULETTE_MS + 1; auth.tick();
auth.handle(2, { t: 'use', x: 100, y: 100, a: 0, back: false });
check('item usado depois da roleta', sent.some((s) => s.msg.t === 'spawn' || s.msg.t === 'effect' || s.msg.t === 'coins'), rolled?.item);
clock += BOX_RESPAWN_MS; auth.tick();
check('caixa volta depois de 10s', last('tiles')?.restore === true);

// Shell flow: give player 3 a red shell by rolling until we get one.
const auth2 = new ItemAuthority({ leader: [0, 0, 0, 0, 0, 32, 0, 0, 0], middle: [0, 0, 0, 0, 0, 32, 0, 0, 0], back: [0, 0, 0, 0, 0, 32, 0, 0, 0] },
  (to, msg) => sent.push({ to, msg }), clock, () => clock);
[1, 2, 3].forEach((id) => auth2.addPlayer(id));
auth2.updateKart(1, 2, 100); auth2.updateKart(2, 2, 50); auth2.updateKart(3, 2, 10);
auth2.handle(3, { t: 'box', tiles: [5] }); clock += ROULETTE_MS + 1; auth2.tick();
auth2.handle(3, { t: 'use', x: 10, y: 10, a: 0, back: false });
const spawn = last('spawn');
check('casco vermelho mira o jogador logo à frente', spawn?.e.kind === 'redShell' && spawn.e.target === 2, JSON.stringify(spawn?.e));
auth2.handle(2, { t: 'hit', entity: spawn.e.id });
check('acerto remove o casco para todos', last('despawn')?.id === spawn.e.id && last('despawn')?.victim === 2);
const before = sent.length;
auth2.handle(1, { t: 'hit', entity: spawn.e.id });
check('casco já removido não acerta de novo', sent.length === before);

// Lightning and Boo.
const auth3 = new ItemAuthority({ leader: [0, 0, 0, 0, 0, 0, 16, 0, 16], middle: [0, 0, 0, 0, 0, 0, 16, 0, 16], back: [0, 0, 0, 0, 0, 0, 16, 0, 16] },
  (to, msg) => sent.push({ to, msg }), clock, () => clock, () => 0.99);
[1, 2].forEach((id) => auth3.addPlayer(id));
auth3.handle(1, { t: 'box', tiles: [7] }); auth3.handle(2, { t: 'box', tiles: [9] });
clock += ROULETTE_MS + 1; auth3.tick();
auth3.handle(1, { t: 'use', x: 0, y: 0, a: 0, back: false });
check('raio afeta os outros e tira o item deles', last('effect')?.kind === 'lightning' && last('item', 2)?.item === null);

// ---- Shell simulation on a real track ----
const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const track = rom.loadTrack(rom.tracks[0]);
const k = createKart(track, 0);
const green = createEntity({ id: 1, kind: 'greenShell', owner: 1, x: k.x, y: k.y - 14, a: 0, frame: 0, target: null });
let bounced = false, prevVy = green.vy;
for (let f = 1; f <= 400 && !green.dead; f++) {
  advanceEntity(green, track, f, () => null);
  if (Math.sign(green.vy) !== Math.sign(prevVy)) bounced = true;
  prevVy = green.vy;
}
check('casco verde anda e quica nas paredes', bounced && !green.dead, `pos ${green.x.toFixed(0)},${green.y.toFixed(0)}`);
const red = createEntity({ id: 2, kind: 'redShell', owner: 1, x: k.x, y: k.y - 14, a: 0, frame: 0, target: 9 });
const target = { x: k.x - 60, y: k.y - 200 };
let minD = Infinity;
for (let f = 1; f <= 200 && !red.dead; f++) {
  advanceEntity(red, track, f, () => target);
  minD = Math.min(minD, Math.hypot(red.x - target.x, red.y - target.y));
}
check('casco vermelho persegue o alvo', minD < 8, `menor distância ${minD.toFixed(1)}`);
const g = rom.loadItemGraphics(track.colors);
check('ícones dos 9 itens carregados', g.icons.length === 9 && g.icons.every((i) => i.pixels.some((v, n) => n % 4 === 3 && v > 0)));
console.log(JSON.stringify(rom.itemOdds(rom.tracks[19])));
process.exit(failures ? 1 : 0);
