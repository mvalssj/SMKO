// AudioWorklet running the SNES sound unit: the game's driver plays music and effects as the main thread
// sets the four ports, like the SNES CPU does once per frame.

import { SPC_RATE, Spc } from './spc';

type Msg =
  | { type: 'boot'; ram: Uint8Array; entry: number }
  | { type: 'load'; addr: number; data: Uint8Array }
  | { type: 'ports'; ports: number[] }
  | { type: 'stat' };

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class SpcProcessor extends AudioWorkletProcessor {
  private spc: Spc | null = null;
  /** Rendered 32 kHz samples waiting to be resampled to the context rate. */
  private buf = new Float32Array(4096);
  private have = 0;
  private pos = 0;
  private step = SPC_RATE / sampleRate;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (m.type === 'boot') {
        this.spc = new Spc();
        this.spc.load(0, m.ram);
        this.spc.start(m.entry);
      } else if (m.type === 'load') this.spc?.load(m.addr, m.data);
      else if (m.type === 'ports' && this.spc) m.ports.forEach((v, i) => { this.spc!.portIn[i] = v & 0xff; });
      else if (m.type === 'stat') this.port.postMessage({ type: 'stat', spc: !!this.spc, have: this.have, ports: this.spc ? [...this.spc.portIn] : [] });
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const left = out[0], right = out[1] ?? out[0];
    if (!this.spc) { left.fill(0); right.fill(0); return true; }
    for (let i = 0; i < left.length; i++) {
      // Linear resampling from 32 kHz.
      while (this.pos + 1 >= this.have) this.refill();
      const k = Math.floor(this.pos), f = this.pos - k;
      left[i] = this.buf[k * 2] * (1 - f) + this.buf[k * 2 + 2] * f;
      right[i] = this.buf[k * 2 + 1] * (1 - f) + this.buf[k * 2 + 3] * f;
      this.pos += this.step;
    }
    return true;
  }

  /** Keeps the last sample, renders 256 more. */
  private refill() {
    const k = Math.floor(this.pos);
    const keep = this.have - k;
    this.buf.copyWithin(0, k * 2, this.have * 2);
    this.pos -= k;
    const n = 256;
    const fresh = new Float32Array(n * 2);
    this.spc!.render(fresh, n);
    this.buf.set(fresh, keep * 2);
    this.have = keep + n;
  }
}

registerProcessor('spc', SpcProcessor);
