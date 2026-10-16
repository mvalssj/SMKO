// Speed ($10EA) per frame: accelerate from rest, coast, accelerate, brake. Time trial (= 100cc) or GP 50cc.
import { readFileSync, writeFileSync } from 'node:fs';
import { createEmu, withoutDsp, BTN } from './host.mjs';
const [core, romPath, out, sel, mode = 'tt'] = process.argv.slice(2);
const emu = await createEmu(core, withoutDsp(readFileSync(romPath)));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120);
if (mode === 'tt') { emu.press(BTN.DOWN, 4, 30); emu.press(BTN.B, 4, 120); }
else { emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); }
emu.press(BTN.B, 4, 180);
for (const c of sel) emu.press(c === 'R' ? BTN.RIGHT : BTN.DOWN, 4, 20);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
if (mode === 'tt') emu.press(BTN.B, 4, 120);
// wait for green light: until timer starts. Detect race timer by speed responding: just wait.
emu.run(mode === 'tt' ? 360 : 600);
const sp = [];
const wp = emu.M._retro_get_memory_data(2);
const r = () => emu.M.HEAP16[(wp + 0x10ea) >> 1] ?? 0;
const seq = [[1 << BTN.B, 700], [0, 300], [1 << BTN.B, 300], [1 << BTN.Y, 120]];
for (const [b, n] of seq) for (let i = 0; i < n; i++) { emu.run(1, b); const v = emu.memory(2); sp.push(v.readInt16LE ? v.readInt16LE(0x10ea) : Buffer.from(v).readInt16LE(0x10ea)); }
writeFileSync(out, JSON.stringify(sp));
console.log(out, sp.slice(0, 20).join(','), 'max', Math.max(...sp));
