/**
 * Whether a terminal acts on this character instead of showing it: C0 controls other than
 * tab and newline, DEL, C1 controls (0x80–0x9f, some terminals read 0x9b as an escape) and
 * the marks and overrides that make text display in another order than it is.
 */
function isHidden(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Text as it can be shown safely (T44): commands, paths and names come from a pulled bundle
 * and messages from the server, so an escape sequence in them could redraw the terminal and
 * make a review list look harmless. Each such character is shown as `\u{…}` instead.
 */
export function printable(text: string): string {
  return shownAs(text, isHidden);
}

/**
 * `printable` for a value shown on one line of a list (SEC-03): line breaks and tabs are
 * shown as `\u{…}` too, so a command from a bundle cannot add lines that look like more
 * entries of a review list.
 */
export function printableLine(text: string): string {
  return shownAs(text, (code) => isHidden(code) || code === 0x09 || code === 0x0a);
}

function shownAs(text: string, hidden: (code: number) => boolean): string {
  let shown = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    shown += hidden(code) ? `\\u{${code.toString(16).padStart(4, '0')}}` : char;
  }
  return shown;
}
