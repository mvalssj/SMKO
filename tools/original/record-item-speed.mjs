// Time trial (100cc, no coins): driver by pad moves; force item, use it; print the speed curve.
import { readFileSync } from 'node:fs';
import { createEmu, withoutDsp, BTN } from './host.mjs';
const [core, romPath, sel, item] = process.argv.slice(2);
const emu = await createEmu(core, withoutDsp(readFileSync(romPath)));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.DOWN, 4, 30); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
for (const c of sel) emu.press(c === 'R' ? BTN.RIGHT : BTN.DOWN, 4, 20);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120);
emu.run(360); emu.run(700, 1 << BTN.B);
const M = emu.M, wp = M._retro_get_memory_data(2);
const sp = () => (M.HEAPU8[wp + 0x10ea] | (M.HEAPU8[wp + 0x10eb] << 8)) << 16 >> 16;
const before = sp();
M.HEAPU8[wp + 0x0d70] = +item; M.HEAPU8[wp + 0x0d71] = 0xc0;
emu.run(2, 1 << BTN.B);
const out = [];
for (let i = 0; i < 6; i++) { emu.run(1, (1 << BTN.B) | (1 << BTN.A)); out.push(sp()); }
for (let i = 0; i < 700; i++) { emu.run(1, 1 << BTN.B); out.push(sp()); }
const max = Math.max(...out);
console.log(`sel=${sel || "Mario"} item=${item} antes ${before} máx ${max} em ${out.indexOf(max)} | `, out.filter((_, i) => i % 4 === 0).slice(0, 30).join(",")); if (process.env.SERIES) console.log(JSON.stringify(out));
