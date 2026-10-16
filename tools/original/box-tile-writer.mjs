// Where the game keeps the item box's tile: WRAM bytes going 196..199 -> 212..215 at the pickup; then which
// code writes there (write watchpoint).
import { readFileSync } from 'node:fs';
import { createEmu, withoutDsp, BTN } from './host.mjs';
const [core, romPath] = process.argv.slice(2);
const emu = await createEmu(core, withoutDsp(readFileSync(romPath)));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
emu.run(600);
const M = emu.M, wp = M._retro_get_memory_data(2);
const buf = M._malloc(4096); M._romdev_watchpoint_set(0x7f1006, 1);
const before = Buffer.from(emu.memory(2));
const put = (x, y) => { M.HEAPU8[wp + 0x1018] = x & 255; M.HEAPU8[wp + 0x1019] = x >> 8; M.HEAPU8[wp + 0x101c] = y & 255; M.HEAPU8[wp + 0x101d] = y >> 8; };
for (let i = 0; i < 6; i++) { put(56, 264); emu.run(1); }
M.HEAPU8.fill(0, buf, buf + 256); M._romdev_watchpoint_get(buf, 64); console.log('watch', Buffer.from(M.HEAPU8.slice(buf, buf + 48)).toString('hex'));
const after = Buffer.from(emu.memory(2));
const hits = [];
for (let a = 0; a < after.length; a++) if (before[a] >= 196 && before[a] <= 199 && after[a] === before[a] + 16) hits.push(a);
console.log('bytes 196..199 -> +16:', hits.map((a) => '$' + (0x7e0000 + a).toString(16)).join(' '));
// Other WRAM that changed at the pickup (small set, outside the karts' / objects').
const diff = [];
for (let a = 0; a < 0x2000; a++) if (before[a] !== after[a] && !(a >= 0x1000 && a < 0x2000)) diff.push('$' + a.toString(16) + ':' + before[a] + '>' + after[a]);
console.log('outras mudanças baixas:', diff.slice(0, 60).join(' '));
