# ADR 0005: Phase 4A Hardening: งานบน UI thread และการเริ่ม server

- สถานะ: Accepted · 2026-10-20
- เกี่ยวข้อง: DESIGN.md §4.5, §6, §8, §13 (4A), Appendix E
- วิธีวัด: `npm run bench` (`scripts/bench.ts`) บน bundle สังเคราะห์ 1,000 และ 5,000 concept ใน Node 24
  เครื่องเดียวกันทุกรอบ ค่าแกว่งราว ±20% ระหว่างรอบ

## ปัญหา

server ทำงานใน renderer thread เดียวกับ UI ของ Obsidian เวลาที่ใช้ต่อ write คือเวลาที่ UI ค้าง
baseline ที่ 5,000 concept ได้ผลดังนี้

- write ครั้งเดียว 2.5 s และถ้า Review Queue เปิดอยู่จะเป็น 3.0 s
- search ครั้งแรกหลัง write ใช้ 324 ms

## การตัดสินใจ

1. **lint `table-uncited` เป็น linear** (`49269bf`): เดิม rule นี้ไล่ `model.edges` ทั้ง bundle ต่อทุก concept
   ทำให้เป็น O(n²) ตอนนี้อ่านจาก `fieldPaths` ของ concept เอง
2. **`analyzeBundle(files, previous)`** (`946be93`, `0dfc56b`): ไฟล์ที่ข้อความไม่เปลี่ยนจะใช้ผล parse เดิมซ้ำ
   ได้แก่ frontmatter, body, link ที่ extract แล้ว และปลายทางของ markdown link ส่วน `exists`,
   zone และ backlink คำนวณใหม่ทุกครั้ง มี property test ยืนยันว่าผลเท่ากับการ analyze ใหม่ทั้งหมด
3. **render index เฉพาะ directory ที่ได้รับผล** (`2a05849`): `renderAllIndexes(model, descriptions, only)`
4. **search index ข้าม version** (`86b3836`): ส่งต่อ index พร้อม model ที่ index นั้นสะท้อน แล้ว index ใหม่
   เฉพาะ concept ที่ parse เปลี่ยน โดยเทียบ `frontmatter` ด้วย identity
   - เปลี่ยน `discard(id)` เป็น `remove(doc)` เพราะ discard ทิ้งสถิติ term เก่าไว้ ทำให้ score ไม่ตรงกับ
     index ที่สร้างใหม่
   - มี test เทียบทั้งผลลัพธ์และ score
5. **lint cache ต่อ concept** (`45f96df`): `WeakMap` ที่ใช้ frontmatter object เป็น key คู่กับ key string
   ที่รวมทุกอย่างที่ `lintConcept` อ่าน ได้แก่ zone, resolution ของ link และ field, zone ของปลายทาง source,
   threshold และ stale ทุกข้อในรายการนี้มี test ที่จะไม่ผ่านถ้าตัดออกจาก key
6. **validate เฉพาะ concept ที่เขียน** (`ca88b92`): แยก `analyzeConcept` และ `bundleResolver`
   ออกจาก `analyzeBundle` แล้วให้ `validate()` วิเคราะห์เฉพาะไฟล์ที่เขียน
7. **server รอด plugin reload** (`adc872b`): Obsidian ไม่ await `onunload` และ instance ใหม่เริ่มทันที
   - เดิม `onunload` flush trust ledger ก่อน stop server จึงเกิด `EADDRINUSE` ได้ จากนั้น instance เก่าก็ปิด
     ผลคือไม่มี server เลย อาการนี้ตรงกับที่เจอใน live test ครั้งก่อน
   - ตอนนี้คืน port ก่อน และ `start()` retry `EADDRINUSE` ได้นานสุด 3 s
   - ถ้า `stop()` ระหว่างรอ จะไม่มี listener ค้าง
   - มี test reload 10 ครั้งติดกันบน port เดียว

## ผล

| 5,000 concept | ก่อน | หลัง |
|---|---|---|
| write | 2,479 ms | 48 ms |
| write + Review Queue | 2,975 ms | 82 ms |
| search หลัง write | 324 ms | 19 ms |
| lint ทั้ง bundle (ครั้งแรก) | 703 ms | 175 ms |

ตามเกณฑ์ 4A ต้องได้ write ≤ 200 ms และไม่บล็อก UI เกิน 100 ms ต่อครั้ง ซึ่งผ่านใน Node

## ข้อจำกัด

- งานที่ยังหนักคือ **การโหลดครั้งแรก**: analyze 749 ms + lint 175 ms + search index 304 ms ที่ 5,000 concept
  เกิดครั้งเดียวตอนเปิด vault, reload bundle หรือแก้ `.okf.yaml` ยังไม่ได้แบ่งเป็นช่วง
- ตัวเลขทั้งหมดวัดใน Node ยังไม่ได้วัดใน Obsidian และ reload 10 ครั้งก็ทดสอบด้วย server ใน Node
  จึงต้องยืนยันใน Obsidian จริงด้วย live suite (`test/integration/liveWrites.test.ts`)

## ยืนยันใน Obsidian (2026-10-21)

ติดตั้ง build ของ branch นี้ลงใน vault ทดสอบแล้วได้ผลดังนี้

- `test/integration/liveWrites.test.ts` ผ่าน 3/3: distill + `table-uncited` + review request
  และ index ของ directory ที่ไม่เกี่ยวข้องคงเดิมทุก byte
- `test/integration/live.test.ts` ผ่าน 3/3
- เจ้าของ reload plugin หลายรอบติดกัน server ขึ้นทุกครั้ง
- ตัวเลขเวลายังเป็นค่าที่วัดใน Node ส่วนเวลาใน Obsidian ยังไม่ได้วัด

## ภาคผนวก (2026-10-21): server หายทั้งที่ status bar ยังขึ้นว่าทำงานอยู่

- ใน live test ของ build 4B มีครั้งหนึ่งที่ request MCP ครั้งแรกโดน `ECONNRESET` จากนั้น port ก็ไม่มีอะไร listen อยู่เลย
  แต่ status bar ยังขึ้น `OKF MCP :27150` และไม่มี log ใด ๆ ใน console
- พอใส่ diagnostic build ที่ฟัง event `error` และ `close` ของ http server เข้าไป อาการนี้ก็ไม่เกิดอีกเลยตลอด 3 รอบ
- สาเหตุที่น่าจะเป็นที่สุด: หลัง `listen()` สำเร็จ server ไม่มี listener ของ `error` แล้ว ถ้ามี `error` เกิดขึ้นระดับ server
  (เช่นตอน accept บน Windows) Node จะ throw ออกมา ซึ่งอาจทำให้ listener ปิดไปโดยที่ plugin ไม่รู้
  ตรงนี้ยังเป็นการอนุมานจากหลักฐาน เพราะทำให้เกิดซ้ำได้ไม่ครบเงื่อนไข
- แก้แล้ว: server มี listener ของ `error` ถาวร ซึ่งบันทึก log แล้วทำงานต่อ ถ้า listener ปิดเองโดยไม่ได้เรียก `stop()`
  จะเรียก `onUnexpectedClose` แล้ว plugin แสดง error ใน status bar พร้อม Notice ให้สั่ง Restart MCP server
  ถ้าเกิดอีกครั้งจะเห็นและวิเคราะห์ได้ทันที

**แก้ไข (2026-10-21, ADR 0006):** สาเหตุที่อนุมานไว้ข้างบนผิด จริง ๆ แล้ว Obsidian renderer crash
ทั้งตัวแล้วเปิดตัวเองใหม่ เพราะ `AsyncLocalStorage` ที่ถูกสร้างใหม่ทุกครั้งที่ plugin reload ส่วน diagnostic build
ที่ไม่พัง น่าจะเป็นแค่เรื่องจังหวะเวลา listener ของ `error`/`close` ยังเก็บไว้ในฐานะ hardening

## ภาคผนวก (2026-10-21): การโหลดครั้งแรกแบบแบ่งช่วง

ข้อจำกัดเรื่อง "การโหลดครั้งแรก" ข้างบนแก้แล้ว:
- **`analyzeBundleSliced`** (`3e4a6f6`): ใช้ขั้นตอนต่อไฟล์ชุดเดียวกับ `analyzeBundle` (เป็น generator) แล้วคืนการทำงาน
  ให้ event loop ทุก 16 ms `VaultBundleSource` ใช้ตอนโหลดครั้งแรก และมีตัวนับกันไม่ให้ผลที่เสร็จช้าทับ model
  ที่ใหม่กว่า ส่วน `reload()` ใช้ model เดิมเป็น previous ไฟล์ที่ไม่เปลี่ยนจึงไม่ต้อง parse ใหม่
- **`KnowledgeService.warm`** (`c40c49f`): หลัง `reloadBundles` ทุกครั้งจะเติม lint cache ต่อ concept (`warmLint`)
  และสร้าง search index ใหม่ทีละช่วง request แรกจึงไม่ต้องทำทั้งหมดในครั้งเดียว

ผลจาก `npm run bench` วัดตอนที่เครื่องโหลดหนักมาก ตัวเลขสัมบูรณ์ช้ากว่ารอบก่อนราว 8 เท่า
แต่สัดส่วนเทียบได้เพราะวัดในจังหวะเดียวกัน:

| first load | ทำครั้งเดียว (เดิม) | ช่วงที่ยาวที่สุด (ตอนนี้) |
|---|---|---|
| 1,000 concept | 1,745 ms | 31 ms |
| 5,000 concept | 5,970 ms | 83 ms |

การโหลดทั้งหมดยังใช้เวลารวมเท่าเดิม (บวก overhead ของการแบ่งช่วงนิดหน่อย) แต่ UI ไม่ค้าง
ระหว่างที่ยังโหลดไม่เสร็จ bundle จะยังไม่พร้อมใช้ หรือถ้าเป็นการ reload จะยังใช้ model เดิมไปก่อน

## ภาคผนวก (2026-10-21): write ใน Obsidian ช้า เพราะ snapshot prune

- ใน Obsidian แต่ละ write ใช้ราว 0.8 วินาที ในขณะที่ Node ใช้เพียงหลักสิบ ms ทดลองเทียบ main กับ branch ตอนหน้าต่างอยู่ด้านหน้า
  ได้ผลเท่ากัน จึงไม่ใช่ regression
- **สาเหตุ:** ทุกครั้งที่บันทึก snapshot `FileSnapshotStore.prune()` จะ list โฟลเดอร์ แล้ว stat, read และ parse
  snapshot ทุกไฟล์ วัดบนโฟลเดอร์จริงที่มี 166 ไฟล์บน OneDrive ได้ราว 300 ms ต่อ write ใน Node และจะช้าลงเรื่อย ๆ
  เพราะ snapshot เก็บไว้ได้ถึง 7 วันหรือ 50 MB
- **แก้แล้ว** (`f28250d`): เก็บดัชนีเวลาและขนาดของ snapshot ไว้ในหน่วยความจำ อ่านโฟลเดอร์ครั้งเดียวต่อ session
  จากนั้นทั้ง prune, save และ discard ใช้ดัชนีอย่างเดียว ไฟล์ที่ชื่อไม่ตรงรูปแบบที่ store สร้างจะถูกข้าม
- **ผลใน Obsidian:**
  - write ครั้งแรกหลัง reload ใช้ 821 ms เพราะต้องโหลดดัชนี
  - write ครั้งถัดไปใช้ 160–200 ms จากเดิมราว 800 ms
  - write suite: 3.6/1.0/4.2 s → 1.5/0.5/1.1 s
- **ดัชนีเป็นไฟล์เดียว** (`86687b7`): เก็บไว้ที่ `state/snapshots.index.json` และเขียนทุกครั้งที่ดัชนีเปลี่ยน
  ตอนโหลดจะถือเป็นแค่ cache: list โฟลเดอร์ แล้วอ่านเฉพาะ snapshot ที่ไฟล์ไม่รู้จัก ตัด entry ที่ไฟล์หายไปแล้ว
  และสร้างใหม่ถ้าไฟล์เสีย
  ผลใน Obsidian: write แรกของ session ใหม่ใช้ 420 ms (เดิม 821 ms) ส่วน write ถัดไปใช้ 224–318 ms
  ซึ่งรวมการเขียนไฟล์ดัชนีแล้ว

## ภาคผนวก (2026-10-22): เวลาของแต่ละขั้นใน write

- วัดใน Obsidian 1.14.4 บน vault ทดสอบที่อยู่บน OneDrive โดยให้หน้าต่างอยู่ด้านหน้า แต่ละ `okf_update` ใช้ 130–240 ms
  (round trip ผ่าน MCP) โดยใช้ build ชั่วคราวที่จับเวลาทุก call ของ port ใน write หนึ่งครั้ง (ราว 140–170 ms ใน plugin) ได้ดังนี้
  - เขียน `log.md` 43–76 ms
  - audit append 29–41 ms (`exists` ราว 15–23 ms)
  - snapshot (ไฟล์ snapshot + ไฟล์ดัชนี) 24–32 ms
  - เขียน concept 15–20 ms
  - `analyzeBundle` + `applyLocal` ราว 6 ms
- ขั้นที่ตามหลังการเขียนไฟล์ใน vault จะช้ากว่าปกติเสมอ (`log.md` อ่าน 20–30 ms เทียบกับ concept 2–7 ms)
  เพราะต้องรอให้ Obsidian จัดการไฟล์ที่เพิ่งเขียนก่อน ไม่พบ long task ที่เกิน 50 ms เลย
- **ลองไม่รอ audit และไฟล์ดัชนีก่อนตอบ:** round trip ยังอยู่ที่ 128–195 ms เท่าเดิม จึงย้อนการเปลี่ยนแปลงนี้
- **CPU profile ผ่าน CDP** (`--remote-debugging-port`; ใช้ `require("inspector")` ใน renderer ไม่ได้เพราะไม่มี
  V8 inspector) ระหว่าง 13 write ได้เวลาต่อ write ดังนี้
  - JS ของ plugin ราว 39 ms (MCP SDK, zod และ `commit` ราว 11 ms)
  - native/Electron ราว 38 ms, `app.js` ของ Obsidian ราว 13 ms, GC ราว 7 ms
  - ที่เหลือ main thread ว่าง รอ file I/O
- **สรุป:** ไม่มีขั้นใดที่เด่นพอให้ตัดได้ เวลาราวครึ่งหนึ่งเป็น file I/O บน OneDrive (ประมาณ 9 operation ต่อ write)
  อีกครึ่งเป็น CPU ที่กระจายอยู่หลายส่วน 170 ms ต่อ tool call ยังน้อยมากเมื่อเทียบกับเวลาคิดของ Agent จึงหยุดที่นี่
- **สิ่งที่พบระหว่างวัด:** `FileAuditLog.append` ทำงานซ้อนกันได้เมื่อมี write สอง bundle พร้อมกัน ถ้าเกิดตอนไฟล์ถึง
  5 MB ทั้งสอง append จะ rotate ทั้งคู่ และ append ที่สองจะลบ `audit.1.jsonl` ที่เพิ่ง rotate ไป
  ตอนนี้ append ทำทีละครั้งตามลำดับ
