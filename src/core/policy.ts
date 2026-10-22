// Bundle policy from `<bundle>/.okf.yaml` (DESIGN.md §4.1). The file lives in the bundle so
// the CLI, CI and every device apply the same rules; MCP tools write only .md files, so an
// agent cannot change it.

import { parseDocument } from "yaml";
import type { Status } from "./trust";

export const POLICY_FILENAME = ".okf.yaml";

export interface BundlePolicy {
  okf_version: string;
  /** Language curated concepts must be written in (BCP 47). */
  content_language: string;
  /** Bundle-relative directories whose concepts are raw sources in any language. */
  raw_dirs: string[];
  /** Max share of non-Latin letters in a curated body before it counts as non-English. */
  non_english_threshold: number;
  auto_index: boolean;
  auto_log: boolean;
  agent_initial_status: Extract<Status, "draft" | "stable">;
}

export const DEFAULT_POLICY: Readonly<BundlePolicy> = Object.freeze({
  okf_version: "0.2",
  content_language: "en",
  raw_dirs: ["references/raw"],
  non_english_threshold: 0.05,
  auto_index: true,
  auto_log: true,
  agent_initial_status: "draft",
});

export interface PolicyResult {
  policy: BundlePolicy;
  /** Problems found in the file; defaults are used for the affected keys. */
  problems: string[];
}

export function parsePolicy(text: string | undefined): PolicyResult {
  const policy: BundlePolicy = { ...DEFAULT_POLICY, raw_dirs: [...DEFAULT_POLICY.raw_dirs] };
  const problems: string[] = [];
  if (text === undefined || text.trim() === "") return { policy, problems };

  const doc = parseDocument(text, { version: "1.2" });
  if (doc.errors.length > 0) {
    return { policy, problems: [`${POLICY_FILENAME} is not valid YAML: ${doc.errors[0]!.message}`] };
  }
  const raw = doc.toJS() as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { policy, problems: [`${POLICY_FILENAME} must be a YAML mapping`] };
  }
  const o = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(o)) {
    switch (key) {
      case "okf_version":
      case "content_language":
        if (typeof value === "string" && value.trim()) policy[key] = value.trim();
        else problems.push(`${key} must be a non-empty string`);
        break;
      case "raw_dirs":
        if (Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim())) {
          policy.raw_dirs = value.map((v: string) => v.trim().replace(/^\/+|\/+$/g, ""));
        } else problems.push("raw_dirs must be a list of directory paths");
        break;
      case "non_english_threshold":
        if (typeof value === "number" && value >= 0 && value <= 1) policy.non_english_threshold = value;
        else problems.push("non_english_threshold must be a number between 0 and 1");
        break;
      case "auto_index":
      case "auto_log":
        if (typeof value === "boolean") policy[key] = value;
        else problems.push(`${key} must be true or false`);
        break;
      case "agent_initial_status":
        if (value === "draft" || value === "stable") policy.agent_initial_status = value;
        else problems.push("agent_initial_status must be draft or stable");
        break;
      default:
        problems.push(`unknown key '${key}' (ignored)`);
    }
  }
  return { policy, problems };
}

export type Zone = "curated" | "raw";

/** Which zone a bundle-relative path is in. Zones follow the path, never the `type`. */
export function zoneOf(bundlePath: string, policy: BundlePolicy): Zone {
  return policy.raw_dirs.some((d) => d !== "" && (bundlePath === d || bundlePath.startsWith(`${d}/`)))
    ? "raw"
    : "curated";
}
