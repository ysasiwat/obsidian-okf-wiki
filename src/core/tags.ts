// Tags (OKF §4.1): a YAML list of short strings. Producers sometimes write a single
// comma-separated string (the OKF reference agent's prompt allows it); read both.

export function normalizeTags(frontmatter: Record<string, unknown>): string[] {
  const t = frontmatter["tags"];
  const raw = Array.isArray(t) ? t : typeof t === "string" ? t.split(",") : [];
  return raw
    .filter((x): x is string | number => typeof x === "string" || typeof x === "number")
    .map((x) => String(x).trim())
    .filter((x) => x !== "");
}
