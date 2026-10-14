// Dev check: mini-PPU vs snes9x captures (VRAM/CGRAM/OAM/regs dumped from the emulator, see README).
// Usage: npx tsx tools/ppu-check.ts <capture-dir> <name>...
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { renderFrame, type Screen } from '../src/snes/ppu';
import { crc32 } from '../src/rom/rom';
const dir = process.argv[2];
export function loadCapture(dir: string, name: string): Screen {
  const cg = readFileSync(`${dir}/${name}.cgram`);
  const regs = readFileSync(`${dir}/${name}.regs`);
  const ppu = JSON.parse(readFileSync(`${dir}/${name}.ppu.json`, 'utf8'));
  return {
    vram: new Uint8Array(readFileSync(`${dir}/${name}.vram`)),
    cgram: new Uint16Array(256).map((_, i) => cg[i * 2] | (cg[i * 2 + 1] << 8)),
    mode: (ppu.mode & 7) as 0 | 1, bg3Priority: !!ppu.bg3prio,
    layers: ppu.bg.map((b: any, i: number) => ({ map: b.scBase * 2, chr: b.nameBase * 2, size: b.scSize, h: b.h, v: b.v, enabled: !!(regs[0x212c] & (1 << i)) })),
    oam: new Uint8Array(readFileSync(`${dir}/${name}.oam`)), obsel: regs[0x2101], window: null,
  };
}
export function savePng(path: string, img: Uint8Array, w = 256, h = 224) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(img.buffer, img.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ch = (t: string, b: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); const td = Buffer.concat([Buffer.from(t), b]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', deflateSync(raw)), ch('IEND', Buffer.alloc(0))]));
}
/** Compares against the emulator screenshot (512x448, 2x). Returns % of matching pixels. */
export let SHIFT = 0;
export function setShift(n: number) { SHIFT = n; }
export function compareShot(dir: string, name: string, img: Uint8Array): number {
  const png = readFileSync(`${dir}/${name}.png`);
  // decode our own PNG writer output (filter 0, RGBA)

  let p = 8, idat: Buffer[] = [], w = 0;
  while (p < png.length) { const len = png.readUInt32BE(p); const type = png.toString('latin1', p + 4, p + 8); const data = png.subarray(p + 8, p + 8 + len); if (type === 'IHDR') w = data.readUInt32BE(0); if (type === 'IDAT') idat.push(data); p += 12 + len; }
  const raw = inflateSync(Buffer.concat(idat));
  let same = 0;
  for (let y = 0; y < 224; y++) for (let x = 0; x < 256; x++) {
    const sy = y + SHIFT; if (sy < 0 || sy >= 224) continue;
    const s = (sy * 2) * (w * 4 + 1) + 1 + x * 2 * 4, o = (y * 256 + x) * 4;
    if (Math.abs(raw[s] - img[o]) < 12 && Math.abs(raw[s + 1] - img[o + 1]) < 12 && Math.abs(raw[s + 2] - img[o + 2]) < 12) same++;
  }
  return (100 * same) / (256 * 224);
}
if (process.argv[1].endsWith('ppu-check.ts')) {
  for (const name of process.argv.slice(3)) {
    const img = renderFrame(loadCapture(dir, name));
    savePng(`${dir}/${name}.mine.png`, img);
    const r = [-2, -1, 0, 1, 2].map((d) => { setShift(d); return `${d}:${compareShot(dir, name, img).toFixed(1)}%`; });
    console.log(name, r.join(" "));
  }
}
