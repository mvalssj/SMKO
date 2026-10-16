# Fidelity audit — implementation review

This is a ROM-driven reimplementation, not a complete SNES emulator. Passing the regression suite does not establish frame-by-frame or pixel equivalence with Super Mario Kart.

## Verified implementation fixes

- Menu, result-board and ceremony animation counters now derive from a 60 Hz time base rather than requestAnimationFrame callback count. High-refresh displays no longer accelerate these sequences.
- Ceremony particles derive position from time; repeated rendering of a frame does not advance them.
- Podium messages wrap and centre within the 256px canvas (including long character names).
- Balloon loss compares against the previous count before updating it; duplicate updates do not replay the hit sound.
- Race cleanup restores covered pickup tiles and their atlas IDs. Reusing the cached Battle Royale world no longer retains this match's consumed pickups.

Run `node tools/test-fidelity.mjs` and `npm run build`.
The tests use synthetic terrain and browser stubs, not a ROM or browser visual capture.

## Still requires reference captures / measurements

- `src/menu/ceremony.ts`: podium blocks and floor are explicitly an approximation, not the original Mode 7 scene.
- `src/game/objects.ts`: obstacle animation timings are approximate.
- `src/game/physics.ts`: 150cc speed scaling is extrapolated; collision behaviour and item pickup radius need comparison with the cartridge.
- Lakitu's reverse sign needs frame/OAM verification. No claim of visual repair is made by this audit.
- Shell trajectory, wall response, item timing/probabilities, CPU behaviour, sound and menus need controlled side-by-side runs with the same USA ROM.

Battle Royale, online rooms, mobile controls, widescreen and PWA are intentional extensions. They cannot be identical to modes absent from the original cartridge.
