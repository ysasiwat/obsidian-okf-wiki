// log.md maintenance (OKF §9, DESIGN.md §4.6): date-grouped entries, newest day first,
// UTC dates, one line per (concept, day, action, actor) with reasons coalesced.

export type LogAction =
  | "Creation" | "Ingest" | "Update" | "Move" | "Deprecation"
  | "Verification" | "Approval" | "Publication" | "Revert" | "Review request";

export interface LogEntry {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  action: LogAction;
  title: string;
  /** Link target relative to the log file. */
  link: string;
  actor: string;
  reason?: string;
}

const DEFAULT_TITLE = "# Bundle Update Log";
const DATE_HEADING = /^## (\d{4}-\d{2}-\d{2})\s*$/;
const OUR_LINE = /^\* \*\*([A-Za-z][A-Za-z ]*)\*\*: \[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)(?: - (.*?))? \(by ([^()\s]+)\)$/;

export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function escapeText(s: string): string {
  return s.replace(/([\\[\]])/g, "\\$1");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function formatLine(e: LogEntry): string {
  const reason = e.reason ? ` - ${oneLine(e.reason)}` : "";
  return `* **${e.action}**: [${escapeText(oneLine(e.title))}](${e.link})${reason} (by ${e.actor})`;
}

/**
 * Add entries to a log, creating it when `existing` is undefined. Lines this function
 * did not write are preserved verbatim. Input and output use LF line endings.
 */
export function appendLogEntries(existing: string | undefined, entries: LogEntry[]): string {
  const lines = existing === undefined ? [DEFAULT_TITLE, ""] : existing.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");

  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error(`invalid log date: ${entry.date}`);
    // Find the day's section, or the place to insert it (sections are newest first).
    let dayStart = -1;
    let insertAt = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = DATE_HEADING.exec(lines[i]!);
      if (!m) continue;
      if (m[1] === entry.date) {
        dayStart = i;
        break;
      }
      if (m[1]! < entry.date && insertAt === -1) insertAt = i;
    }
    if (dayStart === -1) {
      const at = insertAt === -1 ? lines.length : insertAt;
      const block = [`## ${entry.date}`, "", formatLine(entry), ""];
      if (at === lines.length && lines.length > 0 && lines[lines.length - 1] !== "") block.unshift("");
      lines.splice(at, 0, ...block);
      continue;
    }
    let dayEnd = lines.length;
    for (let i = dayStart + 1; i < lines.length; i++) {
      if (/^#{1,2} /.test(lines[i]!)) {
        dayEnd = i;
        break;
      }
    }
    // Coalesce with an existing line for the same concept, action and actor.
    let merged = false;
    for (let i = dayStart + 1; i < dayEnd; i++) {
      const m = OUR_LINE.exec(lines[i]!);
      if (m && m[1] === entry.action && m[3] === entry.link && m[5] === entry.actor) {
        const reasons = [m[4], entry.reason ? oneLine(entry.reason) : undefined].filter(Boolean);
        const unique = [...new Set(reasons)];
        lines[i] = formatLine({ ...entry, reason: unique.join("; ") || undefined });
        merged = true;
        break;
      }
    }
    if (merged) continue;
    let lastEntry = dayStart;
    for (let i = dayStart + 1; i < dayEnd; i++) if (lines[i]!.trim() !== "") lastEntry = i;
    const at = lastEntry === dayStart ? dayStart + 1 : lastEntry + 1;
    if (lastEntry === dayStart) lines.splice(at, 0, "", formatLine(entry));
    else lines.splice(at, 0, formatLine(entry));
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
}

export interface ParsedLogEntry {
  date: string;
  /** The entry text without the list marker. */
  text: string;
  /** Present for lines in this plugin's format. */
  action?: string;
  title?: string;
  link?: string;
  reason?: string;
  actor?: string;
}

/** Entries under each `## YYYY-MM-DD` heading, in file order (newest day first). */
export function parseLog(text: string): ParsedLogEntry[] {
  const out: ParsedLogEntry[] = [];
  let date: string | null = null;
  for (const l of text.replace(/\r\n/g, "\n").split("\n")) {
    const d = DATE_HEADING.exec(l);
    if (d) {
      date = d[1]!;
      continue;
    }
    if (/^#{1,2} /.test(l)) {
      date = null;
      continue;
    }
    if (date === null || !/^[*-] /.test(l)) continue;
    const m = OUR_LINE.exec(l);
    out.push(
      m
        ? { date, text: l.slice(2), action: m[1]!, title: m[2]!.replace(/\\([\\[\]])/g, "$1"), link: m[3]!, ...(m[4] ? { reason: m[4] } : {}), actor: m[5]! }
        : { date, text: l.slice(2) },
    );
  }
  return out;
}

/** Problems with an existing log's structure (OKF §9). */
export function logProblems(text: string): string[] {
  const problems: string[] = [];
  const t = text.replace(/\r\n/g, "\n");
  if (t.startsWith("---\n")) problems.push("log.md should not have frontmatter (OKF §9)");
  for (const l of t.split("\n")) {
    if (/^## /.test(l) && !DATE_HEADING.test(l)) problems.push(`date heading is not YYYY-MM-DD: '${l}'`);
  }
  return problems;
}
