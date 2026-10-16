// ROM-free regression tests. These verify implementation bugs, not pixel equivalence with a cartridge.
import assert from 'node:assert/strict';
import { animationFrame, wrapMenuText } from '../src/menu/timing';
import { BOARD_NAMES, CUP_NAMES } from '../src/menu/results';
import { Genre, type Track } from '../src/rom/rom';
import { coverTiles } from '../src/game/physics';

for (const hz of [30, 60, 90, 120, 144, 240]) {
  let frame = 0;
  for (let i = 0; i <= hz * 10; i++) frame = animationFrame(500, 500 + i * 1000 / hz);
  assert.equal(frame, 600, `10 seconds at ${hz} Hz`);
}
assert.equal(animationFrame(500, 400), 0);
for (const name of BOARD_NAMES) {
  for (const medal of ['GOLD', 'SILVER', 'BRONZE']) {
    const text = `${name} WINS THE ${medal}.`;
    const lines = wrapMenuText(text);
    assert.equal(lines.join(' '), text);
    assert.ok(lines.every((line) => line.length <= 28));
  }
}
for (const cup of CUP_NAMES) assert.ok(wrapMenuText(`150CC ${cup} RACE`).every((s) => s.length <= 28));
console.log('OK: presentation timeline independent of display Hz; podium messages fit.');

// Race imports keyboard bindings; only those browser globals are needed to test its handlers/cleanup.
Object.assign(globalThis, { addEventListener: () => {}, cancelAnimationFrame: () => {} });
const { Race } = await import('../src/game/race');
const cols = 16, rows = 16;
const track = {
  genres: new Uint8Array(cols * rows).fill(Genre.Road),
  world: { cols, rows, ids: new Uint16Array(cols * rows).fill(1) },
} as unknown as Track;
const index = 8 * cols + 8;
track.genres[index] = Genre.ItemBlock;
track.world!.ids[index] = 123;
const saved = coverTiles(track, [index]);
assert.equal(saved.size, 1);
assert.notEqual(track.genres[index], Genre.ItemBlock);
let updates = 0, unsubscribed = false, sounds = 0;
const race = Object.create(Race.prototype) as any;
race.o = { track, selfId: 1, renderer: { updateTiles: () => { updates++; } },
  sound: { engine: () => {}, loop: () => {}, sfx0: () => { sounds++; } } };
race.raf = 0;
race.savedTiles = saved;
race.unsubs = [() => { unsubscribed = true; }];
race.stop();
assert.ok(unsubscribed);
assert.equal(track.genres[index], Genre.ItemBlock);
assert.equal(track.world!.ids[index], 123);
assert.equal(saved.size, 0);
assert.equal(updates, 1);
race.stop();
assert.equal(updates, 1, 'cleanup is safe when called twice');
race.kart = {};
race.balloons = new Map([[1, 3]]);
race.onItemMessage({ t: 'balloons', id: 1, n: 2 });
assert.equal(sounds, 1);
race.onItemMessage({ t: 'balloons', id: 1, n: 2 });
race.onItemMessage({ t: 'balloons', id: 2, n: 1 });
assert.equal(sounds, 1, 'no duplicate or other-player hit sound');
console.log('OK: cached pickups restored at race end; balloon loss sound triggers once.');
