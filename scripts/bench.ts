// Benchmark for DESIGN.md §13 4A: how long the work on Obsidian's UI thread takes as a bundle
// grows. Synthetic bundles; each concept links the next one and cites a source.
//   npm run bench [-- 1000 5000]
// "write + queue" is one agent write followed by the Review Queue refresh the plugin runs after it;
// "search after write" is the first search once a write has changed the bundle.

import { analyzeBundle, analyzeBundleSliced } from "../src/core/bundle";
import { lintBundle } from "../src/core/lint";
import { KnowledgeService } from "../src/service/knowledgeService";
import { WriteService, type Writer } from "../src/service/writeService";
import type { Scope } from "../src/service/types";
import { MemoryAudit, MemoryFilePort, MemoryProvider, MemorySnapshots, principal } from "../test/helpers-service";

function bundle(n: number): Map<string, string> {
  const files = new Map<string, string>([[".okf.yaml", 'okf_version: "0.2"\n']]);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    files.set(
      `d${i % 50}/c${i}.md`,
      `---\ntype: Note\ntitle: Concept ${i}\ndescription: Synthetic concept number ${i}.\ntags: [t${i % 20}]\nsources:\n  - { id: s, resource: https://example.org/${i} }\n---\n\n` +
        `Concept ${i} relates to [c${next}](../d${next % 50}/c${next}.md).[^s]\n\n## Details\n\nMore text about concept ${i} with \`code\`.\n\n[^s]: Example\n`,
    );
  }
  return files;
}

const time = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
const timeAsync = async (f: () => Promise<unknown>) => {
  const t = performance.now();
  await f();
  return performance.now() - t;
};
const ms = (x: number) => `${x.toFixed(0)} ms`;

/** The longest stretch `run` spends without handing control back through `pause`. */
async function longestBlock(run: (pause: () => Promise<void>) => Promise<void>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  await run(async () => {
    longest = Math.max(longest, performance.now() - last);
    await new Promise((r) => setTimeout(r, 0));
    last = performance.now();
  });
  return Math.max(longest, performance.now() - last);
}

const firstLoad: string[] = [];
const sizes = process.argv.slice(2).map(Number).filter((x) => x > 0);
console.log("| concepts | analyze | lint | search cold / warm | write | write + queue | search after write |\n|---|---|---|---|---|---|---|");
for (const n of sizes.length ? sizes : [1000, 5000]) {
  const files = bundle(n);
  const analyze = time(() => analyzeBundle(files));
  const model = analyzeBundle(files);
  const lint = time(() => lintBundle(model));
  const provider = new MemoryProvider().set("K", files);
  const knowledge = new KnowledgeService(provider);
  const reader = principal();
  const cold = time(() => knowledge.search(reader, { query: "concept 4242" }));
  const warm = time(() => knowledge.search(reader, { query: "synthetic 17" }));
  const writes = new WriteService(provider, new MemoryFilePort(provider), new MemorySnapshots(), new MemoryAudit(), { perMinute: 1e9, perDay: 1e9 });
  const writer: Writer = { kind: "token", principal: principal({ scopes: new Set<Scope>(["read", "write"]) }), actor: "bench/1" };
  const create = (k: string) => writes.write(writer, "K", { kind: "create", conceptId: `d1/new-${k}`, frontmatter: { type: "Note", title: `New ${k}`, description: "x", sources: [{ id: "s", resource: "https://x" }] }, body: "New.[^s]\n\n[^s]: X\n" }, "okf_create");
  const runs = 5;
  let write = 0;
  let queued = 0;
  for (let k = 0; k < runs; k++) write += await timeAsync(() => create(`w${k}`));
  for (let k = 0; k < runs; k++) queued += await timeAsync(async () => (await create(`q${k}`), knowledge.reviewQueue()));
  let searched = 0;
  for (let k = 0; k < runs; k++) {
    await create(`s${k}`);
    searched += time(() => knowledge.search(reader, { query: `concept ${k}` }));
  }
  console.log(`| ${n} | ${ms(analyze)} | ${ms(lint)} | ${ms(cold)} / ${ms(warm)} | ${ms(write / runs)} | ${ms(queued / runs)} | ${ms(searched / runs)} |`);
  firstLoad.push(`| ${n} | ${ms(analyze + lint + cold)} | ${ms(await longestBlock(async (pause) => {
    const sliced = await analyzeBundleSliced(files, undefined, pause);
    await new KnowledgeService({ bundles: () => [{ name: "K", model: sliced, version: 1 }], ready: () => true }).warm(pause);
  }))} |`);
}
console.log(["", "First load: analyze + lint + search index, as one block before and as the longest slice now.", "", "| concepts | one block | longest slice |", "|---|---|---|", ...firstLoad].join("\n"));
