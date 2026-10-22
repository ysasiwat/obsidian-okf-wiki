# OKF Wiki — Design

> สถานะ: Draft v0.6 · 2026-10-20 · ผู้เขียน: ys
> v0.2 ปรับตามผลรีวิวรอบที่ 1 (Appendix A) · v0.3 เพิ่มนโยบายภาษา (§4.8, Appendix B)
> · v0.4 ยืนยันการตัดสินใจ §14 และปรับตามผลรีวิวรอบที่ 2 (Appendix C)
> · v0.5 ปรับตามผล spike S2–S4 (ADR 0003, Appendix D)
> · v0.6 แผน Phase 4 (§13, D8–D10, Appendix E)
>
> Obsidian plugin ที่เปิด **MCP server ภายใน Obsidian** ให้ Agent อ่าน/เขียนความรู้ในรูปแบบ
> **Open Knowledge Format (OKF) v0.2** โดยตรง

อ้างอิง:

- `obsidian-local-rest-api` v5.4.0 (Adam Coddington, MIT): ใช้เป็นต้นแบบด้าน
  transport, MCP, security และ test
- `open-knowledge-format` v0.2 (Google, Apache-2.0): ใช้เป็น storage model คือ `SPEC.md`,
  reference agent `src/reference_agent/bundle/*` และ sample bundles

---

## 1. เป้าหมาย / ไม่ใช่เป้าหมาย

### เป้าหมาย

1. **Vault คือ OKF bundle ที่ถูกต้องตาม spec เสมอ** เมื่อ Agent เขียนผ่าน MCP ผลลัพธ์ต้องผ่าน
   conformance §11 ทุกครั้ง ไม่ใช่ "พยายามให้ถูก"
2. **Trust ต้องมีความหมายจริง** โดย `generated` / `verified` / trust tier ต้องเชื่อถือได้
   Agent ต้องปลอมเป็น `human:` ไม่ได้
3. **Progressive disclosure** ให้ Agent ไล่ดูจาก bundle → directory index → concept → section
   แทนการโหลดทั้ง vault
4. **มนุษย์กับ Agent ใช้ไฟล์ชุดเดียวกัน** มนุษย์แก้ใน Obsidian ได้ตามปกติ, Agent เขียนผ่าน MCP
   และ provenance บันทึกถูกต้องทั้งสองทาง
5. **Security เท่ากับหรือดีกว่า local-rest-api** (ดูตารางเทียบใน §11)
6. **พกพาได้** bundle ยังเป็นแค่ markdown จึงใช้กับ git, OKF visualizer และ Knowledge Catalog
   connector ได้โดยไม่ผูกกับ plugin นี้
7. **ความรู้ที่ใช้งานเป็นภาษาอังกฤษ** ส่วนต้นฉบับ (raw) ที่แปลงมาเก็บไว้คงภาษาเดิมได้ (§4.8)

### ไม่ใช่เป้าหมาย

- ไม่ใช่ REST API ทั่วไปสำหรับทุกไฟล์ใน vault (local-rest-api ทำส่วนนี้ดีแล้ว และติดตั้งคู่กันได้)
- ไม่ **รัน** Attested Computation หรือ attester (SPEC §10.5: attester ต้องรันฝั่ง consumer)
- ไม่ทำ semantic/vector search ในเวอร์ชันแรก (เพิ่มภายหลังผ่าน extension ดู §13)
- ไม่รองรับ mobile ในเวอร์ชันแรก (`isDesktopOnly: true` เพราะต้องใช้ Node `http`)

---

## 2. สิ่งที่ได้จากต้นแบบ และจุดที่เราจะทำให้ดีกว่า

### จาก obsidian-local-rest-api

| สิ่งที่ยกมาใช้ | สิ่งที่ปรับให้ดีกว่า |
|---|---|
| MCP Streamable HTTP ที่ `/mcp/` รองรับทั้ง revision `2026-07-28` (stateless) และ sessionful `2024-10-07…2025-11-25` ผ่าน `@modelcontextprotocol/server` 2.0 | Tool เป็น **OKF-native** (concept / bundle / trust) ไม่ใช่ file CRUD ดิบ ทำให้ Agent ทำผิด spec ได้ยาก |
| Path guard (`vaultPath.ts`): fold `\`, ตัด trailing dot/space, ห้าม `:` / NUL / absolute, จำกัดจำนวน segment, ห้าม configDir รวมถึงกรณี 8.3 short name และ symlink | เพิ่ม concept-id grammar ที่แคบกว่า (§4.2) ซ้อนอีกชั้น และ allowlist ราย bundle/path ต่อ token |
| Throttle เมื่อ auth ล้มเหลว (10 ครั้ง/นาที → 429) | เหมือนเดิม และเทียบ token แบบ **timing-safe** (ต้นแบบใช้ `===` ที่ `requestHandler.ts:323`) |
| `ifMatch` ด้วย content hash บน `vault_patch` | ใช้ **ETag กับทุก write** (ต้นแบบมี `vault_write` ที่ "Overwrites without warning") |
| Tool annotations (`readOnlyHint`, `destructiveHint`) และ cache hints | เหมือนเดิม และเพิ่ม `outputSchema` (structured result) ให้ทุก tool |
| Extension API แบบ typed (`publicApi.ts`) | ทำใน Phase 4 แบบแคบกว่า (§13) |
| Unit test ด้วย mock obsidian + integration test กับ Obsidian จริง | เพิ่ม **golden test กับ sample bundles ของ OKF** และ cross-check กับ Python parser ของต้นแบบ |
| API key เดียว เก็บ plaintext ใน `data.json` | **หลาย token, มี scope, เก็บเป็น hash**, revoke ได้ และแสดง token ครั้งเดียวตอนสร้าง |
| CORS `*` และไม่ตรวจ `Origin`/`Host` | ตรวจ `Origin` ตามที่ MCP spec กำหนด และตรวจ `Host` เพิ่มอีกชั้น เพื่อกัน DNS rebinding |

### จาก open-knowledge-format

| สิ่งที่ยกมาใช้ | สิ่งที่ปรับให้ดีกว่า |
|---|---|
| `OKFDocument.parse/serialize`, ปิด YAML timestamp coercion | ถ้า frontmatter ไม่เปลี่ยน **จะไม่แตะข้อความเดิมเลย** ถ้าเปลี่ยนจะแก้ผ่าน `yaml` (YAML 1.2) Document API เพื่อเก็บ comment, ลำดับ key และ flow style (ต้นแบบใช้ `safe_dump` ทั้ง block ทำให้รูปแบบเดิมหายหมด) |
| `trust_tier`, `is_stale`, `normalize_verified` | port มาตรงตัว เพราะเป็น normative ตาม §5.2–5.5 |
| `_PREFERRED_KEY_ORDER` สำหรับเอกสารใหม่ | ใช้กับเอกสารใหม่เท่านั้น ส่วนเอกสารเดิมจะคงลำดับ key ไว้ |
| Augmentation guard (ไม่ให้ web pass ทำให้ `sources` / `# Schema` สั้นลง) | ใช้เป็นหลักทั่วไป **"non-destructive by default"** กับทุก concept (§6.4) |
| `regenerate_indexes` | ทำแบบ **deterministic ไม่ใช้ LLM** (ต้นแบบเรียก Gemini มาเขียนคำอธิบาย directory), incremental และ debounce |
| `generated` เติมให้อัตโนมัติ | actor มาจาก **token identity ที่ server ตรวจแล้ว** ไม่ใช่ค่าที่ Agent ส่งมาเอง |
| ไม่มี `log.md` writer | server เขียน `log.md` ให้อัตโนมัติตาม §9 |

---

## 3. สถาปัตยกรรม

```mermaid
flowchart LR
  subgraph Clients
    CC[Claude Code / Cursor<br/>Streamable HTTP]
    CD[Claude Desktop<br/>via mcp-remote]
    CLI[okf CLI / CI]
  end

  subgraph Plugin["Obsidian plugin (desktop)"]
    T[Transport<br/>http · auth · origin · rate-limit]
    M[MCP layer<br/>tools · resources · prompts]
    S[Bundle service<br/>write pipeline · locks · ledger]
    I[Concept index<br/>in-memory graph + search]
    J[Maintainers<br/>index.md · log.md · lint]
    A[Vault adapter<br/>Vault.process · path guard]
    U[UI<br/>settings · commands · review queue]
  end

  CORE[[okf-core<br/>pure TS, no obsidian import]]

  CC --> T
  CD --> T
  T --> M --> S
  M --> I
  S --> A
  S --> J
  A -- vault events --> I
  I --> J
  U --> S
  S -.uses.-> CORE
  I -.uses.-> CORE
  J -.uses.-> CORE
  CLI -.uses.-> CORE
```

หลักการสำคัญ:

1. **`okf-core` เป็น pure TypeScript** ที่ไม่ import `obsidian` เลย ประกอบด้วย parse/serialize,
   validate, trust/staleness, link extraction/rewriting, index/log rendering และ lint
   จึง test ได้ง่าย และนำไปใช้เป็น CLI ได้ (`okf lint`, `okf index`) สำหรับ CI หรือ bundle
   ที่ไม่ได้เปิดใน Obsidian
2. **ทุก write วิ่งผ่าน `BundleService.commit()` ช่องทางเดียว** ไม่ว่าจะมาจาก MCP tool หรือ
   UI command (§6) ไม่มี tool ไหนเรียก `vault.modify` เอง
3. **Index อยู่ในหน่วยความจำ** สร้างจาก `metadataCache` ร่วมกับ parser ของเรา และอัปเดตจาก vault
   events (`create`/`modify`/`delete`/`rename`) จึงตอบ search, backlink และ browse ได้โดยไม่ต้อง
   scan disk
4. **ความหมายของความรู้และนโยบายของ bundle อยู่ใน bundle เอง** ได้แก่ frontmatter, `index.md`,
   `log.md` และ `.okf.yaml` (§4.1) ทำให้ CLI และเครื่องอื่นใช้กฎชุดเดียวกัน ส่วน plugin data
   มีแค่ข้อมูลประกอบการทำงานของเครื่องนั้น คือ bundle ที่เครื่องนี้เปิดให้ MCP ใช้, port,
   token hash, `human:<id>`, audit log, trust snapshot (§5.1) และ snapshot store (§6.7)
   ถ้าข้อมูลส่วนนี้หายไป bundle ยังถูกต้องครบ เพียงแค่ตรวจจับย้อนหลังและ revert ไม่ได้
   ส่วน snapshot store และ audit ควรถูกกันออกจาก git และ sync (§6.7)

---

## 4. Storage model: OKF บน Obsidian vault

### 4.1 Bundle

- vault หนึ่งมีได้ **หลาย bundle** และแต่ละ bundle คือ folder หนึ่ง
- **รายชื่อ bundle ใน settings คือแหล่งความจริง** โดยเพิ่มได้ 3 ทาง:
  1. command "Create OKF bundle here" (folder ใหม่)
  2. command "Register folder as OKF bundle" สำหรับ bundle ที่มีอยู่แล้ว ซึ่งจะรัน lint ก่อน
     และถามผู้ใช้ก่อนเขียนอะไรลงไฟล์
  3. ค้นพบอัตโนมัติจาก folder ที่มี `.okf.yaml` หรือ root `index.md` ที่มี frontmatter
     `okf_version` (SPEC §12) โดยจะแสดงเป็น "พบ bundle ใหม่ ต้องการเปิดใช้ไหม" ไม่ได้เปิดเอง
     ซึ่งจำเป็นเมื่อ bundle มาทาง sync หรือ git จากเครื่องอื่น

  เหตุผล: sample bundle ทั้ง 4 ชุดของ OKF **ไม่มีชุดไหนประกาศ `okf_version`** ถ้าพึ่ง marker
  อย่างเดียวจะค้นไม่พบ bundle จริงเลย และการเปิดให้ MCP เขียนได้ควรเป็นการตัดสินใจของผู้ใช้
- **นโยบายของ bundle อยู่ในไฟล์ `<bundle>/.okf.yaml`** ซึ่งไม่ใช่ `.md` จึงไม่ถือเป็น concept
  (OKF ยอมให้มีไฟล์อื่นใน bundle เช่น `.py` ใน acme_retail) และ Obsidian ก็ซ่อน dotfile ไว้
  ตัวอย่าง:

  ```yaml
  okf_version: "0.2"
  content_language: en
  raw_dirs: [references/raw]
  non_english_threshold: 0.05
  auto_index: true
  auto_log: true
  agent_initial_status: draft
  ```

  เหตุผลที่ไม่เก็บใน plugin settings (v0.3): ถ้ากฎอย่าง `raw_dirs` อยู่ใน `data.json` ของเครื่อง
  CLI `okf lint` ใน CI และเครื่องอื่นจะไม่รู้ว่า zone ไหนเป็น raw และตรวจภาษาผิด ส่วนเหตุผลที่
  ไม่ใส่ใน root `index.md` คือ SPEC §8 อนุญาตให้มี frontmatter แค่ `okf_version` ไฟล์นี้แก้ผ่าน
  MCP ไม่ได้ (tool เขียนได้เฉพาะ `.md`) Agent จึงเปลี่ยนนโยบายเองไม่ได้ ถ้าไม่มีไฟล์ จะใช้ค่า
  ตามตัวอย่างข้างบน
- ไฟล์นอก bundle ถือเป็น **unmanaged** โดยค่าเริ่มต้น MCP มองไม่เห็นไฟล์เหล่านี้ ถ้าเปิด setting
  `exposeUnmanaged: read` จะอ่านได้อย่างเดียว
- Bundle ห้ามซ้อนกัน (bundle root ห้ามอยู่ใต้ bundle อื่น) โดย lint ตรวจ และ create ปฏิเสธ
- ตัวอย่าง layout ที่ใช้เป็น **ค่าเริ่มต้นตอนสร้าง bundle (ไม่บังคับ)** ตาม SPEC §6.3 และ sample
  `acme_retail`:

```
Knowledge/                 # bundle root
  .okf.yaml                # bundle policy (ซ่อนใน Obsidian)
  index.md                 # okf_version: "0.2" + auto index
  log.md                   # auto log
  concepts/  playbooks/  decisions/     # curated zone: ภาษาอังกฤษ
  references/              # external material, skills, attesters
    raw/                   # raw zone: ต้นฉบับที่แปลงเป็น markdown, ภาษาใดก็ได้ (§4.8)
  assets/                  # รูป / ไฟล์แนบ (non-.md ไม่ถูกนับเป็น concept)
```

### 4.2 Concept ID และชื่อไฟล์

- Concept ID คือ path ภายใน bundle ที่ตัด `.md` ออก (SPEC §2)
- **การอ่าน** รับทุก path ที่ผ่าน path guard (§8) รวมถึงไฟล์ที่มนุษย์ตั้งชื่อเอง เช่นมีช่องว่าง
  ตัวพิมพ์ใหญ่ หรือภาษาไทย ถ้าใช้ grammar เข้มตอนอ่าน note เดิมของผู้ใช้จะถูกซ่อนไปทันที
  ไฟล์แบบนี้จะได้ lint `nonportable-id` ระดับ info
- **การสร้างและการย้าย** บังคับ grammar `^[a-z0-9][a-z0-9._-]*$` ต่อ segment ซึ่งแคบกว่า
  reference (`[A-Za-z0-9_][A-Za-z0-9_.\-]*`) แต่ไฟล์ทุกไฟล์ใน sample bundles ผ่าน grammar นี้
  (ตรวจแล้ว) เหตุผลที่เลือก grammar นี้:
  - ตัดปัญหา case-insensitive บน Windows/macOS (`Revenue.md` กับ `revenue.md` จะได้ไม่ชนกัน)
  - URL-safe จึงไม่ต้องใช้ `%20` หรือ `<…>` ใน markdown link
  - ID คงที่เมื่อแก้ title
- **slug เป็นภาษาอังกฤษเสมอ** รวมถึงไฟล์ raw ที่ต้นฉบับเป็นภาษาอื่น (เช่น
  `references/raw/acme-annual-report-2025.md`) ไม่มี option สำหรับชื่อไฟล์ Unicode
  เพราะขัดกับนโยบายภาษา (§4.8)
- `aliases` (key ของ Obsidian ซึ่ง OKF ยอมรับเป็น extension key) ใส่คำในภาษาอื่นได้ **เพื่อใช้ค้นหา
  เท่านั้น** เช่น concept `remote-sensing` อาจมี `aliases: [การรับรู้จากระยะไกล]` ทำให้ Quick
  Switcher และ `okf_search` เจอ concept ภาษาอังกฤษด้วยคำไทย โดยไม่ต้องมีเนื้อหาภาษาไทย
- Reserved: `index.md` และ `log.md` ทุกระดับห้ามเป็น concept (§3.1)

### 4.3 Frontmatter

ตำแหน่งของ key ในเอกสารใหม่:
`type, title, description, resource, language, tags, aliases, status, generated, verified, stale_after, sources, usage_window, original_title, original_format, retrieved_at, content_sha256, …extensions`

**Input ที่มี server-owned field** (`generated`, `verified`, `content_sha256`): ถ้า Agent
ส่งค่ามาแล้ว **เท่ากับค่าปัจจุบัน** (เช่นส่ง frontmatter ทั้งก้อนกลับมาแบบ read-modify-write)
จะยอมรับและข้ามไป ถ้า **ไม่เท่า** จะปฏิเสธ เพื่อให้ Agent ส่ง frontmatter เต็มกลับมาได้โดยไม่ต้อง
ตัด key ออกเอง

| Key | ใครเขียนได้ | กฎ |
|---|---|---|
| `type` | Agent / มนุษย์ | บังคับ ห้ามว่าง และใช้ registry ของ bundle เป็น *คำแนะนำ* เท่านั้น (type ที่ไม่รู้จัก → lint ให้ info ไม่ reject ตาม §11) |
| `title`, `description`, `tags` | Agent / มนุษย์ | **ภาษาอังกฤษทุก zone รวมถึง raw** (§4.8) และเข้มกว่า body คือห้ามมีตัวอักษรที่ไม่ใช่ Latin เลย ชื่อเฉพาะต้องเขียนเป็นอักษรโรมัน (เช่น `THEOS-2`) ส่วนชื่อเดิมไปอยู่ใน `aliases` หรือ `original_title` `description` ต้องเป็นบรรทัดเดียวและยาวไม่เกิน 200 ตัวอักษร (lint warn) `tags` ต้องเป็น lower-kebab ASCII ไม่มีช่องว่างและไม่เป็นตัวเลขล้วน เพราะ Obsidian จะไม่ index (lint warn) |
| `resource` | Agent / มนุษย์ | URI ตาม §6.2 และ **บังคับสำหรับ raw** (ชี้ต้นฉบับ) |
| `language` | Agent / มนุษย์ | extension key ใช้รหัส BCP 47 (`en`, `th`, …) ถ้าไม่ระบุใน curated zone ถือว่า `en` และ **บังคับใน raw zone** |
| `original_title`, `original_format`, `retrieved_at` | Agent / มนุษย์ | extension key สำหรับ raw: ชื่อเดิมในภาษาต้นฉบับ, รูปแบบเดิม (`pdf`/`docx`/`html`/…), เวลาที่ดึงมา (ISO 8601 + offset) |
| `content_sha256` | **server เท่านั้น** | hash ของ body raw ตอน ingest ใช้ตรวจว่าต้นฉบับถูกแก้หรือไม่ |
| `aliases` | Agent / มนุษย์ | ภาษาใดก็ได้ เพราะใช้ค้นหาเท่านั้น (§4.2) |
| `status` | Agent / มนุษย์ (มีเงื่อนไข) | `draft` / `stable` / `deprecated` Agent สร้างได้เป็น `agent_initial_status` (ค่าเริ่มต้น `draft`) เท่านั้น **การเปลี่ยนเป็น `stable` ต้องมาจาก Approve ของมนุษย์ หรือ token ที่มี scope `publish`** ถ้าไม่บังคับแบบนี้ Agent จะ `okf_update` เปลี่ยน `status: stable` เองแล้วข้าม Review Queue ได้ การเปลี่ยนเป็น `deprecated` ทำผ่าน `okf_deprecate` |
| `generated` | **server เท่านั้น** | stamp ทุกครั้งที่ body หรือ frontmatter ที่มีความหมายเปลี่ยน โดย `by` = actor ของ token (§5) |
| `verified` | **server เท่านั้น** | เขียนผ่าน `okf_verify` (machine) หรือ UI "Approve" (human) เท่านั้น ถ้าส่งมาใน write ทั่วไปจะถูกปฏิเสธ |
| `stale_after` | Agent / มนุษย์ | ต้องเป็น ISO 8601 ที่มี UTC offset (§5) ถ้าเป็น date-only จะถูกปฏิเสธตอนเขียน (reference ignore ตอนอ่าน แต่เรากันตั้งแต่ทางเข้า) |
| `sources[]` | Agent / มนุษย์ | `resource` บังคับ, `id` ต้องไม่ซ้ำ, upsert ตาม `id` (§6.3) ถ้า path ชี้เข้าใน bundle จะเขียนเป็นแบบ bundle-absolute (`/references/raw/x.md`) ดู §4.4 "Path ใน frontmatter" |
| key อื่น | ทุกคน | เก็บไว้ตอน round-trip เสมอ (§4.1 "SHOULD preserve") |

**Round-trip fidelity** (ระบุให้วัดผลได้ ไม่ใช้คำว่า "byte-identical" แบบเหมารวม เพราะ library
YAML ใดก็รับประกันการ re-serialize ให้ได้ byte เดิมทุกกรณีไม่ได้):

1. **ถ้า frontmatter ไม่เปลี่ยน** (เช่น patch แค่ body) จะคงข้อความ frontmatter เดิมไว้ทุก byte
   โดยไม่ผ่าน serializer
2. **ถ้า frontmatter เปลี่ยน** จะ **splice ราย top-level key** โดยใช้ `yaml` (`parseDocument`)
   หาช่วงข้อความของแต่ละ key แล้ว render ใหม่เฉพาะ key ที่เปลี่ยน ส่วน key อื่นคงข้อความเดิมทุก byte
   (ADR 0001 S5: Document API แบบ `toString()` ทั้งเอกสารผ่านแค่ 1/54 เพราะ sample ใช้ flow
   padding ปนกัน ส่วนแบบ splice ผ่าน 54/54) ข้อจำกัดคือ comment ภายใน key ที่ถูก render ใหม่จะหายไป
3. **EOL เดิมของไฟล์** (LF หรือ CRLF) ต้องคงไว้ เพราะ vault บน Windows ที่ใช้ git `autocrlf`
   จะเป็น CRLF ทั้งไฟล์ (ADR 0001)
4. **ไม่ใช้** `app.fileManager.processFrontMatter` เพราะมัน re-stringify ทั้ง block
5. **render ตาม style เดิม:** เวลา render key ที่มีอยู่แล้วใหม่ ให้ใช้ style เดิมของ key นั้น (flow หรือ
   block) ส่วน key ใหม่ในไฟล์ที่ทุก collection เป็น block ให้ใช้ block ด้วย ADR 0003 (S4) พบว่า
   Properties UI เขียน frontmatter ใหม่ทั้งก้อนเป็น block style และลบ comment ถ้าไม่ทำแบบนี้ระบบเรากับ
   Obsidian จะสลับ style กันไปมา
6. **parser ต้องทนรูปแบบอื่นได้:** เมื่อมนุษย์แก้ผ่าน Properties UI ของ Obsidian ซึ่ง re-serialize
   ทั้ง block (เช่น `{ by, at }` อาจกลายเป็น block style) ความหมายต้องเหมือนเดิม

Golden test: ไฟล์ทุกไฟล์ใน `open-knowledge-format/bundles/**` เมื่อ patch body ต้องได้ frontmatter
byte เดิม และเมื่อแก้ key หนึ่งตัว diff ต้องอยู่ในบรรทัดของ key นั้นเท่านั้น

### 4.4 Links: wikilink ของ Obsidian เทียบกับ markdown link ของ OKF

OKF กำหนดให้ใช้ **standard markdown link** (§6.1) แต่ Obsidian ใช้ `[[wikilink]]` เป็นค่าเริ่มต้น
ทางที่เลือกคือ:

- **รูปแบบมาตรฐานบนดิสก์คือ markdown link แบบ file-relative** (`[orders](../tables/orders.md)`)
  เหมือนที่ reference agent ใช้ ซึ่ง render ได้ทั้งบน GitHub และ Obsidian และไม่ขึ้นกับว่า bundle
  อยู่ตรงไหนใน vault (absolute `/x.md` ของ OKF หมายถึง bundle root แต่ Obsidian ตีความเทียบ
  vault root ซึ่งตรงกันแค่ตอน bundle = vault)
- การเลือก relative แทน absolute `/` ซึ่ง SPEC §6.1 *แนะนำ* (SHOULD-level) ยังถือว่า conformant
  และตรงกับสิ่งที่ reference agent ทำเอง
- **ตอนรับเข้า (write ผ่าน MCP)** รับทุกรูปแบบ ได้แก่ `[[concept-id]]`, `[[concept-id|label]]`,
  `/abs/path.md`, relative และ `okf:concept-id` แล้ว **normalize เป็น relative markdown link**
  ก่อนเขียน ถ้า link ไปยัง concept ที่ไม่มีอยู่ จะเก็บไว้ (§6.1 tolerate broken links) แต่บอกใน
  result `warnings` กฎเพิ่มเติม:
  - normalize **เฉพาะเนื้อหาที่ Agent ส่งมาในคำขอนั้น** ไม่ไล่แก้ link เดิมที่อยู่ส่วนอื่นของไฟล์
    เพื่อไม่ให้ diff บวมเกินจริง การแปลงทั้ง bundle ทำผ่าน command แยกเท่านั้น
  - ข้าม fenced code, inline code, math (`$…$`) และ HTML comment
  - ถ้า wikilink กำกวม (ชื่อไฟล์ซ้ำหลาย directory) ให้ปฏิเสธพร้อมรายชื่อ candidate และให้ Agent
    ระบุ concept id เต็ม
  - link ที่ชี้ออกนอก bundle ได้ lint `link-outside-bundle` (warn) เพราะทำให้ bundle พกพาไม่ได้
- **bundle ที่นำเข้ามาอาจมี link แบบ `/`** (sample bundles มี 16 จุด) resolver ของเราตีความ
  เทียบ bundle root ส่วน Obsidian น่าจะตีความเทียบ vault root (ต้องยืนยันใน spike S1, §13)
  ดังนั้นตอน Register bundle จะรายงานจำนวน link แบบนี้และเสนอให้แปลง
- **ตอนอ่าน** resolver ของเราเข้าใจทุกรูปแบบ จึงถือว่า note ที่มนุษย์เขียนด้วย wikilink อ่านได้ปกติ
  ส่วน lint จะเตือน `wikilink-in-bundle` และมี command แปลงให้
- Settings tab ตรวจค่า Files & Links ของ vault ("Use [[Wikilinks]]", "New link format") แล้ว
  **เตือน** พร้อมปุ่ม "Apply recommended" ที่ผู้ใช้ต้องกดเอง เราไม่เปลี่ยน setting ของ vault
  โดยอัตโนมัติ
- Embed รูป `![[x.png]]` ได้รับการยกเว้น (OKF ไม่ได้กำหนดเรื่องนี้) แต่ normalize เป็น
  `![](../assets/x.png)` เมื่อเปิด option นี้

**Path ใน frontmatter** (`resource`, `sources[].resource`, `computation`, `executor.resource`,
`attester.resource`) ต้องใช้กฎต่างจาก link ใน body เพราะ:

- SPEC §6.2 บอกว่า path ที่ไม่ขึ้นต้นด้วย `/` เป็น relative path **แต่ sample bundles ใช้แบบ
  bundle-relative ที่ไม่มี `/`** (ตรวจแล้ว: `computations/revenue-ytd.md` มี
  `executor.resource: skills/run-on-bq.md` ซึ่งต้องอ่านเทียบ bundle root จึงจะเจอไฟล์ path
  ที่ไม่ใช่ URL ใน acme_retail มีทั้งหมด 12 จุด) spec กับตัวอย่างจึงขัดกันเอง
- Obsidian ไม่ resolve path ใน frontmatter อยู่แล้ว เหตุผลเรื่อง Obsidian ใน S1 จึงไม่เกี่ยวกับกรณีนี้

กฎที่ใช้:

- **ตอนเขียน** ใช้ bundle-absolute (`/references/raw/x.md`) เสมอ เพราะเป็นรูปแบบเดียวที่ทั้ง
  spec และตัวอย่างตีความตรงกัน และไม่เสียเมื่อย้ายไฟล์
- **ตอนอ่าน** path ที่ไม่มี `/` ให้ลองแบบ document-relative ก่อน ถ้าไม่พบให้ลอง bundle-relative
  ถ้าพบทั้งสองแบบหรือไม่พบเลย จะได้ lint `ambiguous-path` หรือ `broken-path` ส่วน command
  แปลง link จะแปลงให้เป็น bundle-absolute
- **Concept index นับ path เหล่านี้เป็น edge** ใน `okf_graph` และ backlinks ด้วย (SPEC §5.1:
  "the derivation edge already exists in the bundle graph") แต่ graph view ของ Obsidian มองไม่เห็น
  edge จาก frontmatter ดังนั้นตอนสร้าง footnote ที่อ้าง source ภายใน bundle จะเขียน link ไว้ใน
  footnote definition ด้วย เช่น
  `[^acme-ar-2025]: [ACME Annual Report 2025](../references/raw/acme-annual-report-2025.md)`
  การทำเช่นนี้ยังตรง spec เพราะ consumer resolve ผ่าน label กับ `sources[].id` และไม่ได้อ่านจาก
  ข้อความใน footnote

### 4.5 `index.md` (§8)

- สร้างใหม่อัตโนมัติ **ทุก directory ใน bundle** โดย debounce 2 วินาทีหลังมีการเปลี่ยนแปลง
  และเขียนเฉพาะ directory ที่ได้รับผลกระทบ (ตัว concept เองและ ancestor ทั้งหมด)
- ผลลัพธ์ **deterministic**: section แยกตาม `type` (เรียงตามชื่อ), รายการเรียงตาม title
  ด้วย `Intl.Collator('en')` ซึ่งคงที่ทุกเครื่อง (title เป็นภาษาอังกฤษตาม §4.8), บรรทัดเป็น `* [Title](file.md) - description`
  ตาม spec ทุกตัวอักษร
- section `# Subdirectories` ใช้คำอธิบาย directory ที่ **เก็บไว้จาก index เดิม** (มนุษย์หรือ Agent
  แก้ได้ผ่าน `okf_describe_directory`) ถ้ายังไม่มี จะ fallback เป็น
  `"N concepts: <types>"` โดยไม่เรียก LLM
- Concept ที่ `status: deprecated` จะไปอยู่ใน section `# Deprecated concepts` แยกท้ายไฟล์
  ทำให้ Agent ที่ไล่ตาม index ไม่หยิบไปใช้โดยบังเอิญ ส่วน draft แสดงตามปกติแต่มี ` (draft)` ต่อท้าย
  title เพื่อให้ Agent และคนรู้ว่ายังไม่ผ่านการ review
- root `index.md` คง `okf_version` ไว้และไม่มี frontmatter อื่น
- ถ้ามนุษย์แก้ `index.md` เอง การ regenerate รอบถัดไปจะเขียนทับ (มีหมายเหตุใน settings และปิด
  auto-index ราย bundle ได้)
- **เขียนเฉพาะเมื่อเนื้อหาเปลี่ยนจริง** (เทียบ byte ก่อนเขียน) ถ้าใช้ Obsidian Sync หรือ git
  ร่วมกันหลายเครื่อง แต่ละเครื่องจะ regenerate ได้ผลเหมือนกันเพราะ deterministic ทำให้ไม่เกิด
  write วนกลับไปมาและไม่เกิด sync conflict

### 4.6 `log.md` (§9)

- server **append ให้อัตโนมัติ** ที่ bundle root เมื่อมี create / ingest / update / move /
  deprecate / verify / approve / publish / revert โดยจัดกลุ่มตามวัน (`## YYYY-MM-DD`, ใหม่สุดอยู่บน) และ write หลายครั้งในวันเดียว
  จะรวมอยู่ใต้หัวข้อเดียวกัน
- รูปแบบบรรทัด: `* **Update**: [Title](concepts/x.md) — <reason> (by <actor>)`
- tool เขียนทุกตัวรับ `reason` (บังคับสำหรับ update/deprecate) ซึ่งเป็นข้อมูลที่ reference agent
  ไม่มี และช่วยให้ log อ่านแล้วรู้ว่า "ทำไม" ไม่ใช่แค่ "อะไร"
- ไม่เขียน frontmatter ใน `log.md` (sample `acme_retail/log.md` มี `type: Log` ซึ่งไม่ตรงกับ
  §9) แต่เวลาอ่านจะยอมรับไฟล์แบบนั้น
- **Coalesce:** ถ้า (concept, วัน, action, actor) ซ้ำ จะรวมเป็นบรรทัดเดียวและต่อ reason ท้าย
  เพื่อไม่ให้ Agent ที่ update ถี่ ๆ ทำ log บวม ส่วน `okf_history` อ่านแบบแบ่งหน้า
- **วันที่ใช้ UTC** เพื่อให้ตรงกับ `generated.at` และได้ผลเหมือนกันทุกเครื่อง (สำหรับไทย UTC+7
  งานที่ทำก่อน 07:00 จะไปอยู่ในวันก่อนหน้า) ส่วน UI แสดงเป็นเวลาท้องถิ่น
- log เขียนโดยเครื่องที่ทำ write เท่านั้น เครื่องที่ได้รับการเปลี่ยนแปลงมาทาง sync จะไม่เขียนซ้ำ

### 4.7 Attested Computation (§10)

- อ่านได้เต็มรูปแบบ: `okf_read` คืน contract (`runtime`, `parameters`, `executor`, `attester`)
  และ computation (inline fence หรือไฟล์ตาม `computation`) ส่วนโค้ดของ attester หรือ executor ที่ไม่ใช่ markdown
  (เช่น `attesters/*.py`) อ่านด้วย `okf_read_file` (ADR 0007)
- **การแก้ computation ต้องใช้ scope `computations:write`** เพราะ §10.3 กำหนดว่า consumer agent
  "MUST NOT author or edit the computation" ดังนั้น token ทั่วไปแก้ prose ได้ แต่ถ้าแก้ fence
  ใต้ `# Computation`, `computation`, `parameters`, `executor` หรือ `attester` จะถูกปฏิเสธ
- ไฟล์ที่ไม่ใช่ `.md` (เช่น `references/attesters/*.py`) แก้ผ่าน MCP ไม่ได้อยู่แล้ว เพราะ tool
  เขียนได้เฉพาะ concept
- plugin **ไม่รัน** executor หรือ attester ใด ๆ

### 4.8 นโยบายภาษา (Language policy)

**ข้อกำหนด:** ความรู้ที่ใช้งานเก็บเป็นภาษาอังกฤษ ส่วนต้นฉบับ (raw) ที่แปลงมาเก็บไว้เป็นภาษาอื่นได้

bundle แบ่งเป็น 2 zone ตาม path (ไม่ได้แบ่งตาม `type` เพราะ Agent ตั้ง `type` เองได้ จะใช้หลบกฎ
ไม่ได้):

| | Curated zone (ทุก path ยกเว้น raw dirs) | Raw zone (ค่าเริ่มต้น `references/raw/**`, ตั้งได้ใน `raw_dirs` ของ `.okf.yaml`) |
|---|---|---|
| หน้าที่ | ความรู้ที่กลั่นแล้วให้ Agent และคนใช้งาน | สำเนาต้นฉบับที่แปลงเป็น markdown สำหรับใช้อ้างอิงและตรวจย้อน |
| Body | **ภาษาอังกฤษ** | ภาษาต้นฉบับ ห้ามแปล ห้ามสรุป ให้คงเนื้อหาตามต้นฉบับที่แปลงมา |
| Frontmatter (`title`, `description`, `tags`) | ภาษาอังกฤษ | **ภาษาอังกฤษเช่นกัน** ทำให้ index, search และ log เป็นภาษาเดียวทั้ง bundle ส่วนชื่อเดิมเก็บใน `original_title` |
| `type` | อิสระ (ภาษาอังกฤษ) | `Raw Source` |
| `language` | ไม่ระบุ = `en` | บังคับ (BCP 47) |
| การแก้ไข | ปกติตาม §6 | **write-once:** body แก้ไม่ได้ ยกเว้น re-ingest ด้วย scope `raw:write` (§7.2) |
| `index.md`, `log.md` | ภาษาอังกฤษ (server สร้าง) | ภาษาอังกฤษ (server สร้าง) |

**ข้อยกเว้นใน curated zone** (ไม่นับว่าผิดนโยบาย):

- ชื่อเฉพาะและคำศัพท์ต้นฉบับที่ใส่ไว้ในเครื่องหมายคำพูดหรือวงเล็บ เช่น
  `the ACME "ธีออส-2" satellite`
- fenced code, inline code, URL และ footnote definition
- blockquote ที่ยกข้อความต้นฉบับ ต้องมี footnote ชี้ไป raw และควรมีคำแปลภาษาอังกฤษตามหลัง
- `aliases`

**การตรวจ (`okf-core/language.ts`):**

- v1 ตรวจจากชนิดตัวอักษร (script) โดยนับสัดส่วนตัวอักษรที่ไม่ใช่ Latin ใน body หลังตัดข้อยกเว้น
  ข้างบนออก ถ้าเกิน `nonEnglishThreshold` (ค่าเริ่มต้น 5%) หรือ `title`/`description`/`tags`
  มีตัวอักษรที่ไม่ใช่ Latin เลย จะได้ `language-not-english`
- **write ผ่าน MCP ใน curated zone ที่ผิดนโยบายจะถูกปฏิเสธ** ข้อความ error บอก Agent ว่า "แปลเป็น
  ภาษาอังกฤษ แล้วเก็บต้นฉบับด้วย `okf_ingest_raw` และอ้างอิงผ่าน `sources`"
- มนุษย์ที่พิมพ์ภาษาไทยใน curated zone ผ่าน editor จะไม่ถูกบล็อก (server บล็อก editor ไม่ได้)
  แต่จะได้ lint error และเข้า Review Queue
- **ข้อจำกัดที่ต้องรู้:** การตรวจจาก script จับได้เฉพาะภาษาที่ไม่ใช้อักษร Latin (ไทย, จีน, ญี่ปุ่น,
  อาหรับ ฯลฯ) ภาษาที่ใช้อักษร Latin (เช่น ฝรั่งเศส, อินโดนีเซีย) จะหลุด ถ้าต้องการจับด้วย ให้เพิ่ม
  language identifier แบบ n-gram (เช่น `franc-min`) เป็น option ใน Phase 4

**Workflow: กลั่นจาก raw เป็น concept**

```
ต้นฉบับ (PDF/เว็บ/เอกสารไทย)
  → Agent แปลงเป็น markdown ฝั่ง client (plugin ไม่ parse PDF ใน v1)
  → okf_ingest_raw  → references/raw/<slug>.md   (ภาษาเดิม, write-once, content_sha256)
  → Agent อ่าน raw, แปล/กลั่นเป็นภาษาอังกฤษ
  → okf_create/okf_update ใน curated zone
       sources: [{ id: <slug>, resource: /references/raw/<slug>.md, language: th, … }]
       ทุก claim มี footnote [^<slug>] และ footnote definition มี link ไป raw (§4.4)
```

- การกลั่นใช้กลไก lineage ที่ SPEC §5.1 มีอยู่แล้ว คือเมื่อ `sources[].resource` ชี้ไปที่ concept
  อื่นใน bundle ก็จะเกิด edge ในกราฟ จึงไม่ต้องสร้าง field ใหม่
- `okf_search` filter `unprocessed_raw: true` คืน raw ที่ยังไม่มี concept ใดอ้างถึง ซึ่งใช้เป็น
  คิวงาน "ยังไม่ได้กลั่น" และ lint `raw-unreferenced` (info)
- lint `table-uncited` (warning) จะแจ้งเมื่อ curated concept ที่อ้าง raw มีตารางที่ไม่มี footnote อยู่ข้างใน
  footnote ต้องอยู่ในตารางเอง จะอยู่ในย่อหน้าก่อนตารางไม่นับ agent eval พบว่าตารางเป็นจุดที่ Agent ลืมใส่ footnote บ่อยที่สุด
  (ADR 0004) เมื่อเขียนผ่าน MCP warning นี้จะกลับไปใน result ทันที Agent จึงแก้ได้ในรอบเดียวกัน
- lint `raw-modified` (error) เมื่อ hash ของ body raw ไม่ตรง `content_sha256` คือมีคนแก้ต้นฉบับ
  นอก flow ingest ถ้ามนุษย์ตั้งใจแก้ (เช่นแก้ข้อผิดพลาดจากการแปลง PDF) ให้ใช้ command
  "Accept raw edit" ซึ่งคำนวณ hash ใหม่และเขียน log ทำได้เฉพาะมนุษย์ผ่าน UI
- `sources[].resource` ที่ชี้ไป raw ใช้รูปแบบ `/references/raw/<slug>.md` ตามกฎ
  "Path ใน frontmatter" (§4.4) ซึ่ง `okf_create`/`okf_update` แปลงให้อัตโนมัติ
  และเติม `language` ของ raw ให้ถ้า Agent ไม่ได้ระบุ

---

## 5. Identity, actor และ trust

**นี่คือจุดที่เราต่างจากต้นแบบทั้งสองมากที่สุด** ใน reference agent ผู้เรียกกำหนด `generated.by`
ได้เอง และใน local-rest-api ไม่มีแนวคิดเรื่อง actor เลย

| แหล่งที่มาของ write | actor ที่ stamp |
|---|---|
| MCP token ชื่อ `claude-code` | `claude-code/<model>` โดยค่า `<model>` มาจาก argument ร่วม `actor_version` ที่ทุก write tool รับ (ไม่บังคับ, ต้องตรง `[A-Za-z0-9._-]{1,64}`) หรือ `clientInfo.version` ส่วน prefix มาจาก token เสมอ ชื่อ token จึงต้องตรง grammar เดียวกับ concept-id segment |
| token ประเภท `process` (เช่น nightly job) | `process:<token-name>` |
| มนุษย์แก้ใน Obsidian editor | `human:<userId>` (ตั้ง userId ใน settings เช่น `human:ys`) |
| UI command "Approve / Mark verified" | `verified += { by: human:<userId>, at }` (ถ้ายังไม่ได้ตั้ง `userId` command นี้และการ stamp human edit จะถูกปิด และ settings จะแจ้งเตือน) |

กฎ:

1. **Token ใด ๆ stamp actor `human:` ไม่ได้** ถ้า argument ที่ส่งมามี `human:` จะถูกปฏิเสธ
   เพราะ trust tier "human-reviewed" ต้องมาจากคนที่นั่งอยู่หน้า Obsidian เท่านั้น
2. **การตรวจจับว่ามนุษย์แก้ไฟล์ต้องใช้สัญญาณเชิงบวก** ไม่ใช่ "hash ไม่ตรงกับ ledger" ใน v0.1
   ถ้ายึด ledger อย่างเดียว การแก้ link อัตโนมัติจาก `renameFile`, ไฟล์ที่ Obsidian Sync หรือ
   `git pull` ดึงมา และ plugin อื่น (Linter, Templater) จะถูกตีความเป็น `human:` ทั้งหมด
   ซึ่งทำลายสิ่งที่ §5 พยายามรับประกัน กฎใหม่:
   - **human edit** = CodeMirror transaction บนไฟล์ใน bundle ที่มี `userEvent` ขึ้นต้นด้วย `input`,
     `delete`, `undo`, `redo` หรือ `move` ตรวจผ่าน `registerEditorExtension` +
     `EditorView.updateListener` แล้วตั้ง flag `humanDirty` ราย path **ไม่ใช้ `editor-change`** เพราะ
     ADR 0003 (S3) พบว่า event นี้เกิดกับทุกการเปลี่ยนแปลงของไฟล์ที่เปิดอยู่ รวมถึง sync, git,
     `renameFile` และการเขียนของระบบเอง (ทั้งหมดเป็น `userEvent: "set"` หรือไม่มี userEvent)
   - **Properties UI ไม่นับว่าเป็นคนแก้** เพราะมี userEvent เป็น `set` เหมือนการโหลดจากดิสก์ จึงแยกกัน
     ไม่ได้อย่างเชื่อถือได้ หลักการคือนับว่าคนแก้เฉพาะเมื่อมีหลักฐานชัด (false negative ทำให้ provenance
     ไม่ครบ แต่ false positive ทำลาย trust) ส่วนการแก้ `verified`/`status` ผ่าน Properties จะถูก §5.1 จับเป็น
     `unattested-*` และควรใช้คำสั่ง Approve แทน
   - **การ stamp เกิดเมื่อไฟล์ออกจาก editor** (`active-leaf-change` หรือปิด tab) หรือเมื่อ idle
     เกิน 60 วินาที ถ้าไฟล์ยังเปิดอยู่จะเขียนผ่าน CodeMirror dispatch พร้อม
     `Transaction.addToHistory.of(false)` ซึ่ง ADR 0003 (S2) วัดแล้วว่าข้อความไม่หาย cursor ไม่กระโดด
     และไม่เข้า undo history ของคน **ห้ามใช้ `vault.process` กับไฟล์ที่เปิดอยู่** เพราะบางครั้งทำข้อความที่
     กำลังพิมพ์เสียหายและยังเข้า undo history ด้วย
   - stamp เฉพาะเมื่อ body หรือ key ที่มีความหมายเปลี่ยน (ไม่นับ `verified` และ `aliases`) และ
     ไม่ stamp ไฟล์ reserved (`index.md`, `log.md`)
   - การเปลี่ยนแปลงอื่นทั้งหมด (sync, git, plugin อื่น, เครื่องมือ filesystem) = **external**
     จะไม่ stamp และถูกบันทึกใน audit ว่า "external change"
   - *self-write ledger* (path → hash ที่ server เพิ่งเขียน) ยังจำเป็น เพื่อไม่ให้ server ตีความ
     write ของตัวเองเป็น external
   - setting `stampHumanEdits` (ค่าเริ่มต้น on)
3. **Derived signal ที่ไม่ได้เก็บลงไฟล์:** `verification_outdated = max(verified.at) < generated.at`
   คำนวณตอนอ่าน (§5.2 บอกว่าสองค่านี้อิสระต่อกัน เราจึงไม่ลบ `verified` ทิ้งเมื่อเนื้อหาเปลี่ยน
   แต่บอก Agent และ Review Queue ให้รู้)
4. **Agent สร้างเป็น `draft` ตามค่าเริ่มต้น** แล้วมนุษย์กด Approve ใน Review Queue ซึ่งจะเปลี่ยน
   เป็น `status: stable` และเพิ่ม `verified` เป็น human ได้ human-in-the-loop โดยไม่ขวาง Agent

### 5.1 Threat model ของ trust (ขอบเขตที่รับประกันได้จริง)

การรับประกันใน §5 **ครอบคลุมเฉพาะ write ที่ผ่าน MCP ของเรา** ไฟล์ markdown แก้จากที่อื่นได้
เสมอ เช่น Agent ที่มีสิทธิ์ filesystem บน folder ของ vault (Claude Code เปิดใน vault), git หรือ
script ซึ่งพิมพ์ `verified: { by: human:ys }` ลงไปเองได้ และ SPEC §5.3 ก็ระบุว่า trust tier เป็น
"advisory signal, not access control" เราจึง **ไม่อ้างว่ากันได้** แต่ทำให้ **ตรวจพบได้**:

- plugin เก็บ *trust snapshot* (concept → hash ของ `verified` และ `status` ล่าสุดที่ผ่าน
  `okf_verify`, Approve หรือ publish) ไว้ใน plugin data
- เมื่อมี external change ที่ทำให้ `verified` หรือการเปลี่ยนเป็น `status: stable` ไม่ตรงกับ
  snapshot จะได้ lint `unattested-verification` หรือ `unattested-publish` (error) และ concept จะเข้า Review Queue ส่วน `okf_read` และ
  `okf_search` รายงาน `trust_attested: false` และ Agent ฝั่ง consumer ควรถือว่าเป็น unverified
- คำแนะนำในเอกสารผู้ใช้: อย่าให้ Agent มีสิทธิ์เขียน filesystem ตรงบน folder ของ bundle ให้ใช้
  MCP แทน
- ข้อจำกัด: snapshot อยู่ใน plugin data ของเครื่องนั้น เครื่องที่ไม่มี snapshot (เช่น clone ใหม่)
  จะเริ่มจาก "trust ตามที่ไฟล์บอก" จนกว่าจะ Approve ใหม่

### 5.3 Auto approve และ Reject (2026-10-22, D12)

- **Auto approve** (ค่าเริ่มต้นปิด): เจ้าของเลือก token และ bundle ใน settings เมื่อ token นั้น `okf_create`
  หรือ `okf_update` concept ใน curated zone แล้ว `KnowledgeService.approvalBlockers` คืนรายการว่าง
  server จะ approve ทันทีใน write เดียวกัน (อยู่ในคิวของ bundle เดียวกัน) เป็น `process:auto-approve`
  - ผล: `status: stable` และ `verified += { by: process:auto-approve }` จึงได้ trust tier
    `machine-confirmed` **ไม่ใช่** `human-reviewed` (กฎข้อ 1 ของ §5 ยังเหมือนเดิม)
  - approve ภายใน write เดียวกัน เพื่อให้ result ที่ Agent ได้มี etag ของไฟล์ที่ approve แล้ว ถ้า approve ทีหลัง
    `okf_update` ครั้งถัดไปของ Agent จะ conflict
  - log.md มีสองบรรทัด (Creation/Update ของ Agent และ Approval ของ `process:auto-approve`) และมี snapshot
    สองชุด จึง revert ได้
  - core อนุญาต `approve` ให้ writer ที่มีทั้ง scope `verify` และ `publish` เพราะสองอย่างนี้รวมกันก็ทำได้เท่ากัน
    ไม่มี token ของ MCP ตัวไหนส่ง `approve` ได้
- **เงื่อนไข** (`approvalBlockers` ต้องว่าง):
  - concept เป็น `draft`, unverified หรือ `verification_outdated`
  - ไม่เคยมีคน approve: ถ้าเคยมี `verified` ที่เป็น `human:` การ approve ด้วยเครื่องจะทำให้ verification เก่า
    ดูเป็นปัจจุบัน และ trust tier ยังเป็น `human-reviewed` ทั้งที่ไม่มีคนดูเนื้อหาใหม่ concept แบบนี้จึงกลับไปหาคนเสมอ
  - ไม่มี `review_requested`
  - มี `sources` และมี footnote อ้าง source อย่างน้อยหนึ่งตัว
  - ไม่มี lint error หรือ warning และไม่มี `source-uncited`
  - ตรวจได้เฉพาะโครงสร้าง ไม่ได้ตรวจว่าเนื้อหาถูก (ข้อจำกัดเดียวกับ agent eval)
- **Reject** (Review Queue และคำสั่ง "Reject the agent's latest change to this note…"): คนพิมพ์เหตุผล
  แล้ว server revert commit ล่าสุดที่ token เขียนบน concept นั้น (snapshot อายุ 7 วัน) draft ใหม่ไปถังขยะ
  ส่วนการแก้ของเดิมจะถูกย้อนกลับ ถ้า commit ล่าสุดเป็น auto approve จะ revert ทั้ง approval และ write
  ที่มันอนุมัติ เหตุผลถูกบันทึกใน log.md เป็น `Rejected: <reason> (revert of commit <id>)` และ server
  instructions บอก Agent ให้อ่านเหตุผลนี้ใน `okf_history` ก่อนเขียน concept นั้นใหม่

---

## 6. Write pipeline (`BundleService.commit`)

ทุก write (MCP หรือ UI) ผ่านขั้นตอนเดียวกันตามลำดับ:

```
1. authorize    token scope ⊇ operation, bundle/path อยู่ใน allowlist ของ token,
                ยังไม่เกิน write quota และยังไม่ถูกสั่ง "Pause agent writes"
2. resolve      concept_id → path (grammar §4.2 + path guard ที่ port จาก vaultPath.ts)
3. enqueue      เข้า **write queue ของ bundle** (ทำทีละงาน ส่วน read ไม่ต้องรอคิว)
4. read+check   อ่านเนื้อหาปัจจุบัน แล้วตรวจ if_match (ETag = sha256 ของ bytes) ถ้าไม่ตรง → 409 พร้อม ETag ใหม่
5. guard-input  ตรวจ input ก่อนแปลง: server-owned fields (§4.3), การเปลี่ยน status (publish),
                zone ของ tool (create ห้ามลง raw และ ingest ห้ามลง curated)
6. build        apply frontmatter patch / body patch บน Document AST
7. normalize    links ในเนื้อหาใหม่ + path ใน frontmatter (§4.4), key order สำหรับเอกสารใหม่,
                stamp generated
8. guard-result ตรวจผลลัพธ์: non-destructive (§6.4), computation (§4.7),
                language policy + raw write-once (§4.8)
9. validate     okf-core validate: เป็น error ที่เกิดใหม่ → reject, warning → แนบใน result ทุกตัวที่ concept ยังมีอยู่
                (ไม่ใช่เฉพาะตัวที่เกิดใหม่ เพื่อให้ Agent ที่พยายามแก้รู้ว่ายังแก้ไม่สำเร็จ ดู ADR 0004)
10. snapshot    เก็บเนื้อหาก่อนเขียนลง snapshot store โดยใช้ commit id เดียวสำหรับทุกไฟล์ที่ commit นี้แตะ (§6.7)
11. write       ไฟล์ที่ **เปิดอยู่** ใน MarkdownView: CodeMirror dispatch แบบ minimal diff พร้อม
                addToHistory.of(false) แล้วให้ autosave ของ Obsidian เขียนลงดิสก์ (ADR 0003) ถ้ามี input
                userEvent ภายใน 10 วินาทีล่าสุด ตอบ 409 `being-edited` แทน
                ไฟล์ที่ **ไม่ได้เปิด**: vault.process(file, fn) โดย fn ทำงานแบบ synchronous จึงเทียบ hash
                ของ `data` กับ ETag จากขั้น 4 อีกครั้ง ถ้าไม่ตรงคืนข้อมูลเดิมแล้วตอบ 409
                ไฟล์ใหม่ใช้ vault.create ซึ่งจะ fail ถ้ามีไฟล์อยู่แล้ว
12. ledger      บันทึก hash ใน self-write ledger (§5)
13. side effects index.md / log.md (ทำในคิวเดียวกัน), audit log (jsonl), in-memory index,
                trust snapshot (เมื่อ verify/publish)
14. result      { concept_id, path, etag, trust_tier, status, warnings[], diff_summary, commit_id }
```

**ทำไมแยก guard-input กับ guard-result:** v0.3 วาง guard ไว้หลังขั้น stamp `generated` จึง
แยกไม่ออกว่าค่าที่เห็นเป็นค่าที่ Agent ส่งมาหรือค่าที่ server เพิ่งใส่ การตรวจ server-owned field
ต้องทำกับ input ส่วนการตรวจภาษาและการลดเนื้อหาต้องทำกับผลลัพธ์สุดท้าย

**ทำไมใช้ write queue ระดับ bundle แทน mutex ราย path (v0.1):** การ move ใช้
`renameFile` ซึ่งแก้ link ในไฟล์อื่นอีกหลายไฟล์ และ `index.md`/`log.md` ก็เป็นไฟล์ที่ทุก write
ใช้ร่วมกัน mutex ราย path จึงกันการชนกันข้ามไฟล์ไม่ได้ ส่วน vault ส่วนตัวมีคนเขียนน้อยอยู่แล้ว
จึงใช้ single writer ต่อ bundle ได้ ง่ายกว่าและถูกต้องกว่า

### 6.1 ETag และ conflict

- `okf_read` คืน `etag` และ write ทุกตัวรับ `if_match`
- `okf_update` **บังคับ** `if_match` โดยค่าเริ่มต้น (setting `requireIfMatch`) ทำให้ Agent ต้องอ่าน
  ก่อนเขียน ซึ่งเป็นสิ่งที่ prompt ของ reference agent "ขอร้อง" ไว้ แต่เราบังคับจริงที่ server
- ETag ของไฟล์ที่เปิดอยู่คำนวณจาก **buffer ของ editor** ไม่ใช่จากดิสก์ เพราะ buffer อาจมีส่วนที่พิมพ์ไว้แล้ว
  แต่ autosave ยังไม่ได้เขียนลงดิสก์ (ADR 0003)

### 6.2 Body patch

- full replace หรือ **section operations ตาม heading path** (`replace` / `append` / `prepend`
  / `delete` ใต้ `["Schema"]`) โดยใช้ engine `markdown-patch` (MIT, ตัวเดียวกับที่
  local-rest-api ใช้) เพื่อไม่ต้องเขียน markdown surgery ใหม่
- `okf_read` แบบ `view: "outline"` คืน heading tree และ footnote/source ids ให้ Agent patch
  ได้แม่นโดยไม่ต้องโหลดทั้งไฟล์

### 6.3 Frontmatter patch

- ใช้ JSON Merge Patch (RFC 7386) กับ key ทั่วไป
- `sources` มี operation เฉพาะ ได้แก่ `sources_upsert: [...]` (match ตาม `id`) และ
  `sources_remove: [ids]` ทำให้ Agent ไม่ต้องส่ง list ทั้งชุดและไม่เผลอลบ entry เก่า
- `tags` มี `tags_add` / `tags_remove`

### 6.4 Non-destructive guard

ต่อยอดจาก augmentation guard ของ reference agent (`bundle_tools.py`) ระบบจะ **ปฏิเสธ** write ที่:

- ทำให้จำนวน `sources` ลดลง
- ลบ footnote `[^id]` ที่ยังถูกอ้างถึงอยู่
- ลบ field ใน `# Schema`
- ทำให้ body สั้นลงเกิน 50%

ยกเว้นเมื่อส่ง `allow_shrink: true` พร้อม `reason` ซึ่งจะถูกบันทึกลง log.md
ข้อความ error เขียนให้ Agent แก้ตัวเองได้ เช่น "re-read, merge, retry"

### 6.5 Move / rename

`okf_move` ใช้ `app.fileManager.renameFile` แต่ Obsidian จะแก้ link ในไฟล์อื่นให้ก็ต่อเมื่อผู้ใช้เปิด
"Automatically update internal links" ไว้ (ADR 0003 ยืนยันว่าเมื่อเปิด setting นี้ Obsidian แก้ทั้ง markdown link และ wikilink ให้) ดังนั้น
การ rewrite ของเราต้อง **idempotent** คือแก้เฉพาะ link ที่ยังชี้ path เก่า และ okf-core จึง **รับผิดชอบการ rewrite เอง
ทั้งหมด** ภายใน bundle ซึ่งประกอบด้วย inbound link จาก concept อื่น และ outbound relative link
ของไฟล์ที่ย้าย (เพราะ base directory เปลี่ยน) และไม่พึ่ง setting นั้น จากนั้น regenerate index
ของทั้ง directory เก่าและใหม่ แล้วเขียน log ไฟล์อื่นที่ถูกแก้ระหว่างนี้จะถูกบันทึกใน ledger
จึงไม่ถูกตีความว่าเป็น human edit หรือ external

### 6.6 Delete

ไม่มี hard delete ผ่าน MCP ทางที่แนะนำคือ `okf_deprecate` ส่วน `okf_delete` (ต้องใช้ scope
`delete`, ปิดเป็นค่าเริ่มต้น) จะย้ายไป `.trash` ของ Obsidian เท่านั้น และปฏิเสธถ้ายังมี backlink
เว้นแต่ส่ง `force`

### 6.7 กันความเสียหายจาก Agent ที่ทำงานผิดพลาด

- **Write quota ต่อ token:** ค่าเริ่มต้น 30 write/นาที และ 500/วัน ถ้าเกินจะได้ 429 พร้อม
  `retry_after`
- **Kill switch:** ปุ่ม "Pause agent writes" ใน status bar และ command palette ทำให้ write
  ทุก token ได้ 503 ทันที ส่วน read ยังทำงาน
- **Snapshot store:** เก็บเนื้อหาก่อน write แต่ละครั้งใน plugin data เป็นเวลา 7 วัน (จำกัด
  50 MB) โดยจัดกลุ่มตาม `commit_id` (การ move อาจแตะหลายไฟล์และต้องย้อนพร้อมกัน) และมี command
  "Revert last agent change…" ที่เลือก commit, concept หรือ token แล้วย้อนกลับได้ การ revert ก็
  ผ่าน pipeline นี้ด้วย จึงมี log และ stamp ครบ ถ้าไฟล์ถูกแก้หลัง commit นั้นแล้ว จะแสดง diff
  ให้มนุษย์ยืนยันก่อน
- **Snapshot store และ audit ต้องไม่ถูก sync:** เก็บใน `<configDir>/plugins/okf-wiki/state/`
  ซึ่ง settings แนะนำให้ใส่ใน `.gitignore` ถ้า `.obsidian` อยู่ใน git เพราะเป็นข้อมูลของเครื่องนั้น
  และอาจมีขนาดใหญ่
- คำแนะนำเพิ่มเติม: ใช้ git กับ folder ของ bundle (OKF แนะนำอยู่แล้ว) และเปิด core plugin
  File Recovery

---

## 7. MCP surface

ออกแบบให้ **tool น้อยแต่มีความหมาย**, ตั้งชื่อ `okf_*` และมี structured `outputSchema` ทุกตัว
รวมทั้งใส่ annotation ตามต้นแบบ

### 7.1 Tools: อ่าน (scope `read`)

| Tool | หน้าที่ |
|---|---|
| `okf_bundles` | รายการ bundle: root, okf_version, จำนวน concept ตาม type/status/tier และจำนวน lint issue |
| `okf_browse` | `{bundle, dir}` → index ของ directory (สร้างจาก in-memory index แบบ live ตรงกับ `index.md`) เป็นทางเข้าหลักของ progressive disclosure |
| `okf_read_file` | `{path, offset?, max_chars?}` → ไฟล์ข้อความที่ไม่ใช่ markdown (`.py .sql .json .yaml .csv` ฯลฯ) แบบแบ่งหน้า ใช้ path scope ของ token และ disk guard เหมือน concept ไม่อ่านไฟล์ binary (ADR 0007) |
| `okf_read` | `{concept_id, view: full\|outline\|frontmatter\|section, section?, offset?, max_chars?}` (`offset` ใช้อ่าน raw ยาว ๆ ทีละช่วง) → frontmatter, body, `etag` และ **derived**: `trust_tier`, `is_stale`, `verification_outdated`, `outlinks`, `backlinks` ("cited by"), `broken_links`, `sources` ที่ resolve แล้ว |
| `okf_search` | `{query?, type?, tags?, status?, min_trust?, stale?, bundle?, under?, include_raw?, unprocessed_raw?, language?, limit, cursor}` → hit พร้อม snippet, description, trust และ `zone` โดยค่าเริ่มต้น **ค้นเฉพาะ curated zone**, **ไม่รวม deprecated** และ **ติดธง stale** ใช้ BM25 (MiniSearch) กับ title/description/tags/aliases/body โดยใช้ tokenizer ตัวเดียว คือคำจาก `Intl.Segmenter(undefined, {granularity: 'word'})` (ICU ตัดคำไทยและ CJK ด้วย dictionary) **รวมกับ character bigram** ของช่วงข้อความไทย/CJK เพราะ ICU ตัดคำเดียวกันต่างกันตามบริบท (ADR 0001 S7) คำค้นภาษาไทยจะเจอ curated concept ผ่าน `aliases` และเจอ raw เมื่อส่ง `include_raw` raw ใช้ index แยกที่สร้างเมื่อถูกค้นครั้งแรก และ index body ไม่เกิน 200 KB ต่อไฟล์ เพื่อคุมการใช้หน่วยความจำ |
| `okf_graph` | `{concept_id, depth≤2, direction}` → node และ edge รอบ concept โดย edge มาจากทั้ง link ใน body และ path ใน frontmatter (`sources`, `executor`, …) และระบุชนิด `link`/`source`/`computation` |
| `okf_lint` | `{bundle \| concept_id}` → conformance (§11) และ quality issue พร้อม `fix_hint` |
| `okf_history` | `{bundle, concept_id?, since?}` → entry จาก log.md (และ audit log ของ token นั้น) |

### 7.2 Tools: เขียน (scope `write` เว้นแต่ระบุไว้)

| Tool | หน้าที่ |
|---|---|
| `okf_create` | `{concept_id, frontmatter, body, reason?}` โดยไฟล์ต้องยังไม่มี, status เป็น `draft` ตามค่าเริ่มต้น และ generated ถูก stamp ใช้ได้เฉพาะ curated zone (ส่วน raw ต้องใช้ `okf_ingest_raw`) |
| `okf_ingest_raw` | `{slug, dir?, title, description, language, resource, original_title?, original_format?, retrieved_at?, body, tags?}` → สร้างไฟล์ `<raw_dir>/<slug>.md` (`dir` ต้องอยู่ใน `raw_dirs`, ค่าเริ่มต้นคือตัวแรก) (`type: Raw Source`) โดย server ใส่ `content_sha256` ให้ ถ้า body ที่มี hash เดียวกันมีอยู่แล้วใน bundle จะคืน id เดิมแทนการสร้างซ้ำ ส่วน `title`/`description`/`tags` ต้องเป็นภาษาอังกฤษ ถ้าส่ง `replace: true` + `if_match` + `reason` จะ re-ingest แทนไฟล์เดิมได้ ซึ่งต้องใช้ scope `raw:write` |
| `okf_update` | `{concept_id, if_match, frontmatter_patch?, sources_upsert?, body? \| body_ops?, reason, allow_shrink?}` |
| `okf_move` | `{from, to, if_match, reason}` |
| `okf_deprecate` | `{concept_id, replaced_by?, reason}` → `status: deprecated` และเพิ่มบรรทัด "Superseded by [x](…)" ไว้ต้น body (รูปแบบเดียวกับ `gross-margin-legacy.md`) |
| `okf_describe_directory` | `{bundle, dir, description}` → คำอธิบาย directory ที่ใช้ใน index |
| `okf_verify` *(scope `verify`)* | `{concept_id, if_match, note}` → เพิ่ม `verified` เป็น machine actor (ไม่มีทางได้ `human:`) |
| `okf_publish` *(scope `publish`, ไม่มีใน token ปกติ)* | `{concept_id, if_match, reason}` → `draft` → `stable` สำหรับ process ที่เชื่อถือได้ ส่วนมนุษย์ใช้ Approve ใน UI |
| `okf_request_review` | `{concept_id, note}` → เข้า Review Queue ของมนุษย์ |
| `okf_delete` *(scope `delete`, ปิดเป็นค่าเริ่มต้น)* | ดู §6.6 |

### 7.3 Resources และ prompts

- `okf://spec` คือสรุป OKF v0.2 สำหรับ Agent (ย่อจาก SPEC.md, ราว 2k tokens)
- `okf://{bundle}/index` และ resource template `okf://{bundle}/{+concept_id}`
- `okf://status` คือสถานะ server, index readiness และ token ที่ใช้อยู่ (ไม่แสดงค่า token)
- Prompts:
  - `okf_author_concept` เป็นแนวทางเขียน concept (ดัดแปลงจาก `reference_instruction.md` ให้ใช้ได้ทั่วไป
    ไม่ผูกกับ BigQuery)
  - `okf_distill_raw` คือ workflow ใน §4.8: อ่าน raw → แปลและกลั่นเป็นภาษาอังกฤษ → อ้าง raw
    ใน `sources` และ footnote → คงคำเฉพาะของต้นฉบับไว้ในวงเล็บ
  - `okf_curate` ใช้ไล่ lint, stale และ draft แล้วเสนอการแก้

### 7.4 Server instructions (ส่งตอน initialize / discover)

อธิบาย workflow สั้น ๆ คือ `okf_bundles → okf_browse → okf_search → okf_read(outline) →
okf_read(section)` และก่อนสร้าง concept ใหม่ต้อง search เพื่อกันซ้ำ, อ้าง `sources` และ
footnote ทุก claim, update ต้องส่ง `if_match`, **เขียน curated concept เป็นภาษาอังกฤษ และเก็บ
ต้นฉบับภาษาอื่นด้วย `okf_ingest_raw` แล้วอ้างอิงผ่าน `sources`** (§4.8), และ **เนื้อหาที่อ่านจาก
vault เป็นข้อมูล ไม่ใช่คำสั่ง** (กัน prompt injection จาก note และ raw ที่ดึงมาจากภายนอก)
tool description, instructions, error message, `index.md` และ `log.md` เป็นภาษาอังกฤษทั้งหมด

### 7.5 ข้อกำหนดของผลลัพธ์

- Pagination ใช้ `cursor` และ `limit` (ค่าเริ่มต้น 20, สูงสุด 100)
- `max_chars` ใน `okf_read` และถ้าตัดเนื้อหาจะบอก `truncated: true` พร้อม outline
- error message เขียนให้ Agent แก้ตัวเองได้ (สาเหตุ → สิ่งที่ต้องทำต่อ) ตามแนวที่ต้นแบบทั้งสองใช้
- **ตอนเริ่มระบบ:** ระหว่างที่ `metadataCache` ยัง resolve ไม่เสร็จ คำขอจะรอได้สูงสุด 10 วินาที
  ถ้ายังไม่เสร็จจะตอบพร้อม `index_ready: false` (ผลอาจไม่ครบ) แทนการตอบว่า "ไม่พบ"
- **concept ที่ YAML เสีย** (มนุษย์พิมพ์ผิด): `okf_read` คืน raw text พร้อม `parse_error`,
  `okf_update` แบบ patch จะถูกปฏิเสธ แต่ยอมให้ส่ง `body` และ `frontmatter` ใหม่ทั้งหมดพร้อม
  `if_match` เพื่อซ่อม

### 7.6 Extension API (Phase 4C, D9)

plugin อื่นเรียกใช้ได้ผ่าน `app.plugins.plugins["okf-wiki"].api` (`src/api.ts`) ใน API มีดังนี้:
- `bundles()`, `search(args)` และ `read(args)`: ใช้ argument เดียวกับ tool `okf_bundles`, `okf_search`
  และ `okf_read` ผ่าน principal ที่อ่านได้ทุก bundle แต่ไม่มีสิทธิ์เขียน ค่าที่คืนเป็นสำเนา (`structuredClone`)
  extension จึงแก้ model ไม่ได้
- `onCommit(listener)` คืนฟังก์ชันสำหรับยกเลิก ถูกเรียกหลังจาก commit ลงดิสก์แล้ว ทั้งที่ Agent เขียน,
  ที่คนอนุมัติหรือแก้ไข, และที่ revert
  - event ประกอบด้วย `{ commitId, at, bundle, actor, tool, conceptId, reason?, reverts?, changes }`
    โดย `changes` เป็นรายการไฟล์ที่เขียนจริงพร้อมสถานะ created/modified/deleted ไม่มีเนื้อหาไฟล์
  - revert ส่ง event เดียวที่มีทั้งไฟล์ที่กู้คืนและ index/log
- **ไม่มีทางเขียนผ่าน API:** object ถูก freeze และไม่มี reference ไปยัง `WriteService`
- listener ทำงานหลังการเขียนผ่าน `setTimeout` ถ้า listener ช้าหรือ throw จะไม่กระทบการเขียน
  และไม่กระทบ listener ตัวอื่น
- เมื่อ plugin unload: listener ถูกล้าง และ API ตัวเก่าจะ throw extension ต้องขอ API ใหม่หลัง plugin โหลดอีกครั้ง
- `apiVersion` จะเพิ่มขึ้นเมื่อมีการเปลี่ยนแบบไม่เข้ากัน
- type ยังไม่ได้ publish เป็น npm package จนกว่าจะมี extension จริง ใช้ `src/api.ts` และ README ไปก่อน
- sync ไป knowledge graph ภายนอก และ semantic search จะทำเป็น plugin แยกบน API นี้

---

## 8. Transport และ security

| ด้าน | การออกแบบ |
|---|---|
| Bind | `127.0.0.1` เท่านั้น ถ้าจะ bind interface อื่นต้องเปิด "Dangerous: allow non-loopback" ซึ่งบังคับใช้ HTTPS และแสดงคำเตือนแดง |
| Protocol | ค่าเริ่มต้น HTTP บน loopback (port 27150) เพราะ MCP client ส่วนใหญ่ (Claude Code, mcp-remote) มีปัญหากับ self-signed cert และต้นแบบเองก็ต้องเขียน fallback HTTP ไว้ใน README ส่วน HTTPS + local CA (port จาก `certificates.ts`) เลื่อนไปจนกว่าจะต้อง bind นอก loopback (D10) |
| DNS rebinding | ตรวจ `Origin` ทุกคำขอตามที่ MCP Streamable HTTP กำหนด ("MUST validate") ด้วย `originValidation(allowlist)` ของ SDK (allowlist ค่าเริ่มต้นว่าง จึงปฏิเสธทุกคำขอที่มี Origin) และตรวจ `Host` ด้วย `localhostHostValidation()` ส่วน `localhostOriginValidation()` ไม่ใช้ เพราะยอม localhost ทุก port (ADR 0001 S6) ต้นแบบไม่ตรวจทั้งสองอย่าง (ตรวจโค้ดแล้ว) |
| CORS | **ไม่ส่ง** header `Access-Control-Allow-*` เลย และปฏิเสธ preflight ด้วย 403 เพราะ client ของเราไม่ใช่ browser (ต้นแบบส่ง `*` เพราะรองรับ browser extension) |
| Auth | Bearer token หลายตัว แต่ละตัวมี `{name, kind: agent\|process, scopes[], bundles[], pathPrefixes[], quota, createdAt, lastUsedAt}` |
| Token storage | เก็บแค่ `sha256(token)` ใน `data.json` โดย token สุ่ม 256 bit จึงไม่ต้องใช้ slow hash (ต้นแบบเก็บ plaintext ซึ่งรั่วได้ถ้า sync `.obsidian` ขึ้น git หรือ cloud) **ผลที่ตามมาด้าน UX:** token และ MCP config snippet แสดงได้ครั้งเดียวตอนสร้าง ถ้าทำหายต้องออกใหม่ ซึ่งต้องเขียนอธิบายไว้ชัดใน UI |
| Compare | `crypto.timingSafeEqual` บน hash |
| Throttle | port ตัวนับ auth ที่ล้มเหลวของต้นแบบ (10/นาที/IP → 429 + `Retry-After`) |
| Scopes | `read`, `write`, `verify`, `publish`, `computations:write`, `raw:write`, `delete` โดย token ใหม่ได้แค่ `read` + `write` (การ ingest raw ใหม่ใช้ `write` ส่วนการแทน raw เดิมต้องใช้ `raw:write`) |
| Path guard | port กฎของ `vaultPath.ts` ทั้งชุด และซ้อน concept-id grammar อีกชั้น ห้ามเข้าถึง configDir, `.trash` และ unmanaged path (เว้นแต่ setting อนุญาต) |
| Limits | body ≤ 1 MiB ต่อ request, curated concept ≤ 512 KiB, raw ≤ 1 MiB ต่อไฟล์ (ต้นฉบับที่ยาวกว่านั้นให้ Agent แบ่งตามบทเป็น `<slug>-part-01` …), search ≤ 100 hits, tool result ≤ ~256 KiB (ต้นแบบพบว่า result ราว 1 MB ทำ Electron renderer crash จึงต้องอ่าน raw ผ่าน `offset`) |
| Binary | ไม่มี binary ผ่าน MCP ใน v1 |
| Audit | `audit.jsonl` (rotate ที่ 5 MB) เก็บ `{at, token, tool, concept_id, etag_before, etag_after, reason}` อยู่นอก vault content ใน plugin data dir |
| No command exec | **ไม่มี** `command_execute` แบบต้นแบบ เพราะเป็นช่องทางที่กว้างเกินกว่าหน้าที่ของ wiki |

---

## 9. Obsidian UX

- **Settings:** server (port, on/off, connection snippet สำหรับ Claude Code / Desktop / Cursor),
  tokens (สร้าง/ revoke / scope), bundles (ค้นพบเอง, auto-index, auto-log), identity
  (`human:<id>`), defaults (agent → draft, requireIfMatch, stampHumanEdits), vault link-setting checker
- **Commands:** Create OKF bundle here · Register folder as OKF bundle · New concept (เลือก type)
  · Approve concept (human verify) · Deprecate concept · Lint bundle · Regenerate indexes
  · Convert links to OKF form · Pause/resume agent writes · Revert last agent change…
  · Accept raw edit (re-hash, human only)
  คำสั่งที่ทำกับ note ที่เปิดอยู่ (approve, reject, accept raw edit, convert links) ใช้ `checkCallback`
  จึงแสดงใน command palette เฉพาะเมื่อ note นั้นอยู่ใน bundle ที่เปิดใช้
- **Review Queue view** (sidebar): แสดง draft, unverified, `verification_outdated`, stale,
  `review_requested`, `language-not-english`, `raw-modified` และ raw ที่ยังไม่ได้กลั่น โดยกด
  Approve / Open / Reject ได้ทันที (§5.3) และ approve หลายรายการพร้อมกันได้: ติ๊กเลือก หรือกด "Select all
  without errors" (เลือกเฉพาะรายการที่มีเหตุผลแค่ draft หรือ changed since verified โดยไม่รวม review request)
  แล้วกด "Approve selected" ซึ่งถามยืนยันก่อน และแต่ละรายการได้ `human:<id>` เหมือน approve ทีละรายการ
- **UI ของ plugin เป็นภาษาอังกฤษ** ตามธรรมเนียมของ community plugin และนโยบายภาษาของข้อมูล
- **Trust badge:** แสดง tier, stale และ status ในหัว note (view header action) และใน status bar
- **Status bar:** สถานะ server · จำนวน request ล่าสุด · จำนวน lint issue
- Graph view ของ Obsidian ใช้ได้ทันทีเพราะ link เป็น markdown link ที่ Obsidian resolve ได้

---

## 10. โครงสร้าง repo

`spikes/` และ `eval/` (โค้ดทดลองกับ agent eval ที่ ADR 0001, 0003, 0004, 0007 และ §12 อ้างถึง) อยู่ใน repo ที่ใช้พัฒนาเท่านั้น
ไม่ได้อยู่ใน repo สาธารณะ (D8)

```
obsidian-okf-wiki/
  manifest.json  versions.json  package.json  esbuild.config.mjs
  src/
    core/              # okf-core: ห้าม import 'obsidian' หรือ node built-ins (มี test บังคับ)
      document.ts      # split/join แบบคง byte, EOL, BOM; parse YAML 1.2
      frontmatter.ts   # per-key splice + renderer ตามสไตล์ OKF (ADR 0001 S5)
      edit.ts          # editConcept / renderNewConcept
      conceptId.ts     # grammar, reserved names, id<->path
      paths.ts         # body link และ frontmatter path resolution (§4.4)
      links.ts         # extract/rewrite (md + wikilink), footnotes
      trust.ts         # normalizeVerified, trustTier, isStale, verificationOutdated, actors
      sources.ts       # normalize, upsert, problems
      tags.ts          # อ่านได้ทั้ง list และ comma-string
      language.ts      # zone, script-ratio check, exceptions (§4.8)
      raw.ts           # Raw Source contract, content_sha256 (EOL-insensitive)
      policy.ts        # .okf.yaml load + defaults (§4.1)
      bundle.ts        # BundleModel: concepts, edges, backlinks
      indexRender.ts   # index.md renderer (deterministic, คง heading/description เดิมของไฟล์ที่ไม่ใช่ concept)
      logRender.ts     # log.md append + coalesce
      lint.ts          # rules + fix hints
      patch.ts         # frontmatter merge patch + sources/tags ops
      sha256.ts        # sync SHA-256 (ไม่พึ่ง node:crypto)
    obsidian/
      vaultAdapter.ts  pathGuard.ts  conceptIndex.ts  bundleService.ts  writeQueue.ts
      maintainers.ts   selfWriteLedger.ts  humanEditStamper.ts  trustSnapshot.ts
      snapshotStore.ts
    server/
      httpServer.ts  auth.ts  tokens.ts  originGuard.ts  rateLimit.ts  audit.ts
    mcp/
      server.ts  tools/*.ts  resources.ts  prompts.ts  instructions.md
    ui/
      settingsTab.ts  reviewQueueView.ts  trustBadge.ts  commands.ts
    cli/
      okf.ts           # `okf lint|index|log` (Node, ใช้ core อย่างเดียว)
    main.ts
  test/
    fixtures/okf-bundles/   # copy ของ sample bundles จาก open-knowledge-format (Apache-2.0, ใส่ NOTICE)
    golden/  unit/  integration/
  docs/
    DESIGN.md  adr/  agent-guide.md
```

Stack: TypeScript 5.9, esbuild, `@modelcontextprotocol/server` 2.0 + `@modelcontextprotocol/node`
2.0 (ชุดเดียวกับต้นแบบ, รองรับ `2026-07-28`), `zod` 4 (SDK v2 รับเฉพาะ Zod v4 และเราไม่มี extension API เดิมให้ต้องรักษา จึงไม่ต้องใช้ adapter แบบต้นแบบ), `yaml` 2.x, `markdown-patch`,
`minisearch`, Node `http` (ไม่ใช้ express, เพราะ route มีแค่ `/mcp/` และ `/health` จึงลดขนาด bundle
และพื้นผิวโจมตี), test ด้วย `vitest`, lint ด้วย `eslint-plugin-obsidianmd`

---

## 11. สรุปเทียบกับต้นแบบ

| ด้าน | local-rest-api | OKF reference agent | OKF Wiki |
|---|---|---|---|
| รูปแบบข้อมูล | ไฟล์อะไรก็ได้ | OKF v0.2 | OKF v0.2 **บังคับที่ server** |
| Provenance | ไม่มี | `generated` ที่ผู้เรียกกำหนดเองได้ | `generated` stamp โดย server จาก token, แยก human edit ได้ |
| Trust tier | ไม่มี | คำนวณได้ | คำนวณได้ + Agent ปลอม `human:` ไม่ได้ + Review Queue |
| index/log | ไม่มี | index (ใช้ LLM), ไม่มี log | index deterministic + log อัตโนมัติพร้อม reason |
| Concurrency | `ifMatch` บน patch เท่านั้น, เขียนด้วย `Vault.modify` | ไม่มี | ETag บังคับบน update + write queue ต่อ bundle + `vault.process` |
| ป้องกัน Agent ทำงานผิดพลาด | ไม่มี | max pages ของ web pass | write quota + kill switch + snapshot/revert + draft-by-default |
| Round-trip YAML | Obsidian parser | `safe_dump` (รูปแบบหาย) | ไม่แตะถ้าไม่เปลี่ยน, diff เฉพาะ key ที่แก้ |
| Auth | key เดียว, plaintext, `===` | ไม่มี (local CLI) | หลาย token, hash, scope, timing-safe |
| DNS rebinding | ไม่ตรวจ | n/a | ตรวจ Host + Origin |
| Search | Obsidian search + JsonLogic | ไม่มี | BM25 + facet (type/tags/status/trust/stale/zone), ตัดคำตามภาษาของเอกสาร |
| ภาษา | ไม่กำหนด | ไม่กำหนด | curated เป็นภาษาอังกฤษ (บังคับที่ server) + raw ภาษาเดิมแบบ write-once พร้อม lineage |
| Agent guidance | tool descriptions | system prompt | instructions + prompts + `okf://spec` + error ที่แก้ตัวเองได้ |
| ใช้นอก Obsidian | ไม่ได้ | Python CLI | `okf` CLI จาก core ตัวเดียวกัน |

---

## 12. Testing strategy

1. **Golden (core):** ทุกไฟล์ใน sample bundles ทั้ง 4 ชุด (acme_retail, ga4, stackoverflow,
   crypto_bitcoin) ต้องผ่านกฎ round-trip ใน §4.3, lint ต้องไม่มี error (ยกเว้น `log.md` ของ
   acme_retail ที่มี frontmatter ซึ่งควรได้ warning ตาม §4.6), และ index ที่ render
   ต้องมี entry ครบตาม `index.md` เดิม (เทียบแบบ set ไม่เทียบ byte เพราะ reference ใช้ LLM
   เขียนคำอธิบาย)
2. **Cross-implementation:** ใน CI ให้ Python `OKFDocument.parse().validate()` และ `trust_tier()`
   ของ reference อ่าน bundle ที่เราเขียน แล้วต้องได้ผลตรงกับ core ของเรา
3. **Property tests:** `fast-check` กับ path guard และ concept-id (ไม่มี input ไหนหลุดออกนอก
   bundle) และกับ link normalize (idempotent: normalize(normalize(x)) = normalize(x))
4. **Unit (obsidian layer):** mock `obsidian` (แนวเดียวกับ `mocks/obsidian.ts` ของต้นแบบ) ทดสอบ
   pipeline ทั้ง 14 ขั้น (รวม race ระหว่างขั้น 4 กับ 11) รวมถึง ledger และ human-edit stamping โดยแยกกรณี editor-change,
   rename, sync และ external ให้ครบ (§5)
5. **MCP contract:** เรียกผ่าน SDK client จริงทั้ง revision `2026-07-28` และ `2025-11-25`
   ตรวจ `outputSchema` และ annotation
6. **Security suite:** port test ของ `vaultPath.test.ts` และ `security.test.ts` เพิ่ม test
   token scope, Host/Origin, การปลอม `human:`, การแก้ computation, การหลบ language policy ด้วย
   การตั้ง `type` หรือเขียนนอก raw dir และการแก้ body raw โดยไม่มี `raw:write`
7. **Language (core):** table test ของ `language.ts` ครอบคลุม body ภาษาไทยล้วน (reject),
   ภาษาอังกฤษที่มีชื่อเฉพาะภาษาไทยในเครื่องหมายคำพูด (pass), Thai ใน code/URL/footnote/blockquote
   (pass), สัดส่วนรอบ ๆ threshold, `title` ที่มีอักษรไทย (reject) และ raw ภาษาไทย (pass)
8. **Integration:** Obsidian จริงกับ test vault (opt-in ด้วย env var แบบเดียวกับต้นแบบ)
9. **Agent eval (Phase 3):** สถานการณ์จริง เช่น "บันทึกการตัดสินใจ X พร้อมแหล่งอ้างอิง" และ
   "ingest รายงานภาษาไทยแล้วกลั่นเป็น concept" แล้ววัดว่า bundle ยัง conformant, ไม่ซ้ำ, link ถูก,
   มี source, curated เป็นภาษาอังกฤษ และทุก claim ที่มาจาก raw มี footnote ชี้กลับ
   **วิธีทำ (ADR 0004):** `npx tsx eval/agent/run.ts` เปิด MCP server ใน Node บนสำเนา acme_retail
   ในหน่วยความจำ แล้วให้ Claude Code แบบ headless (`claude -p`, ไม่มี built-in tools และไม่โหลด
   settings/plugins ของผู้ใช้) ทำงานด้วย tool ของเราเท่านั้น prompt เขียนแบบเจ้าของสั่งงานและไม่บอกว่า
   ต้องใช้ tool ไหน จากนั้น `eval/agent/grade.ts` ตรวจ bundle ที่เหลือแบบ deterministic
   (ไม่เชื่อคำตอบของ Agent) ไม่รันใน CI เพราะใช้ token จริง

---

## 13. Roadmap

| Phase | ส่งมอบ | เกณฑ์ผ่าน |
|---|---|---|
| **0 Foundation** | spikes S1, S5, S6, S7 (ADR 0001), scaffold repo, `okf-core` ครบ, `okf lint/index` CLI, golden + property tests, AGENTS.md, LICENSE/NOTICE | spike ทุกข้อได้ข้อสรุปและบันทึกเป็น ADR, golden ผ่านกับ 4 sample bundles, coverage ของ core ≥ 90%; **เสร็จแล้ว (2026-10-14)**: core 18 modules, CLI, test 129 รายการ, coverage lines 98%, sample bundles ทั้ง 4 ชุดไม่มี lint error |
| **1 Read-only MCP** | http server, tokens/scopes, Host/Origin guard, throttle, concept index, `okf_bundles/browse/read/search/graph/lint/history`, resources, instructions | Claude Code เชื่อมต่อและตอบคำถามจาก bundle ได้ (ทั้งสอง revision), security suite ผ่าน; **implement แล้ว (2026-10-19, ADR 0002)**: 192 tests, รอ live test ใน Obsidian |
| **2 Write path** | ~~spikes S2–S4~~ (เสร็จแล้ว ADR 0003), editor-aware writer (CM dispatch สำหรับไฟล์ที่เปิดอยู่), BundleService pipeline + write queue, `okf_create/update/move/deprecate/describe_directory/ingest_raw/publish`, language guard, ETag, guards, index/log maintainers, audit, **ledger, write quota, kill switch, snapshot/revert** (กลไกป้องกันต้องมาพร้อมกับ write ตัวแรก ไม่ใช่ตามมาทีหลัง) | Agent เขียน 100 concept แบบสุ่มแล้ว bundle ยัง conformant 100%, cross-impl test ผ่าน, revert ย้อนได้ทุก write; **implement แล้ว (2026-10-20)**: stress 100 writes ผ่าน, cross-check กับ Python reference ผ่าน, live test ผ่าน (ADR 0003 ภาคผนวก) |
| **3 Human-in-the-loop** | Review Queue, Approve command, human-edit stamper (§5), trust snapshot + `unattested-verification/publish` (§5.1), Accept raw edit, trust badge, `okf_verify/request_review`, link converter, agent eval | trust tier สอดคล้องกับเหตุการณ์จริงในทุก eval scenario รวมถึงกรณี sync, git และ rename; **implement แล้ว (2026-10-20)**: trust eval 7 สถานการณ์ผ่าน (รวม sync, rename และ revert), live test ผ่าน (Approve, บันทึกการแก้ของคน, ตรวจจับ `verified` ที่ปลอมจากภายนอก; ADR 0003 ภาคผนวก S2-F), agent eval ทำแล้ว (ADR 0004) |
| **4A Hardening** | (1) bundle model แบบ incremental: write ไม่ analyze ทั้ง bundle ซ้ำหลายรอบ แต่ analyze ใหม่เฉพาะ concept ที่เปลี่ยนและ backlink ที่ได้รับผล (2) server start ที่ตรวจได้: status bar แสดง error ล่าสุด, command "Restart server" และ `onunload` คืน port ครบ (3) live integration suite ครอบคลุม tool ของ Phase 2–3 | bundle 5,000 concept: write ≤ 200 ms และไม่บล็อก UI เกิน 100 ms ต่อครั้ง โดยมี benchmark ใน repo, reload plugin 10 ครั้งติดกันแล้ว server ขึ้นทุกครั้ง; **implement แล้ว (2026-10-20, ADR 0005)**: write 2,479 → 48 ms และ write + queue 2,975 → 82 ms ที่ 5,000 concept, reload 10 ครั้งผ่านใน test ของ Node, ใน Obsidian จริง (2026-10-21) live suite ผ่าน 6/6 และ reload ซ้ำหลายรอบแล้ว server ขึ้นทุกครั้ง |
| **4B Community release** | ผ่าน `eslint-plugin-obsidianmd` และ guideline ของ Obsidian (README ต้องเปิดเผยว่า plugin เปิด network server บน loopback), README สำหรับผู้ใช้ (ตั้งค่า bundle, token, `claude mcp add`), version 0.2.0 + `versions.json`, GitHub release workflow (main.js, manifest.json, styles.css) | ผ่าน review ของ Obsidian community plugin โดยเจ้าของเป็นคนส่งเองที่ community.obsidian.md (D8); **ทำแล้ว (2026-10-21)**: lint 0 error (เหลือ warning 6 ตัวที่ตั้งใจเก็บไว้), README เปิดเผยการใช้ network, 0.2.0, release workflow, อัปเกรด MCP SDK ที่มี advisory |
| **4C Extension API** | API แบบแคบผ่าน `app.plugins.plugins["okf-wiki"].api`: `onCommit(listener)` (bundle, paths, actor, action, commit id), อ่านแบบ read-only (`search`, `read`, `bundles`) และ type ที่ publish แยก ส่วน sync ไป knowledge graph ภายนอก และ semantic search ทำเป็น plugin หรือ script แยกในภายหลัง (D9) | plugin ตัวอย่างใน test รับ `onCommit` ได้ครบทุก write รวมถึง revert และไม่มีทางเขียนผ่าน API; **implement แล้ว (2026-10-21, §7.6)**: test ครอบคลุม write 8 แบบ รวมถึงการอนุมัติของคนและ revert ที่รวมไฟล์ที่กู้คืน ผลลัพธ์เป็นสำเนา และหยุดทำงานเมื่อ unload; การ publish type เป็น npm package ยังเลื่อนไว้ |
| **4D Spike ก่อน แล้วทำเฉพาะที่มีคนใช้** | (1) resource subscriptions: ตรวจก่อนว่า Claude Code และ client หลักใช้ `notifications/resources/updated` หรือ `subscriptions/listen` จริงหรือไม่ (2) non-md text ใน `okf_read` (เช่น `attesters/*.py`) แทน signed URL (3) `franc-min` เป็น option สำหรับภาษาที่ใช้อักษร Latin (§4.8) ส่วน HTTPS และ signed URL สำหรับ binary เลื่อนไปจนกว่าจะมีความต้องการจริง (D10) | spike แต่ละข้อมีข้อสรุปใน ADR ทำต่อเฉพาะข้อที่ยืนยันว่ามี client ใช้; **spike เสร็จแล้ว (2026-10-21, ADR 0007)**: Claude Code ไม่ subscribe แม้ server ประกาศรองรับ, ไม่มี Agent ตัวไหนต้องอ่านไฟล์ที่ไม่ใช่ md, `franc-min` ระบุภาษาอังกฤษผิด 1 ใน 5 จึงยังไม่มีข้อไหนสร้างจริง |

### Phase 0 spikes: สมมติฐานที่ยังไม่ได้ยืนยันกับ Obsidian จริง

ทำแต่ละข้อใน test vault แล้วบันทึกผลเป็น ADR ถ้าผลไม่ตรงกับสมมติฐานต้องกลับมาแก้ design ก่อน
เริ่ม phase ที่ขึ้นกับข้อนั้น **ผล (ADR 0001):** S1 ยืนยัน, S5 สมมติฐานผิดและเปลี่ยนเป็น per-key splice,
S6 ยืนยัน (ใช้ zod 4), S7 ยืนยันบางส่วน (เพิ่ม bigram) และยืนยันใน Electron แล้ว (ADR 0002)
**S2–S4 (ADR 0003):** S2 สมมติฐานผิด (`vault.process` ทำข้อความเสียได้ จึงเปลี่ยนไปใช้ CM dispatch),
S3 สมมติฐานผิด (`editor-change` ไม่ใช่สัญญาณว่าคนแก้ จึงเปลี่ยนไปใช้ CM `userEvent`), S4 ยืนยัน
(Properties UI เขียน frontmatter ใหม่ทั้งก้อนเป็น block style จึงเพิ่มกฎ render ตาม style เดิม)

| # | สมมติฐาน | ส่วนที่ได้รับผลถ้าผิด |
|---|---|---|
| S1 | Obsidian resolve markdown link `[x](/a/b.md)` เทียบ vault root ไม่ใช่ folder ของ bundle | §4.4 (การเลือก relative link) |
| S2 | `vault.process` กับไฟล์ที่เปิดใน editor ไม่ทำให้ข้อความที่ผู้ใช้กำลังพิมพ์หาย และ `Editor` API แก้ frontmatter ได้โดย undo ยังใช้ได้ | §5 ข้อ 2, §6 ขั้นที่ 11 |
| S3 | `editor-change` เกิดจากการพิมพ์เท่านั้น ไม่เกิดจาก sync หรือ `renameFile` และการแก้ผ่าน Properties UI ตรวจจับได้ | §5 ข้อ 2 |
| S4 | Properties UI เปลี่ยนรูปแบบ `{ by, at }` และ timestamp อย่างไร (เช่นกลายเป็น block style หรือถูกใส่/ถอด quote) | §4.3 ข้อ 5 |
| S5 | `yaml` Document API แก้ key เดียวแล้ว diff อยู่แค่บรรทัดนั้นจริง กับ frontmatter ของ sample bundles | §4.3 |
| S6 | `@modelcontextprotocol/node` ทำงานบน Node `http` ล้วน (ไม่ใช้ express) ใน Electron ของ Obsidian ได้ทั้งสอง revision และตรวจ license ของ `markdown-patch` และ `minisearch` | §10 stack |
| S7 | `Intl.Segmenter(undefined, {granularity:'word'})` ใน Electron ของ Obsidian ตัดคำไทยได้ถูก (dictionary-based) และใช้กับข้อความที่มีหลายภาษาปนกันได้ | §7.1 search |

---

## 14. การตัดสินใจ (ยืนยันโดยเจ้าของ 2026-10-14)

ทุกข้อเป็นไปตามที่แนะนำไว้ใน v0.3 และเปลี่ยนได้ภายหลังผ่าน ADR

| # | เรื่อง | ข้อสรุป |
|---|---|---|
| D1 | ภาษา | curated เป็นภาษาอังกฤษ ทั้ง slug, frontmatter และ body ส่วน raw คงภาษาเดิมได้ (§4.8) และ `aliases` ใช้ภาษาใดก็ได้เพื่อค้นหา |
| D2 | Bundle แรก | folder `Knowledge/` ไม่แปลงทั้ง vault เพื่อไม่ให้ note ส่วนตัวต้องตาม OKF |
| D3 | Transport | HTTP บน loopback + Host/Origin guard + token ส่วน HTTPS เลื่อนออกไปตาม D10 |
| D4 | สถานะเริ่มต้นของงานจาก Agent | `draft` เสมอ การเปลี่ยนเป็น `stable` ต้องผ่าน Approve ของมนุษย์ หรือ scope `publish` สำหรับ process ที่เชื่อถือได้ (§4.3) |
| D5 | Auto-stamp เมื่อมนุษย์แก้ | เปิด โดย stamp เมื่อไฟล์ออกจาก editor หรือ idle เกิน 60 วินาที (§5) |
| D6 | อยู่ร่วมกับ local-rest-api | ติดตั้งคู่กันได้ (คนละ port, ไม่ depend ต่อกัน) **แต่** `vault_write` ของมันข้าม guard ทั้งหมดของเรา (= external write ตาม §5.1) จึงไม่ควรให้ Agent ใช้ทั้งสองตัวกับ vault เดียวกัน |
| D7 | License | Apache-2.0 ไม่มีโค้ดจาก local-rest-api (MIT) อยู่ใน repo มีแค่การออกแบบที่ใช้เป็นแนวทาง ซึ่งระบุไว้ใน header ของไฟล์และใน NOTICE (ตรวจแล้ว 2026-10-21 เพราะ Developer policies ห้ามรับโค้ดจาก repo อื่นโดยไม่ได้รับอนุญาต) ส่วน fixtures และ prompt ที่ดัดแปลงจาก OKF อยู่ใน NOTICE |
| D8 | เป้าหมายการ release (2026-10-20, เปลี่ยน 2026-10-22, **เปลี่ยนอีกครั้ง 2026-10-22**) | release สาธารณะเป็น **OKF Wiki** (id `okf-wiki`) ใน repo `obsidian-okf-wiki` แล้วส่งที่ community.obsidian.md (ADR 0008) repo ที่ใช้พัฒนายังเป็น private ส่วน repo สาธารณะได้จากการ export snapshot ที่ไม่มี history, spikes, agent eval และไฟล์คำสั่งของ agent release ยังทำผ่าน workflow เดิม (draft release แล้วกด publish เอง) |
| D9 | Sync ไป knowledge graph ภายนอก (2026-10-20, **ยกเลิก 2026-10-22**) | Phase 4 ทำแค่ extension API (`onCommit` + read-only) ส่วนตัว sync ไม่ทำ เพราะซ้ำซ้อน: agent บันทึกลง memory ของตัวเองได้อยู่แล้ว และอ่าน wiki ผ่าน MCP ของ plugin ได้ตรง ถ้า sync ความรู้จะอยู่สองที่และเพี้ยนกันเมื่อ concept ถูกแก้หรือ deprecate |
| D10 | HTTPS, subscriptions, attachments (2026-10-20) | spike ก่อน แล้วทำเฉพาะที่ยืนยันว่ามี client ใช้ HTTPS เลื่อนไปจนกว่าจะต้อง bind นอก loopback |
| D11 | Semantic search (2026-10-22) | ยังไม่ทำ index ของ Obsidian (`metadataCache`) มีแค่ link, heading, tag และ frontmatter ไม่มี embedding และ search ของ Obsidian ไม่มี public API ให้ plugin ใช้ผล ส่วน eval ทั้ง 3 model (ADR 0004) ยังไม่เคยพลาดเพราะค้นไม่เจอ |
| D12 | Auto approve และ Reject (2026-10-22) | เจ้าของเลือกทั้ง batch approve ที่คนกดเอง และ auto approve ตามกฎที่ stamp `process:auto-approve` (machine-confirmed) ส่วน Reject คือ revert พร้อมเหตุผลที่ Agent อ่านได้ (§5.3) |

**คำถามที่ยังเปิดอยู่:** ไม่มีในระดับ design เหลือแค่ผลของ spikes S1–S7 ซึ่งอาจทำให้ต้องแก้ §4.4,
§5 และ §7.1

---

## Appendix A: ผลรีวิวรอบที่ 1 (v0.1 → v0.2)

| # | ระดับ | ปัญหาใน v0.1 | การแก้ |
|---|---|---|---|
| 1 | Critical | ตรวจ human edit จาก "hash ไม่ตรง ledger" ทำให้ rename, sync, git และ plugin อื่นถูกตีความเป็น `human:` ซึ่งทำลาย trust | ใช้สัญญาณเชิงบวก `editor-change` และ Properties UI ส่วนอื่นถือเป็น external (§5) |
| 2 | Critical | stamp `generated` ผ่าน vault ขณะผู้ใช้กำลังพิมพ์ ทำให้ cursor กระโดดหรือเนื้อหาชนกัน | stamp เมื่อไฟล์ออกจาก editor หรือผ่าน Editor API (§5), spike S2 |
| 3 | Critical | อ้างว่า "Agent ปลอม `human:` ไม่ได้" แต่ไม่ได้บอกว่า write ทาง filesystem ข้าม MCP ได้ | เพิ่ม threat model และการตรวจจับด้วย trust snapshot (§5.1) |
| 4 | High | สัญญาว่า YAML round-trip จะได้ byte-identical ซึ่ง library ใดก็ทำไม่ได้ | ไม่แตะ frontmatter ถ้าไม่เปลี่ยน และวัด "diff เฉพาะ key ที่แก้" (§4.3), spike S5 |
| 5 | High | ค้นหา bundle จาก `okf_version` อย่างเดียว แต่ sample ทั้ง 4 ชุดไม่มี marker นี้ | ให้รายชื่อใน settings เป็นแหล่งความจริง + command Register + การค้นพบที่ผู้ใช้ต้องยืนยัน (§4.1) |
| 6 | High | grammar เข้มใช้กับการอ่านด้วย ทำให้ note ที่มนุษย์ตั้งชื่อเองหายไปจากระบบ | grammar เข้มใช้เฉพาะ create/move ส่วนการอ่านรับทุก path ที่ผ่าน guard (§4.2) |
| 7 | High | mutex ราย path กันการชนกันข้ามไฟล์ไม่ได้ (move, index, log) | write queue ต่อ bundle (§6) |
| 8 | High | ไม่มีกลไกหยุด Agent ที่วนเขียนผิด ๆ และไม่มี undo | quota, kill switch, snapshot/revert และย้ายเข้า Phase 2 (§6.7, §13) |
| 9 | High | `renameFile` แก้ link ให้เฉพาะเมื่อผู้ใช้เปิด setting และไม่แก้ outbound relative link ของไฟล์ที่ย้าย | okf-core rewrite เองทั้งหมด (§6.5) |
| 10 | Medium | lint "description ประโยคเดียว" ใช้กับภาษาไทยไม่ได้ | ใช้ความยาวและจำนวนบรรทัดแทน (§4.3) |
| 11 | Medium | normalize link ทั้งไฟล์ทุกครั้ง ทำให้ diff บวม และอาจแก้ link ใน code block | normalize เฉพาะเนื้อหาใหม่ ข้าม code/math และปฏิเสธ wikilink กำกวม (§4.4) |
| 12 | Medium | index/log ชนกันเมื่อใช้หลายเครื่อง และ log โตไม่จำกัด | เขียนเมื่อเนื้อหาเปลี่ยนจริง, coalesce, วันที่แบบ UTC (§4.5–4.6) |
| 13 | Medium | ไม่ได้กำหนดพฤติกรรมช่วง startup และกรณี YAML เสีย | `index_ready` และ flow สำหรับซ่อม (§7.5) |
| 14 | Medium | ยังไม่ได้กำหนด CORS, UX ของ token ที่เก็บเป็น hash และ license | §8, §14 ข้อ 7 |
| 15 | Process | สมมติฐานเรื่องพฤติกรรมของ Obsidian ยังไม่ได้ยืนยัน แต่ design พึ่งมันอยู่ | เพิ่ม spikes S1–S6 เป็นเงื่อนไขก่อน Phase 1 (§13) |

---

## Appendix B: นโยบายภาษา (v0.2 → v0.3)

ข้อกำหนดจากเจ้าของ (2026-10-14): ข้อมูลที่ใช้งานเก็บเป็นภาษาอังกฤษเป็นหลัก ส่วน raw ที่แปลงมา
เก็บไว้เป็นภาษาอื่นได้

| ส่วน | การเปลี่ยนแปลง |
|---|---|
| §1 | เพิ่มเป้าหมายข้อ 7 |
| §4.1 | layout เพิ่ม `references/raw/` เป็น raw zone |
| §4.2 | slug ภาษาอังกฤษเสมอ, ตัด option `allowUnicodeIds`, `aliases` ใช้ภาษาใดก็ได้เพื่อค้นหา |
| §4.3 | `title`/`description`/`tags` เป็นภาษาอังกฤษทุก zone, เพิ่ม key `language`, `original_title`, `original_format`, `retrieved_at`, `content_sha256` |
| §4.5 | index เรียงด้วย `Intl.Collator('en')` |
| §4.8 | section ใหม่: zone, ข้อยกเว้น, วิธีตรวจและข้อจำกัด, workflow กลั่น raw → concept |
| §6 | guard ตรวจ language policy และ raw write-once |
| §7 | `okf_ingest_raw`, `okf_read.offset`, `okf_search.include_raw/unprocessed_raw/language`, prompt `okf_distill_raw`, instructions ภาษาอังกฤษ |
| §8 | scope `raw:write`, ขนาด raw สูงสุด 1 MiB |
| §9 | Review Queue แสดงปัญหาด้านภาษาและ raw, UI ภาษาอังกฤษ |
| §12–13 | test ด้านภาษา, agent eval สำหรับ raw ภาษาไทย, `ingest_raw` อยู่ใน Phase 2 |

---

## Appendix C: ผลรีวิวรอบที่ 2 (v0.3 → v0.4)

| # | ระดับ | ปัญหาใน v0.3 | การแก้ |
|---|---|---|---|
| 1 | Critical | Agent เปลี่ยน `status: draft → stable` เองได้ผ่าน `okf_update` จึงข้าม Review Queue ทำให้ D4 ไม่มีผล | `stable` ต้องผ่าน Approve หรือ scope `publish` (tool `okf_publish`) และ trust snapshot ตรวจ publish ที่ทำนอกระบบ (§4.3, §5.1, §7.2) |
| 2 | Critical | นโยบาย bundle (`raw_dirs`, threshold) อยู่ใน plugin settings ของเครื่อง ทำให้ CLI/CI และเครื่องอื่นตรวจภาษาผิด ซึ่งขัดกับเป้าหมาย "พกพาได้" | ย้ายไป `<bundle>/.okf.yaml` ซึ่ง Agent แก้ไม่ได้ (§4.1, §3) |
| 3 | High | spec กับ sample ขัดกันเรื่อง path ใน frontmatter: §6.2 บอกว่าเป็น relative แต่ sample ใช้ bundle-relative ที่ไม่มี `/` (acme_retail 12 จุด) และ v0.3 เขียน `../references/raw/…` ซึ่งเสียเมื่อย้ายไฟล์ | เขียนเป็น bundle-absolute `/…`, ตอนอ่านลองทั้งสองแบบพร้อม lint `ambiguous-path` (§4.4) |
| 4 | High | edge จาก `sources` ไม่ปรากฏใน graph และ backlinks ของ Obsidian | concept index นับเป็น edge และ footnote definition มี link ด้วย (§4.4, §7.1) |
| 5 | High | ลำดับใน pipeline ผิด: guard อยู่หลัง stamp `generated` จึงแยกค่าที่ Agent ส่งกับค่าที่ server ใส่ไม่ได้ และมี race ระหว่างอ่านกับ `vault.process` | แยก guard-input กับ guard-result และเทียบ hash ใน callback ของ `vault.process` (§6) |
| 6 | Medium | Agent ส่ง frontmatter เต็มกลับมา (ซึ่งมี `generated`) แล้วถูกปฏิเสธโดยไม่จำเป็น | ยอมรับถ้าค่าเท่าค่าปัจจุบัน (§4.3) |
| 7 | Medium | revert ของ move ซึ่งแตะหลายไฟล์ทำไม่ได้ทีละไฟล์ และ snapshot/audit อาจถูก sync ขึ้น git | ใช้ `commit_id` และเก็บใน `state/` ที่แนะนำให้ gitignore (§6.7) |
| 8 | Medium | กฎภาษาของ `title` ขัดกับข้อยกเว้นเรื่องชื่อเฉพาะใน body | frontmatter เข้มกว่า: ชื่อเฉพาะเขียนเป็นอักษรโรมัน และชื่อเดิมไปอยู่ใน `aliases`/`original_title` (§4.3) |
| 9 | Medium | tokenizer ราย `language` ใช้กับ MiniSearch ไม่ได้ (tokenizer ไม่ได้รับ document) และ raw ขนาดใหญ่ทำให้ใช้หน่วยความจำมาก | ใช้ ICU word segmenter ตัวเดียว (spike S7), แยก index ของ raw แบบ lazy และจำกัด 200 KB (§7.1) |
| 10 | Medium | มนุษย์ที่ตั้งใจแก้ raw (เช่นแก้ข้อผิดพลาดจาก OCR) ไม่มีทางทำให้ `raw-modified` หายไป | command "Accept raw edit" (§4.8) |
| 11 | Low | บรรทัด "ไม่รัน executor" หลุดไปอยู่ใน §4.8, index ไม่บอกว่าเป็น draft, section `# Deprecated` ชื่ออาจชนกับ type, ไม่ได้ระบุ `actor_version` และกรณีที่ยังไม่ได้ตั้ง `userId`, §2 อ้างว่า MCP spec กำหนดให้ตรวจ Host | แก้ทั้งหมด |

---

## Appendix D: ผล spike S2–S4 (v0.4 → v0.5)

| # | สมมติฐานใน v0.4 | ผล (ADR 0003) | สิ่งที่เปลี่ยน |
|---|---|---|---|
| S2 | `vault.process` กับไฟล์ที่เปิดอยู่ไม่ทำข้อความหาย และ Editor API แก้ frontmatter ได้โดย undo ยังใช้ได้ | `vault.process` **ทำข้อความเสียหาย** (1 ใน 2 รอบ) และเข้า undo history ส่วน `editor.transaction` ข้อความไม่หาย แต่เข้า undo history ส่วน CM dispatch ไม่ลง history ผ่านทุกข้อ | §6 ขั้นที่ 11 และ §6.1: เขียนไฟล์ที่เปิดอยู่ผ่าน CM dispatch, ETag จาก buffer และตอบ 409 `being-edited` |
| S3 | `editor-change` เกิดจากการพิมพ์เท่านั้น | **ผิด:** เกิดจาก sync, git, `renameFile`, `vault.process` และ Properties UI ด้วย ส่วน CM `userEvent` แยกได้ (`input.*` คือคนพิมพ์ ส่วน `set` คือการโหลดจากดิสก์และ Properties UI) | §5 ข้อ 2: ใช้ `userEvent` และไม่นับ Properties UI ว่าเป็นคนแก้ |
| S4 | Properties UI อาจเปลี่ยน style ของ frontmatter | **ยืนยัน:** เขียนใหม่ทั้งก้อนเป็น block style และลบ comment แต่ timestamp ยังเป็น string | §4.3 ข้อ 5: render ตาม style เดิม |
| (เพิ่ม) | `renameFile` แก้ link เฉพาะเมื่อเปิด setting | ยืนยัน และแก้ทั้ง markdown link กับ wikilink | §6.5: rewrite ต้อง idempotent |

## Appendix E: แผน Phase 4 (v0.5 → v0.6)

**สิ่งที่พบก่อนวางแผน (2026-10-20):** benchmark ใน Node บน bundle สังเคราะห์ (link ต่อกันเป็นวง, มี source และ footnote)

| ขนาด bundle | `analyzeBundle` | `lintBundle` | search ครั้งแรก / ครั้งถัดไป | write 1 ครั้ง |
|---|---|---|---|---|
| 1,000 concept | 213 ms | 54 ms | 58 / 5 ms | 468 ms |
| 5,000 concept | 682 ms | 636 ms | 249 / 15 ms | 2,233 ms |

server ทำงานใน renderer thread เดียวกับ UI ของ Obsidian ดังนั้น write แต่ละครั้งบน bundle 5,000 concept
ทำให้ UI ค้างราว 2 วินาที สาเหตุคือ write หนึ่งครั้งเรียก `analyzeBundle` ทั้ง bundle หลายรอบ (ตอน validate
ใน `planWrite`, ตอนคำนวณ index ใน `commit()` และตอน provider rebuild) จึงยกเรื่องนี้ขึ้นเป็นข้อแรกของ 4A
ส่วน search ไม่มีปัญหา

**ลำดับงาน:** 4A → 4B → 4C ส่วน 4D ทำ spike แทรกได้ทุกเมื่อ
- 4B ต้องรอ 4A ก่อน เพราะไม่ควร release ตัวที่ทำให้ UI ค้าง
- 4C ใช้ commit record เดียวกับ snapshot/audit ที่มีอยู่แล้ว จึงไม่ต้องสร้างโครงสร้างใหม่

**สิ่งที่ตัดออกจาก roadmap เดิม (D10):**
- HTTPS + local CA: loopback ไม่ต้องใช้ และ client ส่วนใหญ่มีปัญหากับ self-signed cert (§8)
- signed URL: ยังไม่มีไฟล์ binary ที่ Agent ต้องใช้ใน sample bundles
- ทั้งสองข้อจะกลับมาเมื่อมีกรณีใช้งานจริง และบันทึกเป็น ADR
