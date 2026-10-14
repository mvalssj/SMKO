// Screen brightness between screens, like the SNES's master brightness (16 levels): a black layer over the
// page whose opacity steps through the same levels. Durations are in frames (60 per second), measured in
// the original (see FADES).

const el = () => document.getElementById('fade') as HTMLElement;

/** Measured in the original (frames): fades take ~37 frames for the 16 levels. */
export const FADES = {
  /** Power on / ROM loaded: the title comes up. */
  titleIn: 37,
  /** "IS THIS OK? YES" -> character select. */
  toSelect: { out: 37, black: 23, in: 37 },
  /** Driver confirmed: the OK shows, then -> cup select. */
  toCup: { wait: 64, out: 37, black: 20, in: 35 },
  /** Cup / course chosen -> race (the black is the game loading the course). */
  toRace: { out: 35, black: 115, in: 90 },
  /** Race over -> results boards, boards -> next race. */
  toBoards: { out: 37, black: 20, in: 37 },
} as const;

let level = 15;
let job = 0;

function set(l: number) {
  level = Math.max(0, Math.min(15, Math.round(l)));
  const e = typeof document === 'undefined' ? null : el();
  if (e) e.style.opacity = String(1 - level / 15);
}

function frames(n: number, each: (i: number) => void): Promise<void> {
  const id = ++job;
  return new Promise((resolve) => {
    if (n <= 0) { resolve(); return; }
    const t0 = performance.now();
    const tick = () => {
      if (id !== job) { resolve(); return; }
      const i = Math.min(n, (performance.now() - t0) / (1000 / 60));
      each(i);
      if (i >= n) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

/** Darkens to black over `n` frames. */
export function fadeOut(n: number) {
  const from = level;
  return frames(n, (i) => set(from * (1 - i / n)));
}

/** Brightens from black over `n` frames. */
export function fadeIn(n: number) {
  set(0);
  return frames(n, (i) => set((15 * i) / n));
}

/** Stays as it is for `n` frames. */
export function hold(n: number) {
  return frames(n, () => {});
}

/** Black at once (e.g. a screen that starts dark). */
export function black() {
  ++job;
  set(0);
}

/** Full brightness at once. */
export function bright() {
  ++job;
  set(15);
}

/** Out, black for a moment, then `between()` (switch screens) and back in. */
export async function transition(t: { out: number; black: number; in: number; wait?: number }, between: () => void) {
  if (typeof document === 'undefined') { between(); return; }
  if (t.wait) await hold(t.wait);
  await fadeOut(t.out);
  await hold(t.black);
  between();
  await fadeIn(t.in);
}
