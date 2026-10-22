# ADR 0001: ผล Phase 0 spikes (S1, S5, S6, S7)

- สถานะ: Accepted · 2026-10-14
- เกี่ยวข้อง: DESIGN.md §4.3, §4.4, §7.1, §8, §10, §13
- หมายเหตุ: โค้ดใน `spikes/` ที่ ADR นี้อ้างถึงอยู่ใน repo ที่ใช้พัฒนาเท่านั้น ไม่ได้อยู่ใน repo สาธารณะ (D8)
- โค้ดทดลอง: `spikes/`

## S1: Obsidian resolve link ที่ขึ้นต้นด้วย `/` อย่างไร

ทดสอบกับ Obsidian จริงผ่าน local-rest-api MCP: สร้าง `_spike_s1/bundle/sub/a.md` แล้วอ่าน
`links`/`unresolvedLinks` จาก metadataCache (ลบไฟล์ทดสอบแล้ว)

| link ใน `a.md` | ผล |
|---|---|
| `[A](/s1-vault-root-target.md)` (ไฟล์อยู่ที่ vault root) | resolved → `s1-vault-root-target.md` |
| `[B](/s1-bundle-target.md)` (ไฟล์อยู่ที่ bundle root) | **unresolved** |
| `[C](../s1-bundle-target.md)` | resolved |
| `[D](s1-bundle-target.md)` (ไม่มีไฟล์นี้ใน `sub/`) | resolved โดย fallback หาตามชื่อไฟล์ |
| `[E](/_spike_s1/bundle/s1-bundle-target.md)` | resolved |
| path ใน frontmatter (`resource`, `sources[].resource`) | Obsidian ไม่นับเป็น link |

**ข้อสรุป:** ยืนยันสมมติฐาน `/` = vault root จึงคงการตัดสินใจใน §4.4 ไว้ (body ใช้ relative,
frontmatter ใช้ bundle-absolute)

**สิ่งที่พบเพิ่ม:** Obsidian resolve bare filename (D) ด้วยการหาตามชื่อไฟล์ทั้ง vault ทำให้ link ที่
OKF resolver (เทียบกับ document เท่านั้น) มองว่า broken อาจดูปกติใน Obsidian ดังนั้น lint
`broken-link` ต้องบอกด้วยว่า "Obsidian resolves this by filename only" เพื่อไม่ให้ผู้ใช้สับสน

## S5: YAML round-trip

`spikes/s5-yaml-roundtrip.ts`, `spikes/s5b-yaml-splice.ts` กับ 54 concept ใน fixtures

- **`yaml` Document API แบบ parse → แก้ → `toString()` ไม่ผ่าน:** ไม่แก้อะไรเลย ได้ byte เดิมแค่
  1/54 และแก้ 1 key ได้ diff เฉพาะ key นั้นแค่ 1/54 สาเหตุคือ sample ใช้ `[a, b]` (ไม่มี padding)
  ปนกับ `{ by: x, at: y }` (มี padding) แต่ option `flowCollectionPadding` เป็นค่าเดียวทั้งเอกสาร
- **แบบ splice ราย top-level key ผ่าน 54/54:** ใช้ `parseDocument` หาช่วงของแต่ละ pair แล้ว
  render ใหม่เฉพาะ key ที่เปลี่ยน key อื่นคงข้อความเดิมทุก byte และความหมายหลัง parse ตรงตามที่คาด
- YAML 1.2 core schema คง timestamp เป็น string (`typeof at === "string"`)

**ข้อสรุป:** `okf-core/document.ts` ใช้ **per-top-level-key splicing** ซึ่งรับประกันว่า diff อยู่ใน
key ที่แก้เท่านั้น ข้อจำกัดคือ comment ภายใน block ของ key ที่ถูก render ใหม่จะหายไป ส่วน key อื่น
ไม่ได้รับผลกระทบ

**สิ่งที่พบเพิ่ม (Windows):** เครื่องนี้ตั้ง `core.autocrlf=true` ไฟล์ markdown จึงเป็น CRLF ซึ่ง
vault บน Windows ก็จะเจอแบบเดียวกัน core ต้อง parse CRLF ได้ และ **เขียนกลับด้วย EOL เดิมของไฟล์**
ส่วน fixtures ล็อกเป็น LF ตาม upstream ด้วย `.gitattributes` (`-text`)

## S6: MCP SDK v2 บน `node:http` ล้วน

`spikes/s6-mcp-raw-http.ts`

- `createMcpHandler` + `toNodeHandler` (2026-07-28 sessionless) และ
  `NodeStreamableHTTPServerTransport` (sessionful 2025-11-25) ทำงานบน `http.createServer` โดยไม่มี
  express เมื่ออ่าน JSON body เองแล้วส่งเข้าไป
- client v2 เรียก `tools/list` และ `tools/call` ได้ ส่วน legacy `initialize` ได้ 200 พร้อม
  `Mcp-Session-Id`
- SDK มี guard ในตัว: `localhostHostValidation()` และ `originValidation([])` (Origin ใดก็ตามที่ส่งมา
  ถูกปฏิเสธ ถ้าไม่ส่ง Origin ก็ผ่าน) ผลทดสอบ: Origin แปลกปลอม 403, Host แปลกปลอม 403, ไม่มี token 401
  ส่วน `localhostOriginValidation()` ยอม Origin ที่เป็น localhost **ทุก port** ซึ่งเว็บแอป local
  ตัวอื่นก็ส่งได้ จึง **ไม่ใช้** ตัวนี้
- **SDK v2 รับเฉพาะ Zod v4 schema** ต้นแบบต้องมี adapter (`mcpSchema.ts`) เพราะติด zod 3 จาก
  extension API แต่เราไม่มีข้อจำกัดนั้น **จึงใช้ `zod@^4` ตรง ๆ** (dedupe กับของ SDK เป็น 4.6.7)
- License: `@modelcontextprotocol/*` MIT, `zod` MIT, `yaml` ISC, `minisearch` MIT,
  `markdown-patch` MIT ทั้งหมดเข้ากับ Apache-2.0 ได้ และ SDK ต้องการ Node ≥ 20

## S7: ตัดคำภาษาไทย

`spikes/s7-segmenter.ts` (Node 24, ICU 78.3)

- `Intl.Segmenter(undefined, {granularity: 'word'})` ตัดคำไทยและ CJK แบบ dictionary ได้ใช้งานได้
- **การตัดไม่คงที่ตามบริบท:** "ดาวเทียม" อยู่เป็นคำเดียวในประโยคหนึ่ง แต่ถูกแยกเป็น "ดาว" "เทียม" ใน
  อีกประโยค การค้นด้วย token คำอย่างเดียวจึงพลาดได้

**ข้อสรุป:** tokenizer = คำจาก ICU **และ** character bigram ของช่วงข้อความที่เป็นอักษรไทย/CJK
(เฉพาะสคริปต์ที่ไม่เว้นวรรคระหว่างคำ) เพื่อให้ recall คงที่ ต้องตรวจซ้ำใน Electron ของ Obsidian
ตอนทำ integration test ของ Phase 1

## S2, S3, S4: ยังไม่ได้ทำ และเลื่อนไปเป็นเงื่อนไขก่อน Phase 2

ทั้งสามข้อต้องมีคนพิมพ์ใน editor ของ Obsidian หรือแก้ผ่าน Properties UI ซึ่งทำผ่าน REST/MCP
อัตโนมัติไม่ได้ และกระทบเฉพาะ write path (Phase 2) กับ human-edit stamping (Phase 3) ไม่กระทบ
Phase 1 ที่เป็น read-only จึงเลื่อนไปทำพร้อม spike plugin ก่อนเริ่ม Phase 2 โดยใช้ขั้นตอนทดสอบดังนี้

1. **S2:** เปิดไฟล์ใน editor แล้วพิมพ์ต่อเนื่องระหว่างที่ spike plugin เรียก `vault.process`
   ทุก 2 วินาที ตรวจว่าตัวอักษรไม่หายและ cursor ไม่กระโดด แล้วลองแก้ frontmatter ผ่าน `Editor`
   API และตรวจว่า undo ใช้ได้
2. **S3:** log `editor-change` ระหว่าง (ก) พิมพ์ (ข) `renameFile` ที่แก้ link (ค) แก้ไฟล์จาก
   filesystem ภายนอก (ง) แก้ผ่าน Properties UI
3. **S4:** แก้ property หนึ่งตัวผ่าน Properties UI ในไฟล์ที่มี `{ by, at }` และ timestamp
   แล้ว diff ไฟล์ก่อนและหลัง
