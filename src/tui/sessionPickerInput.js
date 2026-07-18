const HEADER_OFFSET = 3;

export function decodeSessionMouse(buf) {
  const bytes = [...buf];
  const text = buf.toString();

  // X10: ESC [ M Cb Cx Cy (all coordinates/button values are offset by 32).
  if (bytes[0] === 27 && bytes[1] === 91 && bytes[2] === 77) {
    const button = (bytes[3] || 0) - 32;
    const row = (bytes[5] || 0) - 32 - HEADER_OFFSET;
    return { handled: true, row: (button & 3) === 0 ? row : null };
  }

  // SGR: ESC [ < Cb ; Cx ; Cy M for press, lowercase m for release.
  const match = text.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (match) {
    const button = parseInt(match[1], 10);
    const row = parseInt(match[3], 10) - HEADER_OFFSET;
    const leftPress = match[4] === 'M' && (button & 3) === 0;
    return { handled: true, row: leftPress ? row : null };
  }

  return { handled: false, row: null };
}
