// Presentation uses the game's 60 Hz timeline, not the display's callback frequency.
export function animationFrame(startMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startMs) * 60 / 1000 + 1e-7));
}

/** Wrap long ROM-font messages at words instead of letting them run beyond the canvas. */
export function wrapMenuText(text: string, columns = 28): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > columns) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines;
}
