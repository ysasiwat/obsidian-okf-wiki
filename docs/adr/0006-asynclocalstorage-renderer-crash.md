# ADR 0006: `AsyncLocalStorage` ทำให้ renderer ของ Obsidian crash หลัง plugin reload

- สถานะ: Accepted · 2026-10-21
- เกี่ยวข้อง: DESIGN.md §8, ADR 0001 (S6), ADR 0005
- วิธีทดสอบ: vault ทดสอบบน Obsidian 1.14.4 (Electron) บน Windows 11 โดยเปิด Obsidian ด้วย
  `--enable-logging=stderr` แล้วยิง live suite ต่อเนื่อง ระหว่างนั้นเจ้าของปิด/เปิด plugin

## อาการ

- request MCP แรกหลังปิด/เปิด plugin บางครั้งได้ `ECONNRESET` ตามด้วย `ECONNREFUSED` อยู่หลายวินาที
  จากนั้น server ก็กลับมาเองและ status bar ขึ้นว่าทำงานอยู่ โดยไม่มี log เลย
- ครั้งหนึ่ง Obsidian ค้างเป็นจอดำ ต้องปิดแล้วเปิดใหม่
- `obsidian.log` มี `Loaded updated app` ตรงกับเวลาที่พังทุกครั้ง แปลว่าแอปเปิดตัวเองใหม่
  ส่วน log ของ Electron บันทึกว่า `Renderer process crashed`
- หน่วยความจำคงที่ราว 275 MB จึงเป็น native crash ไม่ใช่ out of memory
- console หายไปพร้อม renderer เลยไม่เห็น error ใด ๆ
- ใน Node ไม่เคยเกิด ทั้ง test ปกติและ live suite ที่รันกับ server ใน Node

## การไล่หาสาเหตุ

| build | ผล |
|---|---|
| 4B (MCP SDK 2.3.1) | crash |
| 4B + SDK 2.0.0 | crash: ไม่ใช่ SDK |
| 4B + SDK 2.0.0 + settings tab แบบ `display()` | crash: ไม่ใช่ settings tab |
| main (4A, 0.1.0) | crash: เป็น bug เก่าตั้งแต่ Phase 1 ไม่ได้เกิดใน 4B |
| main + ปิด server แบบนุ่มนวล (ไม่เรียก `closeAllConnections`) | crash: ไม่ใช่การปิด socket |
| 4B + ส่ง body เป็น `rawBody` (ไม่ผ่าน `Readable.toWeb`) | crash: ไม่ใช่ stream bridge ของ adapter |
| **4B ที่ไม่ใช้ `AsyncLocalStorage`** | **ไม่ crash ใน 6 reload ระหว่างที่มี traffic ต่อเนื่อง** รอบที่ไม่ผ่านมีแค่รอบเดียว ตรงจังหวะสลับ instance |

ข้อสังเกตที่นำไปสู่ข้อสรุป:
- `/health` ไม่เคยทำให้ crash มีแค่ request MCP เท่านั้น
- ยิ่ง plugin ถูกโหลดซ้ำใน renderer เดิมหลายรอบ ยิ่งมีโอกาส crash มากขึ้น
- `httpServer.ts` สร้าง `AsyncLocalStorage` ใหม่ทุกครั้งที่โหลด เพื่อส่ง principal ให้ factory ของ SDK
  และไม่เคยเรียก `disable()`
- `AsyncLocalStorage` เปิด promise hook ของ Node ทั้ง process แต่ใน renderer นั้น Node กับ Chromium
  ใช้ V8 isolate ตัวเดียวกัน

## การตัดสินใจ

- **ห้ามใช้ `node:async_hooks` (รวมถึง `AsyncLocalStorage`) ในโค้ดของ plugin** บังคับด้วย ESLint
  (`no-restricted-imports`) และเขียนไว้ใน AGENTS.md
- ส่ง context ของ request แบบ explicit: request แบบ stateless ส่ง principal ผ่าน `req.auth` โดย SDK
  ส่งต่อเป็น `ctx.authInfo` ให้ factory `clientId` เป็น key ใช้ครั้งเดียวที่ชี้ไปยัง Map ของ request ที่กำลังทำงาน
  และไม่มี token จริงอยู่ใน `authInfo` ส่วน session แบบ legacy ส่ง principal ตรงอยู่แล้ว
- การแก้อื่นที่ทำระหว่างไล่หาสาเหตุยังเก็บไว้ เพราะเป็น hardening ที่ถูกต้องในตัวเอง:
  - listener ของ `error`/`close` พร้อม `onUnexpectedClose`
  - การรีสตาร์ท server ทีละครั้ง
  - guard ตอน unload
  - log ระดับ debug บอกเหตุผลที่ start/stop

## ข้อจำกัด

- ไม่มี native stack trace เพราะ Obsidian ไม่ได้เปิด crash reporter ข้อสรุปมาจากการเทียบ build
  ที่ต่างกันทีละจุด ไม่ได้มาจากการอ่าน dump
- test ใน Node จับปัญหาแบบนี้ไม่ได้ ต้องรัน live suite พร้อมปิด/เปิด plugin ใน Obsidian จริงก่อน release ทุกครั้ง
