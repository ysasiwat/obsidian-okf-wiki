# ADR 0003: ผล spike S2–S4: การเขียนลงไฟล์ที่เปิดอยู่ และสัญญาณว่า "คนแก้"

- สถานะ: Accepted · 2026-10-19
- เกี่ยวข้อง: DESIGN.md §4.3, §5, §6; ADR 0001
- หมายเหตุ: โค้ดใน `spikes/` ที่ ADR นี้อ้างถึงอยู่ใน repo ที่ใช้พัฒนาเท่านั้น ไม่ได้อยู่ใน repo สาธารณะ (D8)
- วิธีทดสอบ: plugin `spikes/obsidian-spike` บน Obsidian 1.14.4 ใน vault ทดสอบ ทำ 2 รอบ
  การพิมพ์จำลองผ่าน Editor API (buffer เดียวกับคีย์บอร์ด) 15 วินาที ทุก 40 ms ระหว่างที่ระบบเขียน
  บรรทัด `spike_tick` ใน frontmatter ทุก 1 วินาที ส่วน S4 และการพิมพ์จริงทำโดยคน

## S2: เขียนลงไฟล์ที่เปิดอยู่ใน editor ขณะคนกำลังพิมพ์

| วิธี | รอบ | ข้อความที่พิมพ์ครบไหม | cursor กระโดด | write เข้า undo history ของคน |
|---|---|---|---|---|
| A `vault.process` | 1 | **ไม่ครบ:** ความยาวเท่าเดิม แต่เนื้อหาผิดตั้งแต่ตัวอักษรแรกที่พิมพ์ | 5 | (รอบ 1 ยังวัดไม่ได้) |
| A `vault.process` | 2 | ครบ | 1 | **ใช่:** 5 จาก 107 step และ undo ครั้งแรกย้อน write |
| B `editor.transaction` | 1, 2 | ครบ | 0–1 | **ใช่:** 4 จาก 104 step |
| C CodeMirror dispatch + `Transaction.addToHistory.of(false)` | 1, 1, 2 | ครบทุกรอบ | 0–1 | **ไม่:** 0 จาก 106 step |

(cursor 1 ครั้งที่นับได้คือตอนเริ่มทดสอบ เพราะ cursor ยังไม่ได้อยู่ท้ายเอกสาร)

**ข้อสรุป**

- `vault.process`/`vault.modify` กับไฟล์ที่เปิดอยู่ทำให้ Obsidian โหลดเนื้อหาจากดิสก์เข้า editor
  (transaction `userEvent: "set"`) และ **บางครั้งทำข้อความที่กำลังพิมพ์เสียหาย** (ผลไม่คงที่: รอบ 1 เสีย
  รอบ 2 ไม่เสีย) อีกทั้งยัง **เข้า undo history** ทำให้กด Ctrl+Z แล้วย้อนการเขียนของระบบแทนการพิมพ์ของ
  ตัวเอง จึง**ห้ามใช้กับไฟล์ที่เปิดอยู่**
- `editor.transaction` ปลอดภัยเรื่องข้อความ แต่เข้า undo history ของคน
- **ใช้ C** สำหรับการเขียนทุกครั้งลงไฟล์ที่เปิดอยู่ ข้อความไม่หาย และไม่เข้า undo history

## S3: อะไรบ้างที่ทำให้เกิด `editor-change` และใช้ `userEvent` แยกได้ไหม

| เหตุการณ์ | `editor-change` | `userEvent` ของ CM transaction |
|---|---|---|
| คนพิมพ์จริง | เกิด | `input.type` |
| Properties UI (แก้ title และเพิ่ม tag) | เกิด | `set` |
| แก้ไฟล์ที่เปิดอยู่จากภายนอก (แบบ sync หรือ git) | **เกิด** | `set` |
| `vault.process` กับไฟล์ที่เปิดอยู่ | **เกิด** | `set` |
| `renameFile` แก้ link ในไฟล์ที่เปิดอยู่ | **เกิด** | `set` |
| แก้ไฟล์ที่ไม่ได้เปิดจากภายนอก | ไม่เกิด | ไม่มี |
| เขียนผ่าน Editor API หรือ dispatch ของ plugin | เกิด | ไม่มี |

**ข้อสรุป**

- สมมติฐาน S3 ใน DESIGN v0.4 **ผิด:** `editor-change` เกิดทุกครั้งที่เนื้อหาของไฟล์ที่เปิดอยู่เปลี่ยน
  ไม่ว่าจะมาจากอะไร ถ้าใช้เป็นสัญญาณว่าคนแก้ จะบันทึก `human:` ผิดให้การ sync, git, rename และการเขียน
  ของระบบเอง
- **สัญญาณที่เชื่อถือได้คือ `userEvent` ของ CodeMirror transaction:** การป้อนจากคีย์บอร์ดและเมาส์ใน editor
  มี `input.*`, `delete.*`, `undo`, `redo`, `move.*` ส่วนการโหลดจากดิสก์มี `set` และ plugin ไม่มี
  userEvent
- **Properties UI แยกจากการโหลดเนื้อหาจากดิสก์ไม่ได้** (เป็น `set` เหมือนกัน) ถ้าจะแยกต้องเดาจาก DOM
  และ focus ซึ่งเปราะเกินไปสำหรับสัญญาณด้าน trust

## S4: Properties UI กับ frontmatter แบบ OKF (ผลเหมือนกันทั้ง 2 รอบ)

แก้แค่ title และเพิ่ม tag ผ่าน Properties UI แต่ Obsidian **เขียน frontmatter ใหม่ทั้งก้อน:**

- flow list `[a, b]` → block list (`tags`, `aliases`)
- flow mapping `{ by, at }` → block mapping (`generated` และสมาชิกของ `verified`)
- **comment หายไป**
- key ที่ไม่ได้แตะแต่เป็น scalar หรือ block อยู่แล้ว (`type`, `description`, `status`,
  `stale_after`, `sources`) ยังเหมือนเดิม และ timestamp ยังเป็น string ไม่ใส่ quote
- alias ภาษาไทยอยู่ครบ ลำดับ key คงเดิม

## สิ่งที่เปลี่ยนใน design (นำไปใช้ใน DESIGN v0.5)

1. **สัญญาณว่าคนแก้** (§5 ข้อ 2): ใช้ CM `userEvent` ที่ขึ้นต้นด้วย `input`, `delete`, `undo`, `redo`
   หรือ `move` บนไฟล์ใน bundle (ผ่าน `registerEditorExtension` + `EditorView.updateListener`) แทน
   `editor-change` ส่วน `set` และ transaction ที่ไม่มี userEvent **ไม่นับว่าเป็นคนแก้**
2. **Properties UI ไม่ถูกนับเป็นคนแก้** หลักการคือ "นับว่าคนแก้เฉพาะเมื่อมีหลักฐานชัด" เพราะถ้าไม่นับ
   (false negative) ผลแค่ provenance ไม่ครบ แต่ถ้านับผิด (false positive) จะทำลาย trust ดังนั้นการแก้
   `verified`/`status` ผ่าน Properties จะถูก trust snapshot ตรวจจับเป็น `unattested-*` (§5.1) และให้ใช้
   คำสั่ง Approve แทน
3. **การเขียนลงไฟล์ที่เปิดอยู่** (§6 ขั้นที่ 11):
   - ถ้าไฟล์เปิดอยู่ใน MarkdownView ใดก็ตาม ให้เขียนผ่าน CM dispatch แบบ minimal diff พร้อม
     `addToHistory.of(false)` ไม่ใช้ `vault.process` แล้วปล่อยให้ autosave ของ Obsidian เขียนลงดิสก์
   - ETag ของไฟล์ที่เปิดอยู่คำนวณจาก **buffer ของ editor** ไม่ใช่จากดิสก์
   - ถ้ามี input userEvent ในไฟล์นั้นภายใน 10 วินาทีล่าสุด write ของ Agent จะได้ 409 `being-edited`
     แทนที่จะแทรกเข้าไประหว่างที่คนกำลังพิมพ์
   - ถ้าไฟล์ไม่ได้เปิด ใช้ `vault.process` ตามเดิม
4. **Renderer ใช้ style ตามของเดิม** (§4.3): เวลา render key ที่มีอยู่แล้วใหม่ ให้ใช้ style เดิมของ key นั้น
   (flow หรือ block) ส่วน key ใหม่ในไฟล์ที่ทุก collection เป็น block (เช่นไฟล์ที่ Obsidian เคยเขียนแล้ว)
   ให้ใช้ block เพื่อไม่ให้ระบบเรากับ Obsidian สลับ style กันไปมา
5. **`renameFile`:** เมื่อ `alwaysUpdateLinks` เป็น true Obsidian แก้ link (ทั้ง markdown และ wikilink)
   ให้แล้ว การ rewrite ของเรา (§6.5) จึงต้อง idempotent คือแก้เฉพาะ link ที่ยังชี้ path เก่า

## รายงานรอบ 2 (จาก analyze.mjs)

```
S2 A-vault.process: ticks 15, typed 320, cursor jumps 1; intact editor YES, disk YES;
   undo 107 steps, 5 reverted a tick; first undo reverted tick
   cm: typist/none=320, none/set=14
S2 B-editor.transaction: ticks 14, typed 324, cursor jumps 0; intact YES/YES;
   undo 104 steps, 4 reverted a tick
S2 C-cm-dispatch-no-history: ticks 14, typed 324, cursor jumps 1; intact YES/YES;
   undo 106 steps, 0 reverted a tick
S3 typing: input.type=18 | Properties: set=2 | external open file: set=1 |
   external closed file: no editor event | renameFile (alwaysUpdateLinks=true): set=1
```

log ดิบของทั้ง 2 รอบ (`log-round{1,2}.jsonl`) เก็บไว้ในโฟลเดอร์ plugin ของ spike ใน vault ทดสอบ

## ภาคผนวก (2026-10-20): live test ของ writer ตัวจริง

- ทดสอบ live กับ `VaultFilePort` ระหว่างที่คนพิมพ์: ได้ `being-edited` 15 ครั้ง แล้วเขียนสำเร็จหลังหยุดพิมพ์ ข้อความที่พิมพ์ไม่หาย และ cursor ไม่กระโดด
- พบว่าข้อความที่พิมพ์**ก่อน** Agent เขียนกด undo ไม่ได้ เพราะประวัติ undo ส่วนนั้นหาย จึงแยกสาเหตุด้วย spike
  - **S2-D** (C + `view.save()`): undo ได้ 113 ขั้น เท่ากับ C ดังนั้น `save()` ไม่ใช่สาเหตุ
  - **S2-E** (`VaultFilePort` ตัวจริง พิมพ์ → Agent เขียน → พิมพ์ → undo ทันที): เขียนผ่าน `editor`
    ได้ 119 ขั้น undo ย้อนถึงข้อความก่อน Agent เขียน และไม่ย้อนการเขียนของ Agent
- **ข้อสรุป:** writer ทำงานถูกต้อง ส่วนที่ประวัติ undo หายในการทดสอบด้วยมือเกิดหลังเขียนหลายนาทีใน vault บน OneDrive
  จึงน่าจะมาจากการแก้ไฟล์ภายนอก ซึ่ง Obsidian โหลดเข้า editor ใหม่ ไม่ได้มาจากโค้ดของเรา
  ใน vault ที่ sync ผ่าน OneDrive จึงอาจเสียประวัติ undo ได้เองแม้ไม่มี plugin นี้
- **S2-F** (live test ของ Approve ใน Phase 3): เปลี่ยน frontmatter เชิงโครงสร้าง (เพิ่ม `verified`, ลบ `review_requested`)
  ของ note ที่เปิดอยู่และแสดงเป็น Properties ผ่าน `cm.dispatch` แล้ว**ไม่มีผลเลย** (เอกสารใน editor ไม่เปลี่ยน
  ไม่มี transaction) เพราะ change filter ของ Obsidian ทิ้ง change นั้น จึงได้ "did not apply cleanly"
  แก้โดยส่ง `filter: false` ใน dispatch ซึ่งปลอดภัยเพราะ change คำนวณจากเอกสารปัจจุบันและตรวจผลหลัง dispatch ทุกครั้ง
  ทดสอบซ้ำผ่าน S2-F และ Approve จริงแล้วสำเร็จ
