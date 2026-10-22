// Auto approve (DESIGN.md §5.3): when a listed token creates or updates a curated concept in a
// listed bundle, WriteService approves it in the same queued write, as process:auto-approve,
// if nothing needs a person's eye (KnowledgeService.approvalBlockers). The result is
// machine-confirmed, never human-reviewed.

import type { KnowledgeService } from "./knowledgeService";

export interface AutoApproveSettings {
  enabled: boolean;
  /** Token names whose writes may be approved. */
  tokens: string[];
  /** Bundle folders; empty means every bundle. */
  bundles: string[];
}

export const AUTO_APPROVE_ACTOR = "process:auto-approve";
const TOOLS = new Set(["okf_create", "okf_update"]);

/** WriteOptions.autoApprove for these settings. */
export function autoApproveRule(service: KnowledgeService, settings: () => AutoApproveSettings) {
  return (tokenName: string, bundle: string, conceptId: string, tool: string): boolean => {
    const s = settings();
    if (!s.enabled || !s.tokens.includes(tokenName) || !TOOLS.has(tool)) return false;
    if (s.bundles.length > 0 && !s.bundles.includes(bundle)) return false;
    return service.approvalBlockers(bundle, conceptId).length === 0;
  };
}
