// Music and sound of the original, played by the game's own sound driver (SPC700 code and samples from the
// user's ROM) in an AudioWorklet. Found by tracing the game: the driver and samples are uploaded at boot from
// the list at $82:8000; each screen then loads its song set at $D000 (one per course theme, one for the
// menus); the CPU talks to the driver through 4 ports once per frame:
//   port 0: music commands, port 1: sound effects, port 2: player 1's engine (speed / 16), port 3: player 2's.

import { decompress } from '../rom/decompress';
import type { SmkRom } from '../rom/rom';
import workletUrl from './worklet.ts?worker&url';

/** Song set pointers (3 bytes each) and the theme -> set table (16-bit, indexed by theme * 2). */
const SONG_SETS = 0x1f47e;
const THEME_SETS = 0x1f46d;
const MENU_SET = 0x00;
/** Boot upload list (driver + samples), read in 32 KB halves from bank $82. */
const BOOT_BANK = 2;
/** The game sends its first command ~85 frames after the upload; the driver needs a moment to set up. */
const DRIVER_SETUP_FRAMES = 40;

/** Music commands (port 0) of the course song sets and the menu set. */
export const MUSIC = {
  /** Menu set. */
  menu: 4,
  /** Course sets. */
  intro: 1, raceStart: 3, race: 4, finalLapFanfare: 5, finalLap: 7, star: 8, finish: 9, afterRace: 12,
  /** Fades the music out. */
  fade: 0x1e,
  /** Effects sent on the music port (the game raises them from kart flags): lightning. */
  lightning: 0x61,
} as const;

/**
 * Sound effects as the game sends them (caught with watchpoints on the game's sound queues while each event
 * happened in the original): port 0 shares the music's queue, port 1 is a separate channel.
 */
export const SFX0 = { coin: 0x20, hop: 0x21, featherJump: 0x24, land: 0x25, shell: 0x2b, mushroom: 0x48, bump: 0x4d, boo: 0x57 } as const;
/** Port 1 is a channel of continuous sounds: one plays until another id, or 0x2F (stop). */
export const LOOP = { spin: 0x24, itemBox: 0x2b, brake: 0xa0, offroad: 0x2d, stop: 0x2f } as const;

export class Sound {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private boot: { ram: Uint8Array; entry: number };
  private ports = [0, 0, 0, 0];
  /** One-shot values for ports 0 and 1: held for two frames, then cleared. */
  /** Port 0 queue (music commands and effects, one at a time, like the game's queue) and port 1's value. */
  private queue: { v: number; n: number }[] = [];
  private pulse1 = { v: 0, n: 0 };
  private set = -1;
  private starting: Promise<void> | null = null;
  /** Frames since the driver started: it ignores commands while it sets itself up. */
  private sinceBoot = 0;
  muted = false;

  constructor(private rom: SmkRom) {
    this.boot = bootImage(rom.data);
  }

  /** Starts audio (call from a user gesture: browsers only allow sound after one). */
  start(): Promise<void> {
    this.starting ??= (async () => {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'spc', { outputChannelCount: [2] });
      const gain = ctx.createGain();
      gain.gain.value = this.muted ? 0 : 0.9;
      node.connect(gain).connect(ctx.destination);
      node.port.postMessage({ type: 'boot', ram: this.boot.ram, entry: this.boot.entry });
      this.ctx = ctx; this.node = node; this.gain = gain;
      if (this.set >= 0) { const s = this.set; this.set = -1; this.loadSet(s); }
    })().catch(() => { this.starting = null; });
    return this.starting;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : 0.9;
  }

  /** Song set of the menus. */
  menu() { this.loadSet(MENU_SET); }

  /** Song set of a course theme (Track.theme). */
  course(theme: number) {
    const d = this.rom.data;
    this.loadSet(d[THEME_SETS + theme * 2] | (d[THEME_SETS + theme * 2 + 1] << 8));
  }

  /**
   * Frames between a command and hearing it (the browser's audio buffers): music cues are sent this much early
   * so the start lights' beeps land where they do on the console.
   */
  get leadFrames() {
    const c = this.ctx;
    return c ? Math.round(((c.baseLatency || 0) + (c.outputLatency || 0)) * 60) : 0;
  }

  /** Music command on port 0. */
  music(cmd: number) { this.queue.push({ v: cmd, n: 4 }); }

  /** Sound effect on port 0 (the music's queue). */
  sfx0(id: number) { if (this.queue.length < 8) this.queue.push({ v: id, n: 2 }); }

  /** Sound effect on port 1. */
  sfx(id: number) { this.pulse1 = { v: id, n: 4 }; }

  /** The continuous sound on port 1 (null = none): sent when it changes. */
  loop(id: number | null) {
    const v = id ?? LOOP.stop;
    if (v === this.loopNow) return;
    this.loopNow = v;
    this.sfx(v);
  }
  private loopNow: number = LOOP.stop;

  /** Engine pitch of player 1 / 2 (ports 2 and 3): 0 = off, about speed / 16 (game units). */
  engine(p1: number, p2 = 0) {
    this.ports[2] = Math.max(0, Math.min(0x7f, Math.round(p1)));
    this.ports[3] = Math.max(0, Math.min(0x7f, Math.round(p2)));
  }

  /** Once per frame: sends the ports to the driver. */
  frame() {
    if (!this.node) return;
    if (++this.sinceBoot < DRIVER_SETUP_FRAMES) return;
    // Commands stay on the port for a while (the game holds them until the driver answers), then back to 0.
    const head = this.queue[0];
    const ports = [head ? head.v : 0, this.pulse1.n > 0 ? this.pulse1.v : 0, this.ports[2], this.ports[3]];
    if (head && --head.n <= 0) this.queue.shift();
    if (this.pulse1.n > 0) this.pulse1.n--;
    this.node.port.postMessage({ type: 'ports', ports });
  }

  private loadSet(index: number) {
    if (index === this.set) return;
    this.set = index;
    if (!this.node) return;
    const d = this.rom.data, at = SONG_SETS + index;
    const set = decompress(d, ((d[at + 2] & 0x0f) << 16) | d[at] | (d[at + 1] << 8));
    const len = set[0] | (set[1] << 8), addr = set[2] | (set[3] << 8);
    // Silence the driver, then put the new songs in place (the game uploads them through the driver).
    this.node.port.postMessage({ type: 'ports', ports: [MUSIC.fade, 0, 0, 0] });
    this.node.port.postMessage({ type: 'load', addr, data: set.slice(4, 4 + len) });
  }
}

/** RAM image after the boot upload, and the driver's entry point. */
function bootImage(rom: Uint8Array): { ram: Uint8Array; entry: number } {
  const ram = new Uint8Array(0x10000);
  let bank = BOOT_BANK, off = 0x8000;
  const rd = () => { const v = rom[(bank << 16) | off]; if (++off === 0x10000) { bank++; off = 0x8000; } return v; };
  const r16 = () => rd() | (rd() << 8);
  for (let guard = 0; guard < 64; guard++) {
    const len = r16(), addr = r16();
    if (!len) return { ram, entry: addr };
    for (let i = 0; i < len; i++) ram[(addr + i) & 0xffff] = rd();
  }
  return { ram, entry: 0x0800 };
}
