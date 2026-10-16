// Analysis only: run Super Mario Kart without the DSP-1 chip in the core, answering the game's DSP-1 traffic
// from here. In an in-memory copy of the ROM every access to the chip's data register ($6000) becomes
// COP #kind (2 bytes, the rest NOP), the COP vector's code becomes NOP + RTI, and a pc-break on that NOP hands each
// access to `dsp` (bytes in, bytes out). Nothing of the chip itself is used.
import { readFileSync } from 'node:fs';
import { createEmu, withoutDsp } from './host.mjs';

export const KIND = { STA: 1, LDA: 2, STY: 3, LDX: 4, LDY: 5, ADC: 6, SBC: 7 };
const SITES = [
  ['STA', [0x8d, 0x00, 0x60]], ['LDA', [0xad, 0x00, 0x60]], ['STA', [0x8f, 0x00, 0x60, 0x00]], ['LDA', [0xaf, 0x00, 0x60, 0x00]],
  ['STY', [0x8c, 0x00, 0x60]], ['LDX', [0xae, 0x00, 0x60]], ['LDY', [0xac, 0x00, 0x60]],
  // The game also adds the chip's results in (sprite positions): ADC / SBC $6000.
  ['ADC', [0x6d, 0x00, 0x60]], ['ADC', [0x6f, 0x00, 0x60, 0x00]], ['SBC', [0xed, 0x00, 0x60]],
];

export function patchRom(romBytes) {
  const r = withoutDsp(romBytes);
  const sites = [];
  for (const [kind, pat] of SITES) {
    for (let i = 0; i < r.length - pat.length; i++) {
      if (!pat.every((b, j) => r[i + j] === b)) continue;
      r[i] = 0x02; r[i + 1] = KIND[kind];
      for (let j = 2; j < pat.length; j++) r[i + j] = 0xea;
      sites.push(i);
    }
  }
  const cop = r[0xffe4] | (r[0xffe5] << 8);
  r[cop] = 0xea; r[cop + 1] = 0x40; // NOP (the break), RTI
  return { rom: r, sites, cop };
}

/**
 * dsp: { write(byte), read(): byte }. Returns the emulator, with run(n, buttons) answering the chip.
 */
export async function createDspEmu(core, romPath, dsp) {
  const { rom, cop } = patchRom(new Uint8Array(readFileSync(romPath)));
  const emu = await createEmu(core, rom);
  const M = emu.M;
  const buf = M._malloc(64);
  const wram = M._retro_get_memory_data(2);
  M._romdev_pcbreak_set(cop, 1);
  const stats = { accesses: 0 };
  const frame = () => {
    for (let guard = 0; guard < 100000; guard++) {
      M._retro_run();
      // Stopped on the NOP: an access to answer; anywhere else, the frame finished.
      if ((M._romdev_getreg(16) & 0xffffff) !== cop) return;
      // COP pushed PB, PC (after its operand) and P: S+1 = P, S+2/3 = PC, S+4 = PB.
      const S = M._romdev_getreg(4) & 0xffff;
      const p = M.HEAPU8[wram + ((S + 1) & 0x1fff)];
      const pc = M.HEAPU8[wram + ((S + 2) & 0x1fff)] | (M.HEAPU8[wram + ((S + 3) & 0x1fff)] << 8);
      const pb = M.HEAPU8[wram + ((S + 4) & 0x1fff)];
      const opAt = ((pb & 0x3f) << 16) | ((pc - 1) & 0xffff);
      const kind = rom[opAt];
      const wide = kind === KIND.STA || kind === KIND.LDA || kind === KIND.ADC || kind === KIND.SBC ? !(p & 0x20) : !(p & 0x10);
      stats.accesses++;
      if (emu.onAccess) emu.onAccess(kind, opAt, dsp.cmd);
      if (kind === KIND.STA || kind === KIND.STY) {
        const v = M._romdev_getreg(kind === KIND.STA ? 0 : 2);
        dsp.write(v & 0xff);
        if (wide) dsp.write((v >> 8) & 0xff);
      } else if (kind === KIND.ADC || kind === KIND.SBC) {
        const lo = dsp.read();
        const v = wide ? lo | (dsp.read() << 8) : lo;
        const mask = wide ? 0xffff : 0xff, sign = wide ? 0x8000 : 0x80;
        const a = M._romdev_getreg(0), av = a & mask, carry = p & 1;
        const operand = kind === KIND.ADC ? v : ~v & mask;
        const sum = av + operand + carry, res = sum & mask;
        const overflow = (~(av ^ operand) & (av ^ res) & sign) !== 0;
        M._romdev_setreg(0, wide ? res : (a & 0xff00) | res);
        M.HEAPU8[wram + ((S + 1) & 0x1fff)] = (p & ~0xc3) | (res & sign ? 0x80 : 0) | (overflow ? 0x40 : 0) | (res === 0 ? 0x02 : 0) | (sum > mask ? 0x01 : 0);
      } else {
        const lo = dsp.read();
        const v = wide ? lo | (dsp.read() << 8) : lo;
        const reg = kind === KIND.LDA ? 0 : kind === KIND.LDX ? 1 : 2;
        const old = M._romdev_getreg(reg);
        M._romdev_setreg(reg, wide ? v : (old & 0xff00) | v);
        // N and Z as the load would set them (RTI restores the pushed P).
        const neg = wide ? v & 0x8000 : v & 0x80;
        M.HEAPU8[wram + ((S + 1) & 0x1fff)] = (p & ~0x82) | (neg ? 0x80 : 0) | (v === 0 ? 0x02 : 0);
      }
      // On past the NOP (still armed) to the RTI.
      M._romdev_setreg(16, cop + 1);
      M._romdev_pcbreak_get(buf, 1);
    }
    throw new Error('runaway frame');
  };
  emu.run = (n = 1, buttons = 0, buttons2 = 0) => { emu.st.buttons = buttons; emu.st.buttons2 = buttons2; for (let i = 0; i < n; i++) frame(); emu.st.buttons = emu.st.buttons2 = 0; };
  emu.press = (btn, hold = 4, after = 20) => { emu.run(hold, 1 << btn); emu.run(after); };
  emu.dspStats = stats;
  return emu;
}
