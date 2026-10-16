// Minimal headless libretro host for the snes9x WASM core: run frames, press buttons, read VRAM/screens.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const BTN = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };

/**
 * Analysis copy of the ROM that runs without the DSP-1: the header says "no coprocessor" and the
 * game's 28 DSP status wait loops (LDA $007000 / BPL) fall through. Menus don't need the DSP's math.
 * Never saved: only used in memory to inspect the menus.
 */
export function withoutDsp(rom) {
  const r = new Uint8Array(rom);
  r[0xffd6] = 0x02;
  for (let i = 0; i < r.length - 6; i++) {
    if (r[i] === 0xaf && r[i + 1] === 0x00 && r[i + 2] === 0x70 && r[i + 3] === 0x00 && r[i + 4] === 0x10 && r[i + 5] === 0xfa) { r[i + 4] = 0xea; r[i + 5] = 0xea; }
  }
  return r;
}

export async function createEmu(corePath, romBytes) {
  const { default: create } = await import(pathToFileURL(corePath).href);
  const M = await create({ print: () => {}, printErr: () => {} });
  const enc = (s) => { const b = new TextEncoder().encode(s + '\0'); const p = M._malloc(b.length); M.HEAPU8.set(b, p); return p; };
  const sysDir = enc('/');
  let pixelFormat = 0;
  const env = M.addFunction((cmd, data) => {
    switch (cmd) {
      case 9: case 31: M.HEAPU32[data >> 2] = sysDir; return 1; // system / save directory
      case 10: pixelFormat = M.HEAPU32[data >> 2]; return 1; // SET_PIXEL_FORMAT
      default: return 0;
    }
  }, 'iii');
  const st = { frame: null, w: 0, h: 0, buttons: 0, buttons2: 0 };
  const video = M.addFunction((data, w, h, pitch) => {
    if (!data) return;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r, g, b;
      if (pixelFormat === 1) { const v = M.HEAPU32[(data + y * pitch + x * 4) >> 2]; r = (v >> 16) & 255; g = (v >> 8) & 255; b = v & 255; }
      else { const v = M.HEAPU16[(data + y * pitch + x * 2) >> 1]; r = ((v >> 11) & 31) << 3; g = ((v >> 5) & 63) << 2; b = (v & 31) << 3; }
      const o = (y * w + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
    st.frame = out; st.w = w; st.h = h;
  }, 'viiii');
  const aud = M.addFunction(() => {}, 'vii');
  st.ae = 0; st.an = 0;
  const audb = M.addFunction((d, frames) => { const a = M.HEAP16.subarray(d >> 1, (d >> 1) + frames * 2); for (const v of a) st.ae += (v / 32768) ** 2; st.an += a.length; return frames; }, 'iii');
  const poll = M.addFunction(() => {}, 'v');
  const input = M.addFunction((port, device, index, id) => (device === 1 && ((port === 0 ? st.buttons : port === 1 ? st.buttons2 : 0) >> id) & 1 ? 1 : 0), 'iiiii');
  M._retro_set_environment(env);
  M._retro_init();
  M._retro_set_video_refresh(video);
  M._retro_set_audio_sample(aud);
  M._retro_set_audio_sample_batch(audb);
  M._retro_set_input_poll(poll);
  M._retro_set_input_state(input);
  const romPtr = M._malloc(romBytes.length);
  M.HEAPU8.set(romBytes, romPtr);
  const info = M._malloc(16);
  M.HEAPU32[info >> 2] = enc('/rom.sfc');
  M.HEAPU32[(info >> 2) + 1] = romPtr;
  M.HEAPU32[(info >> 2) + 2] = romBytes.length;
  M.HEAPU32[(info >> 2) + 3] = 0;
  if (!M._retro_load_game(info)) throw new Error('retro_load_game failed');
  return {
    M, st,
    run(n = 1, buttons = 0, buttons2 = 0) { st.buttons = buttons; st.buttons2 = buttons2; for (let i = 0; i < n; i++) M._retro_run(); st.buttons = st.buttons2 = 0; },
    press(btn, hold = 4, after = 20) { this.run(hold, 1 << btn); this.run(after); },
    pc() { return M._romdev_getreg(16); },
    /** BG scroll + tile/map bases from the PPU block of a savestate. */
    ppu() {
      const n = M._retro_serialize_size(); const p = M._malloc(n); M._retro_serialize(p, n);
      const st = Buffer.from(M.HEAPU8.slice(p, p + n)); M._free(p);
      const at = st.indexOf('PPU:'); const data = st.subarray(at + 4 + 7);
      const u16 = (o) => (data[o] << 8) | data[o + 1];
      const bg = [0, 1, 2, 3].map((i) => { const o = 14 + i * 11; return { scBase: u16(o), h: u16(o + 2), v: u16(o + 4), size: data[o + 6], nameBase: u16(o + 7), scSize: u16(o + 9) }; });
      return { bg, mode: data[14 + 44], bg3prio: data[14 + 45] };
    },
    memory(id) { const p = M._retro_get_memory_data(id), n = M._retro_get_memory_size(id); return p ? M.HEAPU8.slice(p, p + n) : null; },
    screenshot(path, scale = 2) { savePng(path, st.frame, st.w, st.h, scale); },
  };
}

export function savePng(path, rgba, w, h, scale = 1) {
  const W = w * scale, H = h * scale;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = ((Math.floor(y / scale) * w) + Math.floor(x / scale)) * 4, o = y * (W * 4 + 1) + 1 + x * 4;
    raw[o] = rgba[s]; raw[o + 1] = rgba[s + 1]; raw[o + 2] = rgba[s + 2]; raw[o + 3] = rgba[s + 3];
  }
  const T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', deflateSync(raw)), ch('IEND', Buffer.alloc(0))]));
}
