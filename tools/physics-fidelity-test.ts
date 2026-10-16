// Kart physics against the original game: our karts given the same pad inputs as the original was, frame by
// frame, compared with what its kart RAM did (tools/ref/original-physics.json: speed $10EA and facing $102A,
// recorded in snes9x with the USA ROM; numbers only, no ROM data). ROM-free.
// Usage: npx tsx tools/physics-fidelity-test.ts
import { readFileSync } from 'node:fs';
import { Genre, type Track } from '../src/rom/rom';
import { CC_TOP, KART_CLASSES, NO_INPUT, createKart, kartFacing, raceGeometry, stepKart, type Input } from '../src/game/physics';

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

// 1. Top speeds (the game's table at ROM 0x18000) and the engine classes (bank $83, $F026: -$80 / +$A0).
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

console.log(failed ? 'houve falhas' : 'tudo certo');
process.exit(failed ? 1 : 0);
