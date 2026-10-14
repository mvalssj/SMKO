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

/** Sound effects (port 1), as the game sends them. */
export const SFX = { coin: 0x24, itemBox: 0x2b, bump: 0x2d, skid: 0x2f } as const;

export class Sound {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private boot: { ram: Uint8Array; entry: number };
  private ports = [0, 0, 0, 0];
  /** One-shot values for ports 0 and 1: held for two frames, then cleared. */
  private pulse = [{ v: 0, n: 0 }, { v: 0, n: 0 }];
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

  /** Music command on port 0. */
  music(cmd: number) { this.pulse[0] = { v: cmd, n: 30 }; }

  /** Sound effect on port 1. */
  sfx(id: number) { this.pulse[1] = { v: id, n: 4 }; }

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
    const ports = [...this.pulse.map((p) => (p.n > 0 ? p.v : 0)), this.ports[2], this.ports[3]];
    for (const p of this.pulse) if (p.n > 0) p.n--;
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
