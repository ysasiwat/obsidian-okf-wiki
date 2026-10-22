# ADR 0004: Agent eval (Phase 3, DESIGN.md §12 ข้อ 9)

- สถานะ: Accepted · 2026-10-20
- เกี่ยวข้อง: DESIGN.md §4.5, §4.8, §7, §12; ADR 0003
- หมายเหตุ: โค้ดใน `eval/agent/` ที่ ADR นี้อ้างถึงอยู่ใน repo ที่ใช้พัฒนาเท่านั้น ไม่ได้อยู่ใน repo สาธารณะ (D8)
- วิธีทดสอบ: `npx tsx eval/agent/run.ts` ด้วย Claude Code 2.1.304 แบบ headless, model `claude-sonnet-5-5`

## การตัดสินใจ

- **Agent จริง ไม่ใช่ script:** runner เปิด `OkfHttpServer` ใน Node บนสำเนา acme_retail ในหน่วยความจำ
  (ไม่ต้องเปิด Obsidian และไม่แตะ vault) ออก token ชั่วคราว scope `read`+`write` แล้วรัน
  `claude -p` โดยใช้ `--tools ""`, `--strict-mcp-config` และ `--setting-sources ""` ดังนั้น Agent
  ใช้ได้เฉพาะ tool ของเรา และ plugin หรือ hook ของผู้ใช้ไม่ปนเข้ามา
  ทั้งนี้ `--bare` ใช้ไม่ได้เพราะต้องมี `ANTHROPIC_API_KEY`
- **prompt เขียนแบบเจ้าของสั่งงาน** และไม่บอกชื่อ tool จึงวัดได้ว่าคำอธิบาย tool และ server instructions
  สอน Agent ได้ดีแค่ไหน
- **grader เป็นแบบ deterministic** (`eval/agent/grade.ts`) อ่านเฉพาะไฟล์ที่เหลือ ไม่เชื่อคำตอบของ Agent
  และนับเฉพาะปัญหาที่เกิดใหม่เมื่อเทียบกับ bundle ตั้งต้น การตรวจมีดังนี้
  - `conformant`: lint error ใหม่
  - `links-resolve`: link ที่เสียหรือไม่เป็นแบบ OKF โดยนับทุก severity
  - `no-duplicate-titles`
  - `sourced`: เฉพาะ concept ที่ Agent เขียนเนื้อหา ส่วนการแก้แค่ frontmatter เช่น review request ไม่นับ
  - `claims-footnoted`: ทุก paragraph, list item และตารางที่มาจาก raw ต้องมี footnote ส่วน navigation ไม่นับ
  - `raw-cited`: ต้องมี id, มี footnote definition ที่เป็น link จริงไป raw และมี `language`
  - การตรวจเฉพาะของแต่ละ scenario
- ไม่รันใน CI เพราะใช้ token จริง ผลจะเก็บใน `eval/results/` (อยู่ใน .gitignore)

## Scenarios

| id | สั่ง | ต้องได้ |
|---|---|---|
| `record-decision` | บันทึกการตัดสินใจเรื่อง gift card พร้อม memo URL | concept ใหม่ที่อ้าง URL และ link ไป policy/metric ที่เกี่ยวข้อง |
| `distill-thai` | เก็บ memo ภาษาไทยแล้วกลั่นความรู้ | raw `language: th` ที่เก็บต้นฉบับครบ, concept ภาษาอังกฤษที่ footnote ทุก claim |
| `no-duplicate` | "gross margin = revenue − product cost" (นิยามเก่าที่เลิกใช้แล้ว) | ไม่สร้าง concept ซ้ำ และไม่แก้ body ของ `gross-margin` / `gross-margin-legacy` |

## ผล

| รอบ | record-decision | distill-thai | no-duplicate |
|---|---|---|---|
| 1 (ก่อนแก้) | 3/3 | 0/3: ตารางไม่มี footnote, footnote definition ไม่ link ไป raw, source ไม่มี `language` | 3/3 |
| 2 (หลังแก้ tool text + เติม language) | 1/1 | 3/4: ตารางไม่มี footnote 1 ครั้ง | 1/1 |
| 3 (lint `table-uncited`) | – | 3/4: Agent ย้าย footnote ไปไว้ใต้ตาราง แล้วได้ `warnings: []` จึงเลิกแก้ | – |
| 4 (result รายงานทุก warning ที่ยังเหลือ) | 1/1 | 3/4: ตารางมี footnote ครบทั้ง 4 ครั้ง ที่พลาด 1 ครั้งคือย่อหน้าความเห็นของ Agent เอง | 1/1 |
| 5 (2026-10-21: grader ข้าม section ที่ Agent กันไว้ใส่ความเห็นของตัวเอง, เพิ่ม `attester-details`, มี `okf_read_file`) | 2/2 | 2/2 | 2/2 |

scenario `attester-details` (ถามข้อมูลที่มีอยู่แค่ในไฟล์ `.py`) ได้ 0/2 ก่อนมี `okf_read_file` เพราะ Agent พยายามอ่านไฟล์
แต่ได้ not-found หลังมี tool นี้ได้ 2/2 และ Agent เรียกใช้ทันทีโดยไม่มี tool error (ADR 0007 ภาคผนวก)

ค่าใช้จ่ายราว $0.03–0.11 ต่อรอบ และไม่มี tool error ใน run ใดเลย

### เทียบ model (2026-10-22, 4 scenario × 2 run)

| model | ผลจาก grader ตอนรัน | grade ใหม่ด้วย grader ที่แก้แล้ว | ค่าใช้จ่ายต่อรอบ | turn |
|---|---|---|---|---|
| Haiku 5.5 | 8/8 | 8/8 | $0.00–0.01 | 5–11 |
| Sonnet 5.5 (รอบ 5) | 8/8 | 8/8 | $0.03–0.11 | – |
| Opus 5.5 | 5/8 | 8/8 | $0.09–0.22 | 5–10 |

- ทั้ง 3 ที่ Opus ไม่ผ่านเป็นข้อจำกัดของ grader
  - `distill-thai` ไม่ผ่าน 2 ครั้ง: Agent ใส่ความเห็นไว้ใต้หัวข้อ `## Open issue: ...` ซึ่ง grader ยังไม่ข้าม
    (เดิมข้ามแค่ open item/question) ตอนนี้ข้าม `open issue(s)` ด้วย
  - `attester-details` ไม่ผ่าน 1 ครั้ง: Agent เขียนว่า "Compared as symbols" ซึ่ง pattern `/symbolic/` จับไม่ได้
    ตอนนี้ใช้ `/symbol/` แทน เนื้อหาถูกต้องและละเอียดที่สุดในทุก run
- grade ผลที่เก็บไว้ทั้ง 24 run ใหม่ (Haiku, Opus และ Sonnet รอบ 5) ด้วย grader ที่แก้แล้ว ผ่านทั้งหมด
- คนอ่านตรวจแล้วว่าเนื้อหาถูก: Haiku แปลงปี พ.ศ. ถูก, footnote ครบ และใช้ `okf_read_file` อ่าน attester ได้เอง
  ส่วน Opus พบความไม่ตรงกันจริงใน bundle (skill `run-on-bq` บอกให้รอ `verdict: ok` แต่ code คืน key `ok`)
- พลาดจริงเล็กน้อย 1 จุด: ย่อหน้าใต้ "Open issue" ของ Opus ใน `distill-thai-1` อ้างข้อเท็จจริงจาก memo
  (นับวันจากวันที่ได้รับสินค้า) โดยไม่มี footnote grader ไม่นับเพราะอยู่ใน section ความเห็น
- Haiku เรียก `okf_lint` เองหลังเขียนเกือบทุกครั้ง ส่วน Opus ใช้ `okf_request_review` บ่อยกว่า
- tool error มีครั้งเดียว: Haiku เรียก `okf_browse references/raw` ก่อนที่โฟลเดอร์จะมี ได้ not-found พร้อม hint
  ซึ่งเป็นพฤติกรรมที่ถูกต้อง

พฤติกรรมที่ดีซึ่งพบทุกรอบ:
- ค้นหาก่อนเขียนเสมอ
- ไม่แก้ policy ที่ human-reviewed แต่ใช้ `okf_request_review` แจ้งความขัดแย้งแทน
- ใน `no-duplicate` ปฏิเสธนิยามเก่า อธิบายเหตุผล และถามกลับ
- แปลงปี พ.ศ. เป็น ค.ศ. ถูกต้อง

### Reject (2026-10-22, DESIGN.md §5.3)

ก่อนเริ่ม Agent อีกตัวหนึ่งเขียน `decisions/gift-card-revenue` โดยไม่มี source แล้วเจ้าของ reject พร้อมเหตุผลว่า
ให้อ้าง memo FM-2026-17 (มี URL) และ link ไป `policies/revenue-recognition.md` ข้อมูลทั้งสองอย่างนี้ไม่อยู่ใน prompt
จึงต้องอ่านจาก `okf_history` เท่านั้น

| scenario | prompt | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|---|
| `reject-redo-hinted` | บอกว่ามี draft เก่าถูก reject | 2/2 | 2/2 |
| `reject-redo-unhinted` | ไม่บอก | 0/2 | 0/2 |

- รอบ hinted: Agent ทุกตัวเรียก `okf_history` ด้วย concept id ของ draft ที่ถูกลบไปแล้ว ซึ่งก่อนแก้จะได้ not-found
- รอบ unhinted: ไม่มี Agent ตัวไหนเรียก `okf_history` และทุกตัวตั้ง id ใหม่ใต้ `policies/` การเตือนตอนสร้างไฟล์ที่ path เดิม
  จึงช่วยไม่ได้
- **แก้แล้ว (ข้อความเท่านั้น):** server instructions และคำอธิบาย `okf_create` บอกให้อ่าน `okf_history` รายการล่าสุดก่อน
  สร้าง concept และให้ทำตามเหตุผลของการ reject แม้จะใช้ id อื่น ผลหลังแก้ (Haiku + Sonnet):

  | scenario | ก่อน | หลัง |
  |---|---|---|
  | `reject-redo-unhinted` | 0/4 | 4/4 |
  | `reject-redo-hinted` | 4/4 | 4/4 |
  | `record-decision` | 4/4 | 4/4 |
  | `distill-thai`, `attester-details`, `no-duplicate` (model ละ 1 รอบ) | – | 6/6 หลัง grade ใหม่ |

  - ทุกงานสร้าง concept มี `okf_history` เพิ่ม 1 call ค่าใช้จ่ายยังอยู่ในช่วงเดิม (Sonnet $0.05–0.10, Haiku $0.00–0.01)
  - `attester-details` ของ Haiku ไม่ผ่านตอนรันเพราะเขียนว่า "Compared by name, not by value" ซึ่ง pattern `/symbol/` จับไม่ได้
    ตอนนี้ pattern รับ "not by value" และ "never reads the bound value" ด้วย เมื่อ grade ผลที่เก็บไว้ทั้งหมดใหม่ 2 run
    ก่อนมี `okf_read_file` (ที่ Agent อ่าน code ไม่ได้และตอบผิด) ยังไม่ผ่านเหมือนเดิม pattern จึงไม่ได้หละหลวมเกินไป

## สิ่งที่ eval พบและแก้แล้ว

1. **index ถูกเขียนทับทั้ง bundle** (`cabc7d5`): `commit()` render `index.md` ใหม่ทุก directory
   ทั้งที่ DESIGN §4.5 กำหนดให้ทำเฉพาะ directory ที่ได้รับผลกระทบและ ancestor ผลคือ write แรกของ Agent
   เขียนทับ index ที่มนุษย์เขียนไว้ใน directory อื่น
2. **`sources[].language` หาย** (`1d202d1`): คำอธิบายของ `okf_ingest_raw` สอนแค่ `{ id, resource }`
   ตอนนี้ `okf_create`/`okf_update` เติม `language` จาก raw ให้ (DESIGN §4.8)
3. **คำอธิบาย tool ไม่ได้สอนกฎ footnote:** กฎ "definition ต้อง link ไป raw" และ "ตารางก็ต้องมี footnote"
   เดิมอยู่แค่ใน prompt `okf_distill` ตอนนี้ใส่ไว้ใน `okf_create` และ `okf_ingest_raw` แล้ว
4. **ตารางไม่มี footnote** (`8630adf`): เพิ่ม lint `table-uncited` (warning) สำหรับ curated concept ที่อ้าง raw
   และมีตารางที่ไม่มี footnote อยู่ข้างใน warning นี้กลับไปใน write result ทันที
5. **result ไม่บอกว่า warning ยังอยู่** (`6f43faf`): เดิม write result ส่งเฉพาะ warning ที่เกิดใหม่ เมื่อ Agent
   แก้ไม่สำเร็จจึงได้ `warnings: []` และคิดว่าแก้แล้ว ตอนนี้ result ส่งทุก warning ที่ concept ยังมีอยู่
   ส่วน error ยังบล็อกเฉพาะตัวที่เกิดใหม่เหมือนเดิม (DESIGN §6 ขั้น 9)

6. **อ่านเหตุผลของ Reject ไม่ได้** (2026-10-22): `okf_history` ที่ระบุ `concept_id` ต้องการให้ concept ยังมีอยู่
   แต่ draft ที่ถูก reject ถูกลบไปแล้ว ตอนนี้ไม่ตรวจว่ามีอยู่ แต่ยังตรวจ path scope ของ token เหมือนเดิม
7. **`okf_history` ไม่ได้เรียงใหม่สุดก่อนจริง** (2026-10-22): log.md เรียงวันจากใหม่ไปเก่า แต่ภายในวันเดียวกันต่อท้าย
   ทำให้ Revert มาหลัง Creation ของวันเดียวกัน ตอนนี้ผลลัพธ์เรียงใหม่สุดก่อน โดยไม่เปลี่ยนรูปแบบไฟล์

## ข้อจำกัดและงานต่อ

- การให้ Agent ดู history ก่อนสร้างพึ่งข้อความใน instructions เท่านั้น ไม่มีการบังคับที่ server และวัดแค่ 2 run
  ต่อ scenario กับ Claude Code client อื่นอาจไม่ทำตาม

- `claims-footnoted` นับทุกย่อหน้าใน concept ที่อ้าง raw จึงนับย่อหน้าความเห็นของ Agent เอง
  (เช่น "memo ไม่ได้บอกว่า...") เป็น claim ด้วย grader แยกไม่ได้ว่าย่อหน้าไหนมาจาก raw
  ผลที่ไม่ผ่านรอบ 4 จึงเป็นข้อจำกัดของ grader มากกว่าเป็นความผิดของ Agent
- grader ตรวจได้เฉพาะโครงสร้าง ไม่ได้ตรวจว่าแปลถูกหรือ claim ตรงกับต้นฉบับ ผลรอบนี้คนอ่านตรวจแล้วว่าถูก
- ทดสอบ Haiku, Sonnet และ Opus 5.5 แต่รอบละ 1–4 run ต่อ scenario เท่านั้น และยังไม่ได้ลอง client อื่นนอกจาก Claude Code
- grader ที่ข้าม section ความเห็นจะข้ามข้อเท็จจริงจาก raw ที่ Agent ใส่ไว้ใน section นั้นด้วย
