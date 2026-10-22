# ADR 0007: ผล spike ของ Phase 4D (subscriptions, non-md read, franc-min)

- สถานะ: Accepted · 2026-10-21
- เกี่ยวข้อง: DESIGN.md §4.8, §7.3, §7.6, §13 (4D), D10
- หมายเหตุ: โค้ดใน `spikes/` ที่ ADR นี้อ้างถึงอยู่ใน repo ที่ใช้พัฒนาเท่านั้น ไม่ได้อยู่ใน repo สาธารณะ (D8)
- หลัก (D10): spike ก่อน แล้วทำต่อเฉพาะข้อที่ยืนยันว่ามี client ใช้จริง

## 1. Resource subscriptions: ไม่ทำ

**วิธีทดสอบ:** `spikes/subscriptions/probe-server.ts` เป็น MCP server ขั้นต่ำที่ประกาศ
`resources: { subscribe: true, listChanged: true }` เปลี่ยนเนื้อหา `probe://note` ทุก 5 วินาที แล้วส่ง
`notifications/resources/updated` และบันทึกทุก method ที่ client เรียกมา จากนั้นสั่ง Claude Code 2.1.304
แบบ headless (`claude -p`, Sonnet 5.5) ให้อ่าน resource แล้ว "subscribe ถ้าทำได้ และรอให้เปลี่ยน"

**ผล:**
- client เรียกแค่ `server/discover` (ลอง 2026-07-28 ก่อน) → `initialize` (2025-11-25) → `resources/list`, `tools/list`,
  `resources/read` และ `tools/call` **ไม่มี `resources/subscribe` หรือ `subscriptions/listen` เลย**
- โมเดลตอบเองว่าไม่มีเครื่องมือสำหรับ subscribe และไม่ได้รับ notification ใด ๆ

**ข้อสรุป:** client หลักของเราไม่ใช้ subscription จึงไม่ทำ ถ้า plugin อื่นต้องรู้ว่ามีการเปลี่ยนแปลง ให้ใช้ `onCommit`
ของ extension API (§7.6) จะกลับมาทำเมื่อมี client ที่ subscribe จริง โดยใช้ probe ตัวเดิมทดสอบซ้ำ

## 2. `okf_read` สำหรับไฟล์ที่ไม่ใช่ markdown (เช่น `attesters/*.py`): เลื่อนไปก่อน

- ใน Obsidian `VaultBundleSource` เก็บไฟล์ที่ไม่ใช่ `.md` เป็นข้อความว่างโดยตั้งใจ (index ต้องรู้แค่ว่ามีไฟล์อยู่)
  การรองรับจึงต้องเปลี่ยนวิธีโหลดไฟล์ จำกัดชนิดและขนาดไฟล์ และเพิ่มการตรวจผ่าน diskGuard
  เป็นงาน feature ไม่ใช่การแก้เล็กน้อย
- ไม่มีหลักฐานว่ามี Agent ต้องใช้: ทุกรอบของ agent eval (ADR 0004) ไม่มี Agent ตัวไหนพยายามอ่านไฟล์ที่ไม่ใช่ md
  และยังไม่มี scenario ที่เกี่ยวกับ Attested Computation
- **จะกลับมาทำเมื่อ:** เพิ่ม eval scenario ที่ให้ Agent ตรวจ receipt ของ computation แล้วพบว่าต้องอ่านโค้ดของ attester

## 3. `franc-min` สำหรับภาษาที่ใช้อักษร Latin: ไม่ทำ

**วิธีทดสอบ:** `franc-min` 6 กับประโยคสั้น 10 ประโยค (อังกฤษ 5, ฝรั่งเศส, อินโดนีเซีย, สเปน, เยอรมัน, เวียดนาม)
ยาว 12–72 ตัวอักษร ซึ่งเป็นความยาวพอ ๆ กับคำอธิบายหรือย่อหน้าของ concept

**ผล:**
- ภาษาที่ไม่ใช่อังกฤษถูกระบุว่าไม่ใช่อังกฤษครบทุกประโยค
- แต่**ประโยคภาษาอังกฤษ 1 ใน 5 ถูกระบุเป็นภาษาเยอรมัน** ("Members get a longer return window starting in January.")
- ทำให้ `main.js` ใหญ่ขึ้น 171 KB

**ข้อสรุป:** ถ้าเอาไปใช้บล็อกตอนเขียน การเขียนภาษาอังกฤษปกติจะถูกปฏิเสธผิด ๆ ซึ่งแย่กว่าข้อจำกัดเดิม
(ตรวจไม่เจอภาษาที่ใช้อักษร Latin) จึงไม่ทำ ถ้าจะลองอีกครั้ง ให้ใช้เป็นแค่ lint ระดับ info กับ body ที่ยาวพอ
และวัด false positive กับ concept จริงก่อน

## ผลรวมของ 4D

ไม่มีงานไหนผ่านเกณฑ์ D10 จึงไม่มีโค้ดใหม่ใน plugin เก็บไว้แค่ probe ใน `spikes/subscriptions/` สำหรับทดสอบซ้ำ

## ภาคผนวก (2026-10-21): ข้อ 2 มีหลักฐานแล้ว จึงสร้าง `okf_read_file`

- agent eval รอบ 2 เพิ่ม scenario `attester-details` ซึ่งถามข้อมูลที่มีอยู่แค่ใน `attesters/sql_equality.py`
  (bind variable ถูกเทียบแบบ symbolic และ verdict มี `reason`)
- **ผลก่อนสร้าง:** Agent พยายาม `okf_read("attesters/sql_equality.py")` ครบ 2 ใน 2 run แต่ได้ not-found
  จึงบอกผู้ใช้ตรง ๆ ว่ายืนยันรายละเอียดเหล่านั้นไม่ได้ (ไม่ได้แต่งข้อมูลขึ้นมาเอง) และไม่ผ่าน `mentions`
  ทั้ง 2 run เข้าเงื่อนไขในข้อ 2 ข้างบน
- **สิ่งที่สร้าง:**
  - tool `okf_read_file` (scope read): อ่านไฟล์ข้อความที่ไม่ใช่ markdown ตาม allowlist ของนามสกุล แบบแบ่งหน้า
    ใช้ path scope ของ token, ซ่อน path ที่เป็น hidden, และตรวจ disk guard อีกครั้งตอนอ่าน (`BundleProvider.readText`)
  - ไม่อ่าน markdown (ให้ใช้ `okf_read`) และไม่อ่าน binary
  - `okf_read` ที่ถูกเรียกด้วย path ของไฟล์จะได้ hint ให้ไปใช้ `okf_read_file`
