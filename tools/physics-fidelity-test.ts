// Kart physics against the original game: our karts given the same pad inputs as the original was, frame by
// frame, compared with what its kart RAM did (tools/ref/original-physics.json: speed $10EA and facing $102A,
// recorded in snes9x with the USA ROM; numbers only, no ROM data). ROM-free.
// Usage: npx tsx tools/physics-fidelity-test.ts
import { readFileSync } from 'node:fs';
import { Genre, type Track } from '../src/rom/rom';
import {
  CC_TOP, DASH_FRAMES, KART_CLASSES, NO_INPUT, createKart, featherJump, kartFacing, kartHeight, raceGeometry, stepKart, type Input, type Kart,
} from '../src/game/physics';

const ref = JSON.parse(readFileSync(new URL('./ref/original-physics.json', import.meta.url), 'utf8'));
let failed = false;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FALHA'} ${msg}`); if (!ok) failed = true; };

// An endless flat road (the floor wraps round like the Battle Royale world's).
const cols = 128, rows = 128;
const flat = {
  genres: new Uint8Array(cols * rows).fill(Genre.Road), world: { cols, rows, ids: new Uint16Array(cols * rows) },
  objects: [], path: [], ai: [], start: null, lapLine: null,
} as unknown as Track;
const geo = raceGeometry(flat);
/** A driver of each class: Mario, Bowser, Peach, Koopa. */
const DRIVER = [0, 2, 3, 5];
const NAMES = ['Mario/Luigi', 'Bowser/DK', 'Peach/Yoshi', 'Koopa/Toad'];

/** Runs inputs as the race does: the kart answers the pad a frame late, as in the original. */
function drive(cls: number, cc: 50 | 100 | 150, inputs: Partial<Input>[], start?: (k: ReturnType<typeof createKart>) => void) {
  const k = createKart(flat, 0, DRIVER[cls], cc);
  start?.(k);
  const speed: number[] = [], facing: number[] = [];
  let pad: Input = NO_INPUT;
  inputs.forEach((inp, f) => {
    stepKart(k, pad, flat, geo, [], f);
    pad = { ...NO_INPUT, ...inp };
    speed.push(Math.round(k.speed * 256));
    facing.push(Math.round((kartFacing(k) * 65536) / (Math.PI * 2)));
  });
  return { speed, facing };
}
const repeat = (inp: Partial<Input>, n: number) => Array.from({ length: n }, () => inp);

// 1. Top speeds (the game's table at ROM 0x18000) and the engine classes (code at $C1:F026, HiROM: -$80 / +$A0).
check(KART_CLASSES.map((c) => c.top).join() === '912,944,880,864', 'velocidade máxima de cada classe = tabela da ROM (912, 944, 880, 864)');
check(CC_TOP[50] === -128 && CC_TOP[100] === 0 && CC_TOP[150] === 160, 'cilindradas: 50cc -128, 150cc +160 (como no código do jogo)');

// 2. Accelerating from rest at 100cc: 700 frames, the original's speed frame by frame.
for (let c = 0; c < 4; c++) {
  const orig: number[] = ref.accel[c];
  const ours = drive(c, 100, repeat({ accel: true }, 701)).speed;
  const u0 = ours.findIndex((v) => v > 0);
  let max = 0, sum = 0;
  for (let i = 0; i < 690; i++) { const d = Math.abs(ours[u0 + i] - orig[i]); max = Math.max(max, d); sum += d; }
  check(sum / 690 <= 1.5 && max <= 10, `aceleração ${NAMES[c]}: diferença média ${(sum / 690).toFixed(2)}, máxima ${max} (1/256 px por quadro)`);
}

// 3. Letting go and braking, from the original's speed at that moment (Mario and Koopa: the clean recordings,
// 50cc grand prix with the 5 coins its kart had picked up on the way).
for (const c of [0, 3]) {
  for (const [what, inp, orig] of [['soltar', {}, ref.coast[c]], ['freio', { brake: true }, ref.brake[c]]] as const) {
    const ours = drive(c, 50, repeat(inp, orig.length - 1), (k) => { k.coins = 5; k.speed = orig[0] / 256; k.vy = -k.speed; }).speed;
    let max = 0;
    for (let i = 1; i < orig.length - 1; i++) max = Math.max(max, Math.abs(ours[i - 1] - orig[i]));
    check(max <= 2, `${what} ${NAMES[c]}: diferença máxima ${max}`);
  }
}

// 4. Turning (100cc): straight, turn, straight, power slide, hop... The facing frame by frame (the body's
// swing and its shake included).
const B = { accel: true }, BR = { accel: true, right: true }, BRS = { accel: true, right: true, drift: true }, BS = { accel: true, drift: true };
const turnInputs = [...repeat(B, 40), ...repeat(BR, 40), ...repeat(B, 40), ...repeat(B, 400), ...repeat(BR, 120), ...repeat(B, 80),
  ...repeat(BRS, 100), ...repeat(B, 80), ...repeat(BS, 10), ...repeat(B, 60)];
const wrap = (d: number) => ((d + 32768) % 65536 + 65536) % 65536 - 32768;
for (let c = 0; c < 4; c++) {
  const orig: number[] = ref.turn[c];
  const ours = drive(c, 100, turnInputs.slice(0, orig.length)).facing;
  let same = 0, total = 0;
  for (let i = 500; i < orig.length; i++) { total++; if (wrap(ours[i] - ours[i - 1]) === wrap(orig[i] - orig[i - 1])) same++; }
  check(same / total >= 0.98, `direção ${NAMES[c]}: ${same} de ${total} quadros com a mesma virada do original`);
}

// 5. Items (100cc time trial, the item used on a straight at top speed): the speed frame by frame from the
// press of the item button.
for (let c = 0; c < 4; c++) {
  for (const [what, orig, give, n] of [['cogumelo', ref.mushroom[c], (k: Kart) => { k.dash = DASH_FRAMES; }, 100], ['estrela', ref.star[c], (k: Kart) => { k.star = 512; }, 560]] as const) {
    const k = createKart(flat, 0, DRIVER[c], 100);
    k.speed = orig[0] / 256; k.vy = -k.speed;
    const ours: number[] = [orig[0]];
    let f = 0;
    give(k);
    for (let i = 1; i < n; i++) {
      stepKart(k, { ...NO_INPUT, accel: true }, flat, geo, [], f++);
      ours.push(Math.round(k.speed * 256));
    }
    let max = 0, sum = 0;
    for (let i = 0; i < n; i++) { const d = Math.abs(ours[i] - orig[i]); max = Math.max(max, d); sum += d; }
    // (Bowser, DK, Peach and Yoshi's mushroom goes a little over 2016 on its last 2 frames in the original: not done.)
    check(sum / n <= (what === 'estrela' ? 9 : c === 1 || c === 2 ? 30 : 4), `${what} ${NAMES[c]}: diferença média ${(sum / n).toFixed(1)}, máxima ${max} (pico ${Math.max(...orig)} / ${Math.max(...ours)})`);
  }
}
// A mushroom, then letting go of the accelerator 40 frames after the press (Mario): over top speed, only the
// ordinary slowing down (16 a frame over 1024; the recording's 15.75 / 9.75 averages are the terrain changing
// under the kart in a run without the DSP-1, as in 3).
{
  const orig: number[] = ref.mushroomLetGo;
  const k = createKart(flat, 0, 0, 100);
  k.speed = orig[0] / 256; k.vy = -k.speed;
  k.dash = DASH_FRAMES;
  const ours: number[] = [orig[0]];
  for (let i = 1; i < orig.length; i++) { stepKart(k, { ...NO_INPUT, accel: i < 46 }, flat, geo, [], i); ours.push(Math.round(k.speed * 256)); }
  let max = 0, sum = 0;
  for (let i = 0; i < orig.length; i++) { const d = Math.abs(ours[i] - orig[i]); max = Math.max(max, d); sum += d; }
  check(sum / orig.length <= 9, `cogumelo e soltar o acelerador: diferença média ${(sum / orig.length).toFixed(1)}, máxima ${max}`);
}

// The feather's arc: height frame by frame (1/256 px).
{
  const k = createKart(flat, 0, 0, 50);
  k.speed = 811 / 256; k.vy = -k.speed;
  featherJump(k);
  const ours: number[] = [];
  for (let i = 0; i < 37; i++) { ours.push(Math.round(kartHeight(k) * 256)); stepKart(k, { ...NO_INPUT, accel: true }, flat, geo, [], i); }
  const orig: number[] = ref.feather;
  let max = 0;
  for (let i = 0; i < 37; i++) max = Math.max(max, Math.abs(ours[i] - orig[i]));
  check(max <= 30 && ours.findIndex((h, i) => i > 0 && h === 0) === 36, `pena: arco de 36 quadros, diferença máxima de altura ${(max / 256).toFixed(2)} px`);
}

// 6. Shells (with the DSP-1 answered by tools/original/dsp-host.mjs): 3 px a frame plus the thrower's speed.
{
  const { createEntity } = await import('../src/game/items');
  const { SHELL_BASE_SPEED } = await import('../shared/items');
  for (const [what, m] of Object.entries(ref.shell) as [string, { kart: number; shell: number }][]) {
    const e = createEntity({ id: 1, kind: 'greenShell', owner: 1, x: 0, y: 0, a: 0, frame: 0, target: null, s: SHELL_BASE_SPEED + m.kart / 256 });
    const ours = Math.hypot(e.vx, e.vy) * 256;
    check(Math.abs(ours - m.shell) <= 16, `casco (${what}): ${Math.round(ours)} / original ${m.shell} (1/256 px por quadro)`);
  }
}

// 7. Hit by a green shell (a CPU on the grid, with the DSP-1 answered), or touched by a kart with a star (which
// spins it the same way, recorded to the end): stopped dead, nearly 6 turns, the heading's step frame by frame,
// and the frame it drives on.
{
  const { spinOut, SHELL_SPIN_FRAMES } = await import('../src/game/physics');
  const spin = (how: true | 'star') => {
    const k = createKart(flat, 0, 0, 100);
    k.speed = 48 / 256; k.vy = -k.speed;
    spinOut(k, how);
    const steps: number[] = [];
    let prev = k.angle, moved = -1;
    for (let i = 0; i < SHELL_SPIN_FRAMES + 4; i++) {
      stepKart(k, { ...NO_INPUT, accel: true }, flat, geo, [], i);
      if (moved < 0 && k.speed > 0) moved = i;
      steps.push(Math.round(((k.angle - prev) * 65536) / (Math.PI * 2)));
      prev = k.angle;
    }
    return { steps, moved };
  };
  const same = (a: number[], b: number[]) => b.filter((v, i) => Math.abs(a[i] - v) <= 1).length;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0) / 65536;
  const shell = spin(true), star = spin('star');
  const oShell: number[] = ref.shellSpin.facingSteps, oStar: number[] = ref.starSpin.facingSteps;
  check(same(shell.steps, oShell) === oShell.length && same(star.steps, oStar) === oStar.length && star.moved === ref.starSpin.moveAt && shell.moved === SHELL_SPIN_FRAMES - 1,
    `rodada: casco ${same(shell.steps, oShell)} de ${oShell.length} quadros com o mesmo giro, estrela ${same(star.steps, oStar)} de ${oStar.length} (${sum(oStar).toFixed(3)} voltas no original, ${sum(star.steps.slice(0, oStar.length)).toFixed(3)} na nossa), anda de novo no quadro ${star.moved} (original ${ref.starSpin.moveAt})`);
}

// 7b. Slipping on a banana (Mario Circuit 1, 50cc, with the DSP-1 answered): 3 turns and a bit, on the way it
// went, 8 a frame slower; facing the way it was again and driving on 105 frames later. The facing frame by frame.
{
  const { spinOut, SLIP_FRAMES } = await import('../src/game/physics');
  const r = ref.bananaSlip;
  const k = createKart(flat, 0, 0, 50);
  k.speed = r.speed[0] / 256; k.vy = -k.speed;
  const start = k.angle, x0 = k.x;
  spinOut(k, 'banana');
  let same = 0, sameV = 0, n = 0;
  for (let i = 1; i < r.facing.length; i++) {
    stepKart(k, { ...NO_INPUT, accel: true }, flat, geo, [], i);
    const f = ((Math.round(((k.angle - start) * 65536) / (Math.PI * 2)) % 65536) + 65536) % 65536;
    if (Math.abs(f - r.facing[i]) <= 1 || i >= SLIP_FRAMES - 2) same++;
    // (Not from where it fell to 0 at once, frame 65: ours slows down to 0 at 8 a frame.)
    if (i < 64 || i > 100) { n++; if (Math.abs(k.speed * 256 - r.speed[i]) <= 1) sameV++; }
  }
  const moving = r.speed.findIndex((v: number, i: number) => i > 70 && v > 0);
  check(same >= r.facing.length - 2 && sameV === n && Math.abs(k.x - x0) < 0.5 && moving === SLIP_FRAMES,
    `banana: ${same} de ${r.facing.length - 1} quadros com a mesma direção, velocidade igual em ${sameV} de ${n}, segue reto, volta a andar no quadro ${moving} (nosso ${SLIP_FRAMES})`);
}

// 7c. Struck by the lightning (a CPU, Mario Circuit 1, 50cc): nearly 2 turns, 56 a frame slower, driving on
// 70 frames later.
{
  const { spinOut, ZAP_FRAMES } = await import('../src/game/physics');
  const r = ref.lightning;
  const k = createKart(flat, 0, 0, 50);
  k.speed = r.speed[0] / 256; k.vy = -k.speed;
  spinOut(k, 'lightning');
  let same = 0, sameV = 0, prev = k.angle;
  for (let i = 1; i <= ZAP_FRAMES; i++) {
    stepKart(k, { ...NO_INPUT, accel: true }, flat, geo, [], i);
    if (i >= ZAP_FRAMES || Math.abs(Math.round(((k.angle - prev) * 65536) / (Math.PI * 2)) - r.facingSteps[i - 1]) <= 1) same++;
    if (Math.abs(k.speed * 256 - r.speed[i]) <= 1) sameV++;
    prev = k.angle;
  }
  const moving = r.speed.findIndex((v: number, i: number) => i > 20 && v > 0);
  check(same === ZAP_FRAMES && sameV === ZAP_FRAMES && moving === ZAP_FRAMES,
    `raio: ${same} de ${ZAP_FRAMES} quadros com o mesmo giro, velocidade igual em ${sameV}, volta a andar no quadro ${moving} (nosso ${ZAP_FRAMES})`);
}

// 8. The roulette (an item box on Mario Circuit 1, held item $0D70/$0D71): spins 201 frames or until the button
// (3 frames later), the item usable 65 frames after it stops.
{
  const { ROULETTE_SPIN_MS, ROULETTE_STOP_MS, ROULETTE_SHOW_MS } = await import('../shared/items');
  const fr = (ms: number) => Math.round((ms * 60) / 1000);
  check(fr(ROULETTE_SPIN_MS) === ref.roulette.spinFrames && fr(ROULETTE_STOP_MS) === ref.roulette.stopFrames && fr(ROULETTE_SHOW_MS) === ref.roulette.showFrames,
    `roleta: ${fr(ROULETTE_SPIN_MS)} quadros girando, para ${fr(ROULETTE_STOP_MS)} depois do botão, item pronto ${fr(ROULETTE_SHOW_MS)} depois`);
}

console.log(failed ? 'houve falhas' : 'tudo certo');
process.exit(failed ? 1 : 0);
