// Extension API (DESIGN.md §13 4C, D9): what other Obsidian plugins may use through
// app.plugins.plugins["okf-wiki"].api. Read-only by construction: it holds no write service, and
// every result is a copy, so changing one cannot change a bundle.

import type { KnowledgeService } from "./service/knowledgeService";
import type { CommitEvent, Principal } from "./service/types";

export type { CommitEvent } from "./service/types";

/** Bumped when a member changes incompatibly; extensions should check it. */
export const API_VERSION = 1;

export interface OkfWikiApi {
  readonly apiVersion: number;
  /** Enabled bundles with their counts. */
  bundles(): ReturnType<KnowledgeService["listBundles"]>;
  /** The same search agents get from okf_search. */
  search(args: Parameters<KnowledgeService["search"]>[1]): ReturnType<KnowledgeService["search"]>;
  /** The same read agents get from okf_read. */
  read(args: Parameters<KnowledgeService["read"]>[1]): ReturnType<KnowledgeService["read"]>;
  /** Called after every commit (agent, person or revert) is on disk. Returns an unsubscribe function. */
  onCommit(listener: (event: CommitEvent) => void): () => void;
}

/** Sees every bundle, may only read. */
const EXTENSION_READER: Principal = { tokenName: "extension", kind: "agent", scopes: new Set(["read"]), bundles: "*", pathPrefixes: [] };

/** Owns the API: fans commit events out, and switches the API off when the plugin unloads. */
export class ExtensionHost {
  private readonly listeners = new Set<(event: CommitEvent) => void>();
  private live = true;
  readonly api: OkfWikiApi;

  constructor(service: KnowledgeService, private readonly log: (message: string, error?: unknown) => void = () => undefined) {
    const call = <T>(f: () => T): T => {
      this.assertLive();
      return structuredClone(f());
    };
    this.api = Object.freeze({
      apiVersion: API_VERSION,
      bundles: () => call(() => service.listBundles(EXTENSION_READER)),
      search: (args) => call(() => service.search(EXTENSION_READER, args)),
      read: (args) => call(() => service.read(EXTENSION_READER, args)),
      onCommit: (listener) => {
        this.assertLive();
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
      },
    } satisfies OkfWikiApi);
  }

  /** WriteService's onCommit: one failing extension does not stop the others. */
  emit(event: CommitEvent): void {
    if (!this.live) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(event));
      } catch (e) {
        this.log("an extension's commit listener failed", e);
      }
    }
  }

  dispose(): void {
    this.live = false;
    this.listeners.clear();
  }

  private assertLive(): void {
    // An extension holding the API across a reload must fetch it again, not reach a stale service.
    if (!this.live) throw new Error("OKF Wiki has unloaded; get app.plugins.plugins['okf-wiki'].api again once it is enabled");
  }
}
