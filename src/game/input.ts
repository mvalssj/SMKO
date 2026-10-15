// Keyboard input (gamepads and the touch controls arrive as the same keys, see src/controls.ts).
// Keyboard: arrows or WASD to steer/accelerate/brake, X/Space also accelerates, Z brakes, Shift drifts,
// E / Q / Ctrl uses the item (hold brake to throw it behind).

import type { Input } from './physics';

const keys = new Set<string>();
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
  if (GAME_KEYS.has(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

export function readInput(): Input {
  const k = (...codes: string[]) => codes.some((c) => keys.has(c));
  return {
    accel: k('ArrowUp', 'KeyW', 'KeyX', 'Space'),
    brake: k('ArrowDown', 'KeyS', 'KeyZ'),
    left: k('ArrowLeft', 'KeyA'),
    right: k('ArrowRight', 'KeyD'),
    drift: k('ShiftLeft', 'ShiftRight', 'KeyC'),
    item: k('KeyE', 'KeyQ', 'ControlLeft', 'ControlRight'),
  };
}
