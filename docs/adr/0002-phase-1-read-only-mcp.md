# ADR 0002: โครงสร้างและการตัดสินใจของ Phase 1 (read-only MCP)

- สถานะ: Accepted · 2026-10-19
- เกี่ยวข้อง: DESIGN.md §3, §7, §8, §9, §13

## 1. แบ่ง layer ให้ test ได้โดยไม่ต้องมี Obsidian

```
src/core      okf-core (pure)                      ← CLI ใช้ร่วม
src/service   KnowledgeService + BundleProvider    ← ไม่ import obsidian
src/mcp       buildMcpServer(service, principal)   ← ไม่ import obsidian
src/server    OkfHttpServer, TokenStore            ← node:http/crypto
src/obsidian  VaultBundleSource (ผ่าน VaultPort), diskGuard, settings, settingsTab
src/main.ts   adapter: Obsidian Vault → VaultPort
```

ผลคือ logic ทั้งหมดยกเว้น UI และ adapter บางส่วนทดสอบใน Node ได้ ทั้ง MCP client จริงผ่าน
InMemoryTransport และ HTTP socket จริงทั้งสอง protocol revision ส่วน Obsidian เหลือแค่ `main.ts`
กับ `settingsTab.ts` ซึ่งตรวจด้วย live test (`test/integration/live.test.ts`)

## 2. Principal ต่อคำขอ

- revision `2026-07-28` (stateless): server สร้าง `McpServer` ใหม่ทุกคำขอ และส่ง principal ผ่าน
  `AsyncLocalStorage` ไปให้ factory ของ `createMcpHandler` (**เลิกใช้แล้วตาม ADR 0006** เพราะทำให้ renderer crash
  ตอนนี้ส่ง principal ผ่าน `req.auth` / `ctx.authInfo` แทน)
- sessionful (`2024-10-07…2025-11-25`): session **ผูกกับ token ที่เปิดมัน** ถ้า token อื่นส่ง
  `Mcp-Session-Id` เดียวกันมาจะได้ 404 ซึ่งต้นแบบไม่ได้ตรวจเรื่องนี้ จำกัด 64 session และเมื่อ revoke
  token จะปิด session ของ token นั้นทันที
- service กรองผลตาม allowlist ของ bundle และ path ทุกจุด รวมถึง backlinks, การ resolve sources,
  graph, lint, history และ bundle index (index.md ที่เก็บไว้ให้เฉพาะ token ที่ไม่จำกัด path)

## 3. การตัดสินใจย่อย

| เรื่อง | ข้อสรุป | เหตุผล |
|---|---|---|
| Plugin id | `okf-wiki` (ชื่อแสดง "OKF Wiki", ADR 0008) | guideline ของ Obsidian ห้ามมีคำว่า "obsidian" ใน id ส่วนชื่อ repo มีได้ |
| `Plugin.settings` | ใช้ `declare settings: PluginSettings` | Obsidian 1.13 เพิ่ม property นี้ใน base class |
| Token | `okf_` (ADR 0008) + 256-bit base64url เก็บเฉพาะ SHA-256 | มี prefix ทำให้ secret scanner จับได้ และ token สุ่มเต็มความยาวจึงไม่ต้องใช้ slow hash |
| เปรียบเทียบ token | `timingSafeEqual` กับ **ทุก** record | เวลาที่ใช้จะไม่ขึ้นกับว่าตรงกับ record ไหน |
| Throttle | นับเฉพาะ credential ผิด และตรวจ token ก่อน throttle | token ที่ถูกจะไม่ถูกหน่วงแม้ address นั้นโดน throttle (พบ bug ลำดับนี้ระหว่างเขียน และแก้แล้ว) |
| `/health` | ไม่ต้องใช้ token และตอบแค่ `{ok:true}` | ใช้ตรวจว่า server รันอยู่ โดยไม่บอก version หรือ bundle |
| Server เปิดเมื่อ | เปิดใน settings **และ** มี token อย่างน้อยหนึ่งตัว | ไม่เปิด port ทิ้งไว้ในเมื่อไม่มีใครเข้าได้ |
| ไฟล์ที่ไม่ใช่ filesystem adapter | ไม่ serve อะไรเลย | ตรวจ real path ไม่ได้ จึงไม่ปลอดภัย |
| `.okf.yaml` | อ่านใหม่ทุกครั้งที่ rebuild | เป็น dot-file ที่ Obsidian ไม่ index และไม่ส่ง event |
| Bundle ที่ vault root | ไม่อนุญาต | note ส่วนตัวจะได้ไม่ถูก serve ไปด้วยโดยไม่ตั้งใจ (D2) |
| ผลลัพธ์ tool | structuredContent + JSON text และไม่เกิน 256 KiB | MCP spec แนะนำให้มี text ด้วย และต้นแบบพบว่าผลลัพธ์ราว 1 MB ทำ renderer crash |
| Heading path ที่ส่งมาเป็น string | parse เป็น JSON array | client บางตัวส่ง array เป็น string มา (ต้นแบบเจอใน issue #315) |

## 4. สิ่งที่ยังไม่ได้ทำใน Phase 1

- prompts (`okf_author_concept`, `okf_distill_raw`) จะทำใน Phase 2 พร้อม write tools
- ทุก token เป็น read-only (scope อื่นถูก define ไว้แล้วแต่ยังไม่มี tool ใช้)
- ยังไม่ได้ verify ตัวตัดคำไทยใน Electron (S7)

## 5. ผล live verification (2026-10-19, Obsidian 1.14.4, vault ทดสอบบน OneDrive)

- `test/integration/live.test.ts` ผ่าน 3/3: `/health`, ปฏิเสธเมื่อไม่มี token, token ผิด และ Origin แปลกปลอม,
  revision `2026-07-28` ผ่าน SDK client และ legacy `initialize` ได้ `Mcp-Session-Id`
- **S7 ยืนยันใน Electron แล้ว:** ค้นคำไทย `ดาวเทียม`, `น้ำท่วม` และ `ถ่ายภาพ` เจอ raw source
  ภาษาไทย และการค้นแบบปกติ (curated เท่านั้น) ไม่คืน raw
- **vault events:** create, modify และ delete ไหลถึง index ครบ และ lint ของ raw ได้ code ที่ถูก
  (`raw-hash-missing`, `raw-unreferenced`)
- **Latency ของการแก้ไฟล์จากภายนอก Obsidian** (วัด 3 รอบ): create ปรากฏใน 0.65–1.0 วินาที
  ส่วน delete ใช้ราว 2.0 วินาที ฝั่งเรา debounce แค่ 300 ms ส่วนที่เหลือเป็นเวลาที่ file watcher ของ
  Obsidian หน่วง external delete ไว้ (น่าจะเพื่อแยกกับ rename) write ที่ผ่าน pipeline ของเราใน
  Phase 2 จะอัปเดต index ทันทีโดยไม่ต้องรอ event
