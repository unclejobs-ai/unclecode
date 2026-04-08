function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function getCodePointWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint === 0 || codePoint === 0x200d || codePoint === 0xfe0f) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningCodePoint(codePoint)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

export function getDisplayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += getCodePointWidth(char);
  }
  return width;
}

export function sliceByDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  let width = 0;
  let output = "";
  for (const char of value) {
    const nextWidth = getCodePointWidth(char);
    if (width + nextWidth > maxWidth) {
      break;
    }
    output += char;
    width += nextWidth;
  }
  return output;
}

export function truncateForDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (getDisplayWidth(value) <= maxWidth) return value;
  if (maxWidth <= 3) return sliceByDisplayWidth(value, maxWidth);

  const ellipsis = "…";
  const ellipsisWidth = getDisplayWidth(ellipsis);
  const contentWidth = Math.max(0, maxWidth - ellipsisWidth);
  return `${sliceByDisplayWidth(value, contentWidth)}${ellipsis}`;
}
