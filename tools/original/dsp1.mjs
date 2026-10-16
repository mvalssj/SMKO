// A DSP-1 command interface (analysis only): commands are bytes, parameters and results 16-bit words,
// low byte first. `ops[cmd]` computes results from parameters (all int16); unknown ones answer zeros.
// Parameter / result counts per command, from the published DSP-1 command list.
const IO = {
  0x00: [2, 1], 0x20: [2, 1], 0x10: [2, 2], 0x04: [2, 2], 0x08: [3, 2], 0x18: [4, 1], 0x38: [4, 1], 0x28: [3, 1],
  0x0c: [3, 2], 0x1c: [6, 3], 0x02: [7, 4], 0x0a: [1, 4], 0x06: [3, 3], 0x0e: [2, 2],
  0x01: [4, 0], 0x11: [4, 0], 0x21: [4, 0], 0x0d: [3, 3], 0x1d: [3, 3], 0x2d: [3, 3], 0x03: [3, 3], 0x13: [3, 3], 0x23: [3, 3],
  0x0b: [3, 1], 0x1b: [3, 1], 0x2b: [3, 1], 0x14: [6, 3], 0x0f: [1, 1], 0x2f: [1, 1],
};
const s16 = (v) => (v << 16) >> 16;

export class Dsp1 {
  constructor(ops = {}) {
    this.ops = ops;
    this.state = 'cmd'; this.cmd = -1; this.params = []; this.out = []; this.half = null; this.outByte = null;
    this.log = new Map();
    this.trace = null; // set to [] to record [cmd, params, results]
  }
  write(b) {
    if (this.state !== 'params') { this.start(b); return; }
    if (this.half === null) { this.half = b; return; }
    this.params.push(s16(this.half | (b << 8)));
    this.half = null;
    if (this.params.length === this.need) this.exec();
  }
  start(cmd) {
    this.cmd = cmd;
    const io = IO[cmd] ?? [0, 0];
    this.need = io[0]; this.nout = io[1];
    this.params = []; this.out = []; this.outByte = null; this.half = null;
    this.log.set(cmd, (this.log.get(cmd) ?? 0) + 1);
    this.state = 'params';
    if (this.need === 0) this.exec();
  }
  exec() {
    const f = this.ops[this.cmd];
    const res = f ? f(this.params, this) : new Array(this.nout).fill(0);
    if (this.trace && this.trace.length < 200000) this.trace.push([this.cmd, this.params.slice(), res.slice()]);
    this.out = res.map((v) => v & 0xffff);
    this.state = 'out';
  }
  read() {
    if (this.outByte !== null) { const b = this.outByte; this.outByte = null; return b; }
    // Raster keeps answering, line after line, until the next command.
    if (!this.out.length && this.state === 'out' && this.cmd === 0x0a && this.ops.raster) this.out = this.ops.raster(this).map((v) => v & 0xffff);
    const w = this.out.length ? this.out.shift() : 0x0080;
    this.outByte = (w >> 8) & 0xff;
    return w & 0xff;
  }
}
