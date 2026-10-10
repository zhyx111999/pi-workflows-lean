/** Sanitizes text typed or pasted into the navigator's filter and rename fields. */

/** Remove terminal control sequences while preserving ordinary pasted text. */
export function safeInputText(data: string): string {
  let out = "";
  let index = 0;
  while (index < data.length) {
    if (data.charCodeAt(index) === 0x1b) {
      const next = data[index + 1];
      if (next === "[") {
        // CSI: consume through its final byte (0x40–0x7e).
        index += 2;
        while (index < data.length) {
          const code = data.charCodeAt(index++);
          if (code >= 0x40 && code <= 0x7e) break;
        }
        continue;
      }
      if (next === "]") {
        // OSC: consume the command, payload, and either BEL or ST terminator.
        // An unterminated OSC is discarded through the end rather than leaking
        // its title/parameters into the user's filter or rename.
        index += 2;
        while (index < data.length) {
          if (data.charCodeAt(index) === 0x07) {
            index++;
            break;
          }
          if (data.charCodeAt(index) === 0x1b && data[index + 1] === "\\") {
            index += 2;
            break;
          }
          index++;
        }
        continue;
      }
      // Drop a bare ESC and an ST terminator; neither is user text.
      index += next === "\\" ? 2 : 1;
      continue;
    }

    const codePoint = data.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(codePoint);
    if (codePoint === 0x7f || codePoint < 0x20 || (codePoint >= 0x80 && codePoint <= 0x9f)) {
      index += char.length;
      continue;
    }
    if (/\p{Cf}/u.test(char)) {
      index += char.length;
      continue;
    }
    out += char;
    index += char.length;
  }
  return out;
}

/** Backspace by one user-perceived character, so emoji and combining marks go in one keypress. */
export function dropLastGrapheme(text: string): string {
  const Segmenter = Intl.Segmenter;
  const graphemes = Segmenter ? [...new Segmenter().segment(text)].map((entry) => entry.segment) : Array.from(text);
  return graphemes.slice(0, -1).join("");
}
