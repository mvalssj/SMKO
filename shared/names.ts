// Course names, in the order of SmkRom.tracks (the 20 GP tracks in cup order, then the 4 battle courses):
// the server names courses with them (room tracks, Battle Royale world) without the ROM.

export const GP_NAMES = [
  'Mario Circuit 1', 'Donut Plains 1', 'Ghost Valley 1', 'Bowser Castle 1', 'Mario Circuit 2',
  'Choco Island 1', 'Ghost Valley 2', 'Donut Plains 2', 'Bowser Castle 2', 'Mario Circuit 3',
  'Koopa Beach 1', 'Choco Island 2', 'Vanilla Lake 1', 'Bowser Castle 3', 'Mario Circuit 4',
  'Donut Plains 3', 'Koopa Beach 2', 'Ghost Valley 3', 'Vanilla Lake 2', 'Rainbow Road',
];
export const BATTLE_NAMES = ['Battle Course 1', 'Battle Course 2', 'Battle Course 3', 'Battle Course 4'];
export const COURSE_NAMES = [...GP_NAMES, ...BATTLE_NAMES];
