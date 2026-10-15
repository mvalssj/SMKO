// Gamepads and the on-screen touch controls. Both are turned into the keyboard's keys (synthetic key events
// on the window), so the menus, races and boards need no code of their own for them. The layout follows the
// SNES pad: B accelerates / confirms, Y brakes / goes back, A and X use the item, L and R hop.

/** SNES button -> the key it stands for. */
const SNES: Record<string, string> = {
  B: 'KeyX', Y: 'KeyZ', A: 'KeyE', X: 'KeyE', L: 'ShiftLeft', R: 'ShiftLeft', START: 'Enter',
};

/**
 * Standard gamepad layout (https://w3c.github.io/gamepad/#remapping) -> SNES button, by position: the bottom
 * face button is B, right A, left Y, top X; the triggers also accelerate (RT) and brake (LT).
 */
const PAD_BUTTONS: Record<number, string> = { 0: 'B', 1: 'A', 2: 'Y', 3: 'X', 4: 'L', 5: 'R', 6: 'Y', 7: 'B', 9: 'START' };
const PAD_DIRS: Record<number, string> = { 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight' };
const STICK_DEADZONE = 0.5;

/** Keys held by each source; their union is what the page sees. */
const sources = { pad: new Set<string>(), touch: new Set<string>() };
let held = new Set<string>();

function sync() {
  const now = new Set([...sources.pad, ...sources.touch]);
  for (const code of held) if (!now.has(code)) send('keyup', code);
  for (const code of now) if (!held.has(code)) send('keydown', code);
  held = now;
}

function send(type: 'keydown' | 'keyup', code: string) {
  // `key` is the code itself, so the room-code screen does not take it for a typed letter.
  dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
}

// ---------- Gamepad ----------

function pollPads() {
  const now = new Set<string>();
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad) continue;
    pad.buttons.forEach((b, i) => {
      if (!b.pressed) return;
      if (PAD_BUTTONS[i]) now.add(SNES[PAD_BUTTONS[i]]);
      if (PAD_DIRS[i]) now.add(PAD_DIRS[i]);
    });
    const [x = 0, y = 0] = pad.axes;
    if (x < -STICK_DEADZONE) now.add('ArrowLeft');
    if (x > STICK_DEADZONE) now.add('ArrowRight');
    if (y < -STICK_DEADZONE) now.add('ArrowUp');
    if (y > STICK_DEADZONE) now.add('ArrowDown');
  }
  if (now.size !== sources.pad.size || [...now].some((c) => !sources.pad.has(c))) {
    sources.pad = now;
    sync();
  }
}

let padLoop = 0;
function startPads() {
  if (padLoop) return;
  const loop = () => {
    pollPads();
    padLoop = (navigator.getGamepads?.() ?? []).some(Boolean) ? requestAnimationFrame(loop) : 0;
  };
  loop();
}

// ---------- Touch ----------

/** Which control each finger is on: the D-pad or a button. */
const fingers = new Map<number, { el: HTMLElement; keys: string[] }>();

function dpadKeys(el: HTMLElement, x: number, y: number): string[] {
  const r = el.getBoundingClientRect();
  const dx = (x - (r.left + r.width / 2)) / (r.width / 2);
  const dy = (y - (r.top + r.height / 2)) / (r.height / 2);
  if (Math.hypot(dx, dy) < 0.2) return [];
  // Eight directions, 45 degrees each (diagonals press two arrows).
  const dir = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
  return [['ArrowRight'], ['ArrowRight', 'ArrowDown'], ['ArrowDown'], ['ArrowDown', 'ArrowLeft'],
    ['ArrowLeft'], ['ArrowLeft', 'ArrowUp'], ['ArrowUp'], ['ArrowUp', 'ArrowRight']][dir];
}

function fingerKeys(start: HTMLElement, x: number, y: number): { el: HTMLElement; keys: string[] } {
  if (start.classList.contains('dpad')) return { el: start, keys: dpadKeys(start, x, y) };
  // Buttons: the finger may slide from one to the next (B to A, like on the pad).
  const over = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-btn]');
  const el = over ?? start;
  return { el, keys: over ? [SNES[over.dataset.btn!]] : [] };
}

function refreshTouch() {
  const now = new Set<string>();
  for (const f of fingers.values()) for (const k of f.keys) now.add(k);
  document.querySelectorAll<HTMLElement>('#touch [data-btn]').forEach((b) => {
    b.classList.toggle('down', [...fingers.values()].some((f) => f.el === b && f.keys.length > 0));
  });
  sources.touch = now;
  sync();
}

function setupTouch(root: HTMLElement) {
  const starts = new Map<number, HTMLElement>();
  root.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.dpad, [data-btn]');
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    starts.set(e.pointerId, el);
    fingers.set(e.pointerId, fingerKeys(el, e.clientX, e.clientY));
    refreshTouch();
  });
  root.addEventListener('pointermove', (e) => {
    const el = starts.get(e.pointerId);
    if (!el) return;
    fingers.set(e.pointerId, fingerKeys(el, e.clientX, e.clientY));
    refreshTouch();
  });
  const up = (e: PointerEvent) => {
    if (!starts.delete(e.pointerId)) return;
    fingers.delete(e.pointerId);
    refreshTouch();
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  root.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** Phones and tablets get the on-screen pad (also after the first touch on any device). */
function showTouch() {
  document.body.classList.add('touch');
}

// ---------- Setup ----------

export function setupControls(toast: (text: string) => void) {
  const root = document.getElementById('touch');
  if (root) setupTouch(root);
  if (matchMedia('(pointer: coarse)').matches) showTouch();
  addEventListener('touchstart', showTouch, { passive: true, once: true });

  addEventListener('gamepadconnected', (e) => {
    toast(`Controle conectado: ${(e as GamepadEvent).gamepad.id.replace(/\s*\(.*$/, '')}`);
    startPads();
  });
  addEventListener('gamepaddisconnected', () => toast('Controle desconectado'));
  // Pads already connected (Chrome reports them only after a button is pressed).
  startPads();
  // Lost focus: the page saw no key ups, start again from nothing held.
  addEventListener('blur', () => { held.clear(); sources.pad.clear(); fingers.clear(); refreshTouch(); });
}
