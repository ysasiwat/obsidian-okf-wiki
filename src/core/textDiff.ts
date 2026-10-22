// The smallest single replacement turning one text into another. Writes to a file open in
// the editor are applied as this one change (ADR 0003, S2), so the cursor and any text the
// person typed outside the changed range are untouched.

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** null when the texts are equal. Never splits a UTF-16 surrogate pair. */
export function minimalChange(a: string, b: string): TextChange | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  if (start > 0 && isHigh(a.charCodeAt(start - 1))) start--;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (endA < a.length && isLow(a.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export function applyChange(text: string, change: TextChange | null): string {
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}
