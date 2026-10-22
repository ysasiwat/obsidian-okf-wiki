# ADR 0008: เปลี่ยนชื่อเป็น OKF Wiki เพื่อ release สาธารณะ

- สถานะ: Accepted · 2026-10-22
- เกี่ยวข้อง: DESIGN.md §14 (D8), ADR 0002

## บริบท

เจ้าของตัดสินใจ release plugin สาธารณะและส่งที่ community.obsidian.md (D8) ชื่อเดิมเป็นชื่อเรียกภายใน
โปรเจกต์ส่วนตัวของเจ้าของ ซึ่งไม่ควรปนกับโปรเจกต์สาธารณะ และไม่ได้บอกผู้ใช้ว่า plugin ทำอะไร

## การตัดสินใจ

- plugin id `okf-wiki` และชื่อแสดง "OKF Wiki" (id ยังไม่ซ้ำกับ plugin ใน community-plugins.json
  ณ 2026-10-22 และตาม guideline id ต้องไม่มีคำว่า "obsidian")
- repo สาธารณะชื่อ `obsidian-okf-wiki` (ชื่อ package และชื่อ MCP server ตรงกัน)
- token ใหม่ขึ้นต้นด้วย `okf_`, CSS class และ view type ขึ้นต้นด้วย `okf-wiki-`, ตัวแปร live test เป็น
  `OKF_WIKI_*`, class ใน TypeScript เป็น `OkfWiki*`
- เปลี่ยนทุกที่ใน repo รวมถึง DESIGN.md และ ADR เก่า ไม่ทำเป็นการแทนคำตอน export เพื่อให้โค้ดที่
  ทดสอบแล้วกับโค้ดที่ release เป็นชุดเดียวกัน

## ผลที่ตามมา

- Obsidian เก็บ settings และ state ตาม id ผู้ที่ติดตั้งชื่อเดิมไว้ต้องย้ายโฟลเดอร์ plugin ใน
  `<configDir>/plugins/` ไปเป็น `okf-wiki/` เองก่อนเปิดตัวใหม่ ไม่ทำ migration ในโค้ดเพราะยังไม่มีผู้ใช้สาธารณะ
- token ที่ออกไปแล้วยังใช้ได้ เพราะ server ตรวจจาก SHA-256 ของ token ทั้งก้อน ไม่ได้ตรวจ prefix
- review queue ที่เปิดค้างไว้ใน workspace เดิมจะหาย view type เดิม ต้องเปิดใหม่ด้วยคำสั่ง **Open review queue**
- snippet สำหรับ client ที่สร้างใหม่ใช้ชื่อ server `okf-wiki` ส่วน config ของ client ที่มีอยู่แล้วไม่ต้องแก้
