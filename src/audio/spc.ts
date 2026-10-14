// SNES sound unit: the SPC700 processor and the S-DSP (8 voices of BRR samples, ADSR/GAIN envelopes, noise,
// pitch modulation, echo with an 8-tap FIR). Written from the public hardware documentation; it runs the
// game's own sound driver, uploaded from the user's ROM. No boot ROM is needed: the host loads the driver
// straight into RAM and jumps to it.

/** Output sample rate of the DSP. */
export const SPC_RATE = 32000;
/** SPC700 clock: 1.024 MHz, i.e. 32 cycles per output sample. */
const CYCLES_PER_SAMPLE = 32;

/** Envelope / noise rate table: samples between steps for rates 0-31 (0 = never). */
const RATES = [0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];

/** 4-point Gaussian-like interpolation kernel (512 entries, sum of the 4 taps ~ 2048). */
const GAUSS = (() => {
  const t = new Int32Array(512);
  for (let i = 0; i < 512; i++) {
    const x = i / 256 - 2; // -2..2
    t[i] = Math.round(Math.exp(-x * x * 1.05) * 1190);
  }
  return t;
})();

const enum Env { Attack, Decay, Sustain, Release }

interface Voice {
  /** Current BRR block address and position in it (0-15). */
  brr: number;
  pos: number;
  /** Decoded samples of the current block plus 3 from before (for interpolation). */
  buf: Int16Array;
  /** 12-bit fraction pitch counter. */
  counter: number;
  env: number;
  envMode: Env;
  envTimer: number;
  keyDelay: number;
  /** Last output sample (for pitch modulation and OUTX). */
  out: number;
  on: boolean;
}

export class Spc {
  readonly ram = new Uint8Array(0x10000);
  readonly dsp = new Uint8Array(128);
  /** Ports: written by the main CPU (read by the SPC at $F4-$F7), and written by the SPC (read by the CPU). */
  readonly portIn = new Uint8Array(4);
  readonly portOut = new Uint8Array(4);

  // CPU registers.
  pc = 0; a = 0; x = 0; y = 0; sp = 0xef;
  private n = 0; private v = 0; private p = 0; private b = 0; private h = 0; private i = 0; private z = 0; private c = 0;

  private timerTarget = new Uint8Array(3);
  private timerStage = [0, 0, 0];
  private timerCount = new Uint8Array(3);
  private timerOn = [false, false, false];
  private dspAddr = 0;
  private cycles = 0;
  private stopped = false;

  private voices: Voice[] = Array.from({ length: 8 }, () => ({
    brr: 0, pos: 0, buf: new Int16Array(19), counter: 0, env: 0, envMode: Env.Release, envTimer: 0, keyDelay: 0, out: 0, on: false,
  }));
  private noise = 0x4000;
  private noiseTimer = 0;
  private echoPos = 0;
  private echoHist = [new Int16Array(8), new Int16Array(8)];
  private echoHistPos = 0;
  private konLatch = 0;

  // ---------- Host interface ----------

  /** Copies `data` into RAM at `addr`. */
  load(addr: number, data: Uint8Array) {
    for (let i = 0; i < data.length; i++) this.ram[(addr + i) & 0xffff] = data[i];
  }

  /** Starts the uploaded driver at `entry`, like the boot ROM does after a transfer. */
  start(entry: number) {
    this.pc = entry; this.sp = 0xef; this.a = this.x = this.y = 0;
    this.setPsw(0x02);
    this.stopped = false;
    // Control: timers off, boot ROM off.
    this.ram[0xf1] = 0;
    this.dsp[0x6c] = 0xe0;
  }

  /** Renders `count` stereo samples (interleaved L, R, 16-bit range as floats -1..1). */
  render(out: Float32Array, count: number) {
    for (let s = 0; s < count; s++) {
      this.runCycles(CYCLES_PER_SAMPLE);
      const [l, r] = this.sample();
      out[s * 2] = l / 32768;
      out[s * 2 + 1] = r / 32768;
    }
  }

  // ---------- Memory ----------

  private read(a: number): number {
    a &= 0xffff;
    if (a >= 0xf0 && a <= 0xff) {
      switch (a) {
        case 0xf2: return this.dspAddr;
        case 0xf3: return this.readDsp(this.dspAddr & 0x7f);
        case 0xf4: case 0xf5: case 0xf6: case 0xf7: return this.portIn[a - 0xf4];
        case 0xfd: case 0xfe: case 0xff: {
          const t = a - 0xfd, v = this.timerCount[t];
          this.timerCount[t] = 0;
          return v;
        }
        default: return this.ram[a];
      }
    }
    return this.ram[a];
  }

  private write(a: number, v: number) {
    a &= 0xffff; v &= 0xff;
    if (a >= 0xf0 && a <= 0xff) {
      switch (a) {
        case 0xf1:
          for (let t = 0; t < 3; t++) {
            const on = !!(v & (1 << t));
            if (on && !this.timerOn[t]) { this.timerStage[t] = 0; this.timerSub[t] = 0; this.timerCount[t] = 0; }
            this.timerOn[t] = on;
          }
          if (v & 0x10) { this.portIn[0] = this.portIn[1] = 0; }
          if (v & 0x20) { this.portIn[2] = this.portIn[3] = 0; }
          break;
        case 0xf2: this.dspAddr = v; break;
        case 0xf3: if (!(this.dspAddr & 0x80)) this.writeDsp(this.dspAddr, v); break;
        case 0xf4: case 0xf5: case 0xf6: case 0xf7: this.portOut[a - 0xf4] = v; return;
        case 0xfa: case 0xfb: case 0xfc: this.timerTarget[a - 0xfa] = v; break;
        case 0xfd: case 0xfe: case 0xff: return;
      }
    }
    this.ram[a] = v;
  }

  private read16(a: number) { return this.read(a) | (this.read((a + 1) & 0xffff) << 8); }
  /** Direct page address. */
  private dp(o: number) { return (this.p ? 0x100 : 0) | (o & 0xff); }
  private readDp(o: number) { return this.read(this.dp(o)); }
  private writeDp(o: number, v: number) { this.write(this.dp(o), v); }
  private readDp16(o: number) { return this.readDp(o) | (this.readDp((o + 1) & 0xff) << 8); }
  private writeDp16(o: number, v: number) { this.writeDp(o, v & 0xff); this.writeDp((o + 1) & 0xff, v >> 8); }
  private fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  private fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  private push(v: number) { this.ram[0x100 | this.sp] = v & 0xff; this.sp = (this.sp - 1) & 0xff; }
  private pop() { this.sp = (this.sp + 1) & 0xff; return this.ram[0x100 | this.sp]; }

  private psw() {
    return (this.n << 7) | (this.v << 6) | (this.p << 5) | (this.b << 4) | (this.h << 3) | (this.i << 2) | (this.z << 1) | this.c;
  }
  private setPsw(f: number) {
    this.n = (f >> 7) & 1; this.v = (f >> 6) & 1; this.p = (f >> 5) & 1; this.b = (f >> 4) & 1;
    this.h = (f >> 3) & 1; this.i = (f >> 2) & 1; this.z = (f >> 1) & 1; this.c = f & 1;
  }
  private nz(v: number) { v &= 0xff; this.n = v >> 7; this.z = v === 0 ? 1 : 0; return v; }
  private nz16(v: number) { v &= 0xffff; this.n = v >> 15; this.z = v === 0 ? 1 : 0; return v; }

  // ---------- ALU ----------

  private adc(a: number, b: number) {
    const r = a + b + this.c;
    this.h = ((a & 0x0f) + (b & 0x0f) + this.c) > 0x0f ? 1 : 0;
    this.v = (~(a ^ b) & (a ^ r) & 0x80) ? 1 : 0;
    this.c = r > 0xff ? 1 : 0;
    return this.nz(r);
  }
  private sbc(a: number, b: number) { return this.adc(a, b ^ 0xff); }
  private cmp(a: number, b: number) { const r = a - b; this.c = r >= 0 ? 1 : 0; this.nz(r); }
  private asl(v: number) { this.c = (v >> 7) & 1; return this.nz(v << 1); }
  private lsr(v: number) { this.c = v & 1; return this.nz(v >> 1); }
  private rol(v: number) { const c = this.c; this.c = (v >> 7) & 1; return this.nz((v << 1) | c); }
  private ror(v: number) { const c = this.c; this.c = v & 1; return this.nz((v >> 1) | (c << 7)); }

  /** ALU op by group: 0 OR, 1 AND, 2 EOR, 3 CMP, 4 ADC, 5 SBC. Returns the result (CMP: unchanged a). */
  private alu(g: number, a: number, b: number): number {
    switch (g) {
      case 0: return this.nz(a | b);
      case 1: return this.nz(a & b);
      case 2: return this.nz(a ^ b);
      case 3: this.cmp(a, b); return a;
      case 4: return this.adc(a, b);
      default: return this.sbc(a, b);
    }
  }

  private branch(cond: boolean) {
    const rel = (this.fetch() << 24) >> 24;
    if (cond) { this.pc = (this.pc + rel) & 0xffff; this.cycles += 2; }
  }

  /** mem.bit operand: 13-bit address, 3-bit bit number. */
  private memBit(): [number, number] {
    const w = this.fetch16();
    return [w & 0x1fff, w >> 13];
  }

  // ---------- CPU ----------

  private runCycles(n: number) {
    let budget = n;
    while (budget > 0) {
      const before = this.cycles;
      if (this.stopped) this.cycles += 2;
      else this.step();
      const used = Math.max(2, this.cycles - before);
      this.cycles = before + used;
      budget -= used;
      this.tickTimers(used);
    }
  }

  private tickTimers(cycles: number) {
    for (let t = 0; t < 3; t++) {
      if (!this.timerOn[t]) continue;
      const period = t === 2 ? 16 : 128;
      this.timerStage[t] += cycles;
      while (this.timerStage[t] >= period) {
        this.timerStage[t] -= period;
        const target = this.timerTarget[t] || 256;
        this.timerSub[t] = (this.timerSub[t] + 1) % target;
        if (this.timerSub[t] === 0) this.timerCount[t] = (this.timerCount[t] + 1) & 0x0f;
      }
    }
  }
  private timerSub = [0, 0, 0];

  private step() {
    const op = this.fetch();
    this.cycles += 2;
    const lo = op & 0x0f, hi = op >> 4;

    // The six ALU groups share a layout: rows 0x0-0xB, columns 4-9 / 0x14-0x19.
    if (hi < 0xc && (lo >= 4 && lo <= 9)) {
      const g = hi >> 1, odd = hi & 1;
      if (!odd) {
        switch (lo) {
          case 4: { const v = this.readDp(this.fetch()); this.a = this.alu(g, this.a, v); this.cycles += 1; return; }
          case 5: { const v = this.read(this.fetch16()); this.a = this.alu(g, this.a, v); this.cycles += 2; return; }
          case 6: { const v = this.readDp(this.x); this.a = this.alu(g, this.a, v); this.cycles += 1; return; }
          case 7: { const o = this.fetch(); const v = this.read(this.readDp16((o + this.x) & 0xff)); this.a = this.alu(g, this.a, v); this.cycles += 4; return; }
          case 8: { const v = this.fetch(); this.a = this.alu(g, this.a, v); return; }
          case 9: { // dp, dp (dest, src) encoded src then dest
            const s = this.readDp(this.fetch()), dAddr = this.fetch();
            const r = this.alu(g, this.readDp(dAddr), s);
            if (g !== 3) this.writeDp(dAddr, r);
            this.cycles += 4; return;
          }
        }
      } else {
        switch (lo) {
          case 4: { const v = this.readDp((this.fetch() + this.x) & 0xff); this.a = this.alu(g, this.a, v); this.cycles += 2; return; }
          case 5: { const v = this.read((this.fetch16() + this.x) & 0xffff); this.a = this.alu(g, this.a, v); this.cycles += 3; return; }
          case 6: { const v = this.read((this.fetch16() + this.y) & 0xffff); this.a = this.alu(g, this.a, v); this.cycles += 3; return; }
          case 7: { const o = this.fetch(); const v = this.read((this.readDp16(o) + this.y) & 0xffff); this.a = this.alu(g, this.a, v); this.cycles += 4; return; }
          case 8: { // dp, #imm
            const imm = this.fetch(), dAddr = this.fetch();
            const r = this.alu(g, this.readDp(dAddr), imm);
            if (g !== 3) this.writeDp(dAddr, r);
            this.cycles += 3; return;
          }
          case 9: { // (X), (Y)
            const s = this.readDp(this.y);
            const r = this.alu(g, this.readDp(this.x), s);
            if (g !== 3) this.writeDp(this.x, r);
            this.cycles += 3; return;
          }
        }
      }
    }

    // SET1 / CLR1 dp.n and BBS / BBC dp.n.
    if (lo === 2) {
      const bit = hi >> 1, o = this.fetch(), v = this.readDp(o);
      this.writeDp(o, hi & 1 ? v & ~(1 << bit) : v | (1 << bit));
      this.cycles += 2; return;
    }
    if (lo === 3) {
      const bit = hi >> 1, o = this.fetch(), v = this.readDp(o);
      const set = !!(v & (1 << bit));
      this.cycles += 3;
      this.branch(hi & 1 ? !set : set); return;
    }
    // TCALL n.
    if (lo === 1) {
      this.push(this.pc >> 8); this.push(this.pc);
      this.pc = this.read16(0xffde - hi * 2);
      this.cycles += 6; return;
    }

    switch (op) {
      case 0x00: return;
      case 0x0a: { const [a, b] = this.memBit(); this.c |= (this.read(a) >> b) & 1; this.cycles += 3; return; }
      case 0x2a: { const [a, b] = this.memBit(); this.c |= ((this.read(a) >> b) & 1) ^ 1; this.cycles += 3; return; }
      case 0x4a: { const [a, b] = this.memBit(); this.c &= (this.read(a) >> b) & 1; this.cycles += 2; return; }
      case 0x6a: { const [a, b] = this.memBit(); this.c &= ((this.read(a) >> b) & 1) ^ 1; this.cycles += 2; return; }
      case 0x8a: { const [a, b] = this.memBit(); this.c ^= (this.read(a) >> b) & 1; this.cycles += 3; return; }
      case 0xaa: { const [a, b] = this.memBit(); this.c = (this.read(a) >> b) & 1; this.cycles += 2; return; }
      case 0xca: { const [a, b] = this.memBit(); const v = this.read(a); this.write(a, this.c ? v | (1 << b) : v & ~(1 << b)); this.cycles += 4; return; }
      case 0xea: { const [a, b] = this.memBit(); this.write(a, this.read(a) ^ (1 << b)); this.cycles += 3; return; }

      // Shifts / INC / DEC on memory and A.
      case 0x0b: case 0x2b: case 0x4b: case 0x6b: case 0x8b: case 0xab: { const o = this.fetch(); this.writeDp(o, this.rmw(op, this.readDp(o))); this.cycles += 2; return; }
      case 0x0c: case 0x2c: case 0x4c: case 0x6c: case 0x8c: case 0xac: { const a = this.fetch16(); this.write(a, this.rmw(op, this.read(a))); this.cycles += 3; return; }
      case 0x1b: case 0x3b: case 0x5b: case 0x7b: case 0x9b: case 0xbb: { const o = (this.fetch() + this.x) & 0xff; this.writeDp(o, this.rmw(op, this.readDp(o))); this.cycles += 3; return; }
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0x9c: case 0xbc: this.a = this.rmw(op, this.a); return;
      case 0x1d: this.x = this.nz(this.x - 1); return;
      case 0x3d: this.x = this.nz(this.x + 1); return;
      case 0xdc: this.y = this.nz(this.y - 1); return;
      case 0xfc: this.y = this.nz(this.y + 1); return;

      case 0x0d: this.push(this.psw()); this.cycles += 2; return;
      case 0x2d: this.push(this.a); this.cycles += 2; return;
      case 0x4d: this.push(this.x); this.cycles += 2; return;
      case 0x6d: this.push(this.y); this.cycles += 2; return;
      case 0x8e: this.setPsw(this.pop()); this.cycles += 2; return;
      case 0xae: this.a = this.pop(); this.cycles += 2; return;
      case 0xce: this.x = this.pop(); this.cycles += 2; return;
      case 0xee: this.y = this.pop(); this.cycles += 2; return;

      case 0x0e: case 0x4e: { // TSET1 / TCLR1 !abs
        const a = this.fetch16(), v = this.read(a);
        this.nz(this.a - v);
        this.write(a, op === 0x0e ? v | this.a : v & ~this.a);
        this.cycles += 4; return;
      }
      case 0x0f: { // BRK
        this.push(this.pc >> 8); this.push(this.pc); this.push(this.psw());
        this.b = 1; this.i = 0; this.pc = this.read16(0xffde); this.cycles += 6; return;
      }
      case 0x10: this.branch(!this.n); return;
      case 0x30: this.branch(!!this.n); return;
      case 0x50: this.branch(!this.v); return;
      case 0x70: this.branch(!!this.v); return;
      case 0x90: this.branch(!this.c); return;
      case 0xb0: this.branch(!!this.c); return;
      case 0xd0: this.branch(!this.z); return;
      case 0xf0: this.branch(!!this.z); return;
      case 0x2f: this.branch(true); return;

      case 0x1a: { const o = this.fetch(); this.writeDp16(o, this.nz16(this.readDp16(o) - 1)); this.cycles += 4; return; }
      case 0x3a: { const o = this.fetch(); this.writeDp16(o, this.nz16(this.readDp16(o) + 1)); this.cycles += 4; return; }
      case 0x1e: { const v = this.read(this.fetch16()); this.cmp(this.x, v); this.cycles += 2; return; }
      case 0x3e: { const v = this.readDp(this.fetch()); this.cmp(this.x, v); this.cycles += 1; return; }
      case 0x5e: { const v = this.read(this.fetch16()); this.cmp(this.y, v); this.cycles += 2; return; }
      case 0x7e: { const v = this.readDp(this.fetch()); this.cmp(this.y, v); this.cycles += 1; return; }
      case 0xc8: this.cmp(this.x, this.fetch()); return;
      case 0xad: this.cmp(this.y, this.fetch()); return;

      case 0x1f: { const a = (this.fetch16() + this.x) & 0xffff; this.pc = this.read16(a); this.cycles += 4; return; }
      case 0x5f: this.pc = this.fetch16(); this.cycles += 1; return;
      case 0x3f: { const a = this.fetch16(); this.push(this.pc >> 8); this.push(this.pc); this.pc = a; this.cycles += 6; return; }
      case 0x4f: { const o = this.fetch(); this.push(this.pc >> 8); this.push(this.pc); this.pc = 0xff00 | o; this.cycles += 4; return; }
      case 0x6f: { const l = this.pop(); this.pc = l | (this.pop() << 8); this.cycles += 3; return; }
      case 0x7f: { this.setPsw(this.pop()); const l = this.pop(); this.pc = l | (this.pop() << 8); this.cycles += 4; return; }

      case 0x20: this.p = 0; return;
      case 0x40: this.p = 1; return;
      case 0x60: this.c = 0; return;
      case 0x80: this.c = 1; return;
      case 0xa0: this.i = 1; this.cycles += 1; return;
      case 0xc0: this.i = 0; this.cycles += 1; return;
      case 0xe0: this.v = 0; this.h = 0; return;
      case 0xed: this.c ^= 1; this.cycles += 1; return;

      case 0x2e: { const v = this.readDp(this.fetch()); this.cycles += 3; const rel = (this.fetch() << 24) >> 24; if (v !== this.a) { this.pc = (this.pc + rel) & 0xffff; this.cycles += 2; } return; }
      case 0xde: { const v = this.readDp((this.fetch() + this.x) & 0xff); this.cycles += 4; const rel = (this.fetch() << 24) >> 24; if (v !== this.a) { this.pc = (this.pc + rel) & 0xffff; this.cycles += 2; } return; }
      case 0x6e: { const o = this.fetch(); const v = (this.readDp(o) - 1) & 0xff; this.writeDp(o, v); this.cycles += 3; const rel = (this.fetch() << 24) >> 24; if (v) { this.pc = (this.pc + rel) & 0xffff; this.cycles += 2; } return; }
      case 0xfe: { this.y = (this.y - 1) & 0xff; this.cycles += 2; const rel = (this.fetch() << 24) >> 24; if (this.y) { this.pc = (this.pc + rel) & 0xffff; this.cycles += 2; } return; }

      case 0x5a: { const v = this.readDp16(this.fetch()); const ya = (this.y << 8) | this.a; const r = ya - v; this.c = r >= 0 ? 1 : 0; this.nz16(r); this.cycles += 2; return; }
      case 0x7a: case 0x9a: {
        const v = this.readDp16(this.fetch()), ya = (this.y << 8) | this.a;
        const b = op === 0x7a ? v : (~v & 0xffff), cin = op === 0x7a ? 0 : 1;
        const r = ya + b + cin;
        this.v = (~(ya ^ b) & (ya ^ r) & 0x8000) ? 1 : 0;
        this.h = ((ya & 0xfff) + (b & 0xfff) + cin) > 0xfff ? 1 : 0;
        this.c = r > 0xffff ? 1 : 0;
        const res = this.nz16(r);
        this.a = res & 0xff; this.y = res >> 8; this.cycles += 3; return;
      }
      case 0xba: { const v = this.readDp16(this.fetch()); this.a = v & 0xff; this.y = v >> 8; this.nz16(v); this.cycles += 3; return; }
      case 0xda: { const o = this.fetch(); this.writeDp16(o, (this.y << 8) | this.a); this.cycles += 3; return; }

      case 0x5d: this.x = this.nz(this.a); return;
      case 0x7d: this.a = this.nz(this.x); return;
      case 0xdd: this.a = this.nz(this.y); return;
      case 0xfd: this.y = this.nz(this.a); return;
      case 0x9d: this.x = this.nz(this.sp); return;
      case 0xbd: this.sp = this.x; return;

      case 0x8d: this.y = this.nz(this.fetch()); return;
      case 0xcd: this.x = this.nz(this.fetch()); return;
      case 0xe8: this.a = this.nz(this.fetch()); return;
      case 0x8f: { const imm = this.fetch(); this.writeDp(this.fetch(), imm); this.cycles += 3; return; }
      case 0xfa: { const v = this.readDp(this.fetch()); this.writeDp(this.fetch(), v); this.cycles += 3; return; }

      case 0x9e: { // DIV YA, X
        const ya = (this.y << 8) | this.a;
        this.v = this.y >= this.x ? 1 : 0;
        this.h = (this.y & 15) >= (this.x & 15) ? 1 : 0;
        if (this.y < (this.x << 1)) {
          this.a = Math.floor(ya / (this.x || 1)) & 0xff; this.y = this.x ? ya % this.x : 0;
          if (!this.x) { this.a = 0xff; this.y = ya & 0xff; }
        } else {
          this.a = (255 - Math.floor((ya - (this.x << 9)) / (256 - this.x))) & 0xff;
          this.y = (this.x + ((ya - (this.x << 9)) % (256 - this.x))) & 0xff;
        }
        this.nz(this.a); this.cycles += 10; return;
      }
      case 0xcf: { const r = this.y * this.a; this.a = r & 0xff; this.y = r >> 8; this.nz(this.y); this.cycles += 7; return; }
      case 0x9f: this.a = this.nz(((this.a >> 4) | (this.a << 4)) & 0xff); this.cycles += 3; return;
      case 0xbe: { // DAS
        if (!this.c || this.a > 0x99) { this.a = (this.a - 0x60) & 0xff; this.c = 0; }
        if (!this.h || (this.a & 15) > 9) this.a = (this.a - 6) & 0xff;
        this.nz(this.a); this.cycles += 1; return;
      }
      case 0xdf: { // DAA
        if (this.c || this.a > 0x99) { this.a = (this.a + 0x60) & 0xff; this.c = 1; }
        if (this.h || (this.a & 15) > 9) this.a = (this.a + 6) & 0xff;
        this.nz(this.a); this.cycles += 1; return;
      }

      // Stores.
      case 0xc4: this.writeDp(this.fetch(), this.a); this.cycles += 2; return;
      case 0xc5: this.write(this.fetch16(), this.a); this.cycles += 3; return;
      case 0xc6: this.writeDp(this.x, this.a); this.cycles += 2; return;
      case 0xc7: { const o = this.fetch(); this.write(this.readDp16((o + this.x) & 0xff), this.a); this.cycles += 5; return; }
      case 0xc9: this.write(this.fetch16(), this.x); this.cycles += 3; return;
      case 0xcb: this.writeDp(this.fetch(), this.y); this.cycles += 2; return;
      case 0xcc: this.write(this.fetch16(), this.y); this.cycles += 3; return;
      case 0xd4: this.writeDp((this.fetch() + this.x) & 0xff, this.a); this.cycles += 3; return;
      case 0xd5: this.write((this.fetch16() + this.x) & 0xffff, this.a); this.cycles += 4; return;
      case 0xd6: this.write((this.fetch16() + this.y) & 0xffff, this.a); this.cycles += 4; return;
      case 0xd7: { const o = this.fetch(); this.write((this.readDp16(o) + this.y) & 0xffff, this.a); this.cycles += 5; return; }
      case 0xd8: this.writeDp(this.fetch(), this.x); this.cycles += 2; return;
      case 0xd9: this.writeDp((this.fetch() + this.y) & 0xff, this.x); this.cycles += 3; return;
      case 0xdb: this.writeDp((this.fetch() + this.x) & 0xff, this.y); this.cycles += 3; return;
      case 0xaf: this.writeDp(this.x, this.a); this.x = (this.x + 1) & 0xff; this.cycles += 2; return;

      // Loads.
      case 0xe4: this.a = this.nz(this.readDp(this.fetch())); this.cycles += 1; return;
      case 0xe5: this.a = this.nz(this.read(this.fetch16())); this.cycles += 2; return;
      case 0xe6: this.a = this.nz(this.readDp(this.x)); this.cycles += 1; return;
      case 0xe7: { const o = this.fetch(); this.a = this.nz(this.read(this.readDp16((o + this.x) & 0xff))); this.cycles += 4; return; }
      case 0xe9: this.x = this.nz(this.read(this.fetch16())); this.cycles += 2; return;
      case 0xeb: this.y = this.nz(this.readDp(this.fetch())); this.cycles += 1; return;
      case 0xec: this.y = this.nz(this.read(this.fetch16())); this.cycles += 2; return;
      case 0xf4: this.a = this.nz(this.readDp((this.fetch() + this.x) & 0xff)); this.cycles += 2; return;
      case 0xf5: this.a = this.nz(this.read((this.fetch16() + this.x) & 0xffff)); this.cycles += 3; return;
      case 0xf6: this.a = this.nz(this.read((this.fetch16() + this.y) & 0xffff)); this.cycles += 3; return;
      case 0xf7: { const o = this.fetch(); this.a = this.nz(this.read((this.readDp16(o) + this.y) & 0xffff)); this.cycles += 4; return; }
      case 0xf8: this.x = this.nz(this.readDp(this.fetch())); this.cycles += 1; return;
      case 0xf9: this.x = this.nz(this.readDp((this.fetch() + this.y) & 0xff)); this.cycles += 2; return;
      case 0xfb: this.y = this.nz(this.readDp((this.fetch() + this.x) & 0xff)); this.cycles += 2; return;
      case 0xbf: this.a = this.nz(this.readDp(this.x)); this.x = (this.x + 1) & 0xff; this.cycles += 2; return;

      case 0xef: case 0xff: this.stopped = true; return;
      default: return;
    }
  }

  private rmw(op: number, v: number): number {
    switch (op >> 5) {
      case 0: return this.asl(v);
      case 1: return this.rol(v);
      case 2: return this.lsr(v);
      case 3: return this.ror(v);
      case 4: return this.nz(v - 1);
      default: return this.nz(v + 1);
    }
  }

  // ---------- DSP ----------

  private readDsp(r: number) {
    return this.dsp[r];
  }

  private writeDsp(r: number, v: number) {
    this.dsp[r] = v;
    if (r === 0x4c) this.konLatch |= v;
    else if (r === 0x7c) this.dsp[0x7c] = 0; // writing ENDX clears it
  }

  /** One 32 kHz stereo sample. */
  private sample(): [number, number] {
    const d = this.dsp, ram = this.ram;
    const flg = d[0x6c];
    // Key on / off (KON is acted on once, KOFF holds).
    if (this.konLatch) {
      for (let i = 0; i < 8; i++) {
        if (!(this.konLatch & (1 << i))) continue;
        const vc = this.voices[i];
        const dir = d[0x5d] << 8, src = d[i * 16 + 4];
        vc.brr = ram[(dir + src * 4) & 0xffff] | (ram[(dir + src * 4 + 1) & 0xffff] << 8);
        vc.pos = 0; vc.counter = 0; vc.env = 0; vc.envMode = Env.Attack; vc.envTimer = 0; vc.keyDelay = 5; vc.on = true;
        vc.buf.fill(0);
        this.decodeBlock(vc);
        d[0x7c] &= ~(1 << i);
      }
      this.konLatch = 0;
      d[0x4c] = 0;
    }
    const koff = d[0x5c];
    if (flg & 0x80) { for (const vc of this.voices) { vc.envMode = Env.Release; vc.env = 0; } }

    // Noise generator.
    const nRate = RATES[flg & 31];
    if (nRate && ++this.noiseTimer >= nRate) {
      this.noiseTimer = 0;
      const fb = (this.noise << 13) ^ (this.noise << 14);
      this.noise = ((fb & 0x4000) ^ (this.noise >> 1)) & 0x7fff;
    }

    let mainL = 0, mainR = 0, echoL = 0, echoR = 0;
    const non = d[0x3d], eon = d[0x4d], pmon = d[0x2d];
    let prevOut = 0;
    for (let i = 0; i < 8; i++) {
      const vc = this.voices[i], base = i * 16;
      if (koff & (1 << i)) vc.envMode = Env.Release;
      if (!vc.on) { prevOut = 0; d[base + 8] = 0; d[base + 9] = 0; continue; }
      if (vc.keyDelay > 0) { vc.keyDelay--; prevOut = 0; continue; }

      // Pitch (with modulation by the previous voice).
      let pitch = (d[base + 2] | (d[base + 3] << 8)) & 0x3fff;
      if (i > 0 && (pmon & (1 << i))) pitch += ((prevOut >> 5) * pitch) >> 10;

      // Interpolated sample, or noise.
      let s: number;
      if (non & (1 << i)) s = (this.noise << 17) >> 16;
      else {
        const idx = (vc.counter >> 4) & 0xff, p = vc.pos + 3;
        const b = vc.buf;
        s = (GAUSS[255 - idx] * b[p - 3]) >> 11;
        s += (GAUSS[511 - idx] * b[p - 2]) >> 11;
        s += (GAUSS[256 + idx] * b[p - 1]) >> 11;
        s += (GAUSS[idx] * b[p]) >> 11;
        s = clamp16(s) & ~1;
      }

      this.envelope(vc, base);
      const out = (s * vc.env) >> 11;
      prevOut = out;
      d[base + 8] = vc.env >> 4;
      d[base + 9] = (out >> 8) & 0xff;

      const vl = (out * (d[base] << 24 >> 24)) >> 7;
      const vr = (out * (d[base + 1] << 24 >> 24)) >> 7;
      mainL += vl; mainR += vr;
      if (eon & (1 << i)) { echoL += vl; echoR += vr; }

      // Advance through the sample.
      vc.counter += Math.min(pitch, 0x3fff);
      while (vc.counter >= 0x1000) {
        vc.counter -= 0x1000;
        vc.pos++;
        if (vc.pos >= 16) this.nextBlock(vc, i);
      }
      if (vc.envMode === Env.Release && vc.env === 0) vc.on = false;
    }

    // Echo: read the delayed sample, FIR filter, feed back and write the new one.
    const esa = d[0x6d] << 8, edl = d[0x7d] & 15, len = edl ? edl * 2048 : 4;
    const at = (esa + this.echoPos) & 0xffff;
    const inL = ((ram[at] | (ram[(at + 1) & 0xffff] << 8)) << 16 >> 16) >> 1;
    const inR = ((ram[(at + 2) & 0xffff] | (ram[(at + 3) & 0xffff] << 8)) << 16 >> 16) >> 1;
    const hp = this.echoHistPos = (this.echoHistPos + 1) & 7;
    this.echoHist[0][hp] = inL; this.echoHist[1][hp] = inR;
    let firL = 0, firR = 0;
    for (let t = 0; t < 8; t++) {
      const c = (d[t * 16 + 0x0f] << 24) >> 24;
      firL += (this.echoHist[0][(hp + t + 1) & 7] * c) >> 6;
      firR += (this.echoHist[1][(hp + t + 1) & 7] * c) >> 6;
    }
    firL = clamp16(firL); firR = clamp16(firR);
    if (!(flg & 0x20)) {
      const efb = (d[0x0d] << 24) >> 24;
      const wl = clamp16(echoL + ((firL * efb) >> 7)) & ~1, wr = clamp16(echoR + ((firR * efb) >> 7)) & ~1;
      ram[at] = wl & 0xff; ram[(at + 1) & 0xffff] = (wl >> 8) & 0xff;
      ram[(at + 2) & 0xffff] = wr & 0xff; ram[(at + 3) & 0xffff] = (wr >> 8) & 0xff;
    }
    this.echoPos += 4;
    if (this.echoPos >= len) this.echoPos = 0;

    const mvl = (d[0x0c] << 24) >> 24, mvr = (d[0x1c] << 24) >> 24;
    const evl = (d[0x2c] << 24) >> 24, evr = (d[0x3c] << 24) >> 24;
    let l = clamp16(((clamp16(mainL) * mvl) >> 7) + ((firL * evl) >> 7));
    let r = clamp16(((clamp16(mainR) * mvr) >> 7) + ((firR * evr) >> 7));
    if (flg & 0x40) l = r = 0;
    return [l, r];
  }

  private envelope(vc: Voice, base: number) {
    const d = this.dsp;
    const adsr1 = d[base + 5], adsr2 = d[base + 6], gain = d[base + 7];
    let rate = 0, step = 0;
    if (vc.envMode === Env.Release) {
      vc.env = Math.max(0, vc.env - 8);
      return;
    }
    if (adsr1 & 0x80) {
      switch (vc.envMode) {
        case Env.Attack: {
          const ar = adsr1 & 15;
          rate = ar * 2 + 1; step = ar === 15 ? 1024 : 32;
          if (this.tick(vc, rate)) vc.env += step;
          if (vc.env >= 0x7e0) { vc.env = Math.min(vc.env, 0x7ff); vc.envMode = Env.Decay; }
          return;
        }
        case Env.Decay: {
          rate = ((adsr1 >> 4) & 7) * 2 + 16;
          if (this.tick(vc, rate)) vc.env -= ((vc.env - 1) >> 8) + 1;
          if ((vc.env >> 8) <= (adsr2 >> 5)) vc.envMode = Env.Sustain;
          return;
        }
        case Env.Sustain: {
          rate = adsr2 & 31;
          if (this.tick(vc, rate)) vc.env -= ((vc.env - 1) >> 8) + 1;
          if (vc.env < 0) vc.env = 0;
          return;
        }
      }
    }
    // GAIN.
    if (!(gain & 0x80)) { vc.env = (gain & 0x7f) * 16; return; }
    rate = gain & 31;
    if (!this.tick(vc, rate)) return;
    switch ((gain >> 5) & 3) {
      case 0: vc.env -= 32; break;
      case 1: vc.env -= ((vc.env - 1) >> 8) + 1; break;
      case 2: vc.env += 32; break;
      case 3: vc.env += vc.env < 0x600 ? 32 : 8; break;
    }
    vc.env = Math.max(0, Math.min(0x7ff, vc.env));
  }

  /** Envelope step timing for `rate` (0-31). */
  private tick(vc: Voice, rate: number): boolean {
    const period = RATES[rate];
    if (!period) return false;
    if (++vc.envTimer >= period) { vc.envTimer = 0; return true; }
    return false;
  }

  /** Decodes the 16 samples of the BRR block at vc.brr into buf[3..18] (buf[0..2] keep the previous ones). */
  private decodeBlock(vc: Voice) {
    const ram = this.ram, b = vc.buf;
    b[0] = b[16]; b[1] = b[17]; b[2] = b[18];
    const head = ram[vc.brr & 0xffff], shift = head >> 4, filter = (head >> 2) & 3;
    // Samples are kept doubled (15-bit precision), as the hardware does.
    for (let k = 0; k < 16; k++) {
      const byte = ram[(vc.brr + 1 + (k >> 1)) & 0xffff];
      let s = ((k & 1 ? byte << 28 : byte << 24) >> 28);
      s = shift <= 12 ? (s << shift) >> 1 : (s < 0 ? -2048 : 0);
      const p1 = b[2 + k], p2 = b[1 + k] >> 1;
      switch (filter) {
        case 1: s += (p1 >> 1) + ((-p1) >> 5); break;
        case 2: s += p1 - p2 + (p2 >> 4) + ((p1 * -3) >> 6); break;
        case 3: s += p1 - p2 + ((p1 * -13) >> 7) + ((p2 * 3) >> 4); break;
      }
      s = clamp16(s);
      b[3 + k] = (s << 17) >> 16;
    }
  }

  private nextBlock(vc: Voice, i: number) {
    const ram = this.ram, head = ram[vc.brr & 0xffff];
    vc.pos = 0;
    if (head & 1) {
      // End of the sample: flag it, loop or stop.
      this.dsp[0x7c] |= 1 << i;
      if (head & 2) {
        const dir = this.dsp[0x5d] << 8, src = this.dsp[i * 16 + 4];
        vc.brr = ram[(dir + src * 4 + 2) & 0xffff] | (ram[(dir + src * 4 + 3) & 0xffff] << 8);
      } else {
        vc.envMode = Env.Release; vc.env = 0; vc.on = false;
        return;
      }
    } else vc.brr = (vc.brr + 9) & 0xffff;
    this.decodeBlock(vc);
  }
}

function clamp16(v: number) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}
