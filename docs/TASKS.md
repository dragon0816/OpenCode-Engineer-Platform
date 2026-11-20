# OEP 階段與任務清單

日期 2026-11-21（Asia/Taipei）。「完成」表示該文件已交付或個別 gate 已由證據驗收。Stage 5 的所有 Phase 尚待啟動。 [v2 計畫與各 Phase 驗收](IMPLEMENTATION_PLAN_V2.md)

## Stage 1–4　審查與開工核准

- [x] Stage 1　Claude Code 與 Codex 完成獨立審查。
- [x] Stage 2　Codex 完整審查 Claude 兩份報告並回查固定版原始碼。Claude 只交叉讀了 Codex §A、§G、§H，§B–§F 未讀。
- [x] Stage 3　完成審查對照、ADR、v2、AEP gap、任務、決策與交接。
- [ ] Stage 4　owner 回覆確認 v2，裁決 D01–D09 或明確接受預設。狀態為待核准。

## Stage 5　開發（待 Stage 4 核准）

### Phase 0　驗證假設

- [ ] S1　OpenCode binary/client/OpenAPI pin、API/Automation 契約。
- [ ] S2　LiteLLM scoped key 與 aliases，真實工具、結構化輸出、錯誤和媒體。
- [ ] S3　PNG/PDF/XLSX 模態、有界轉換與附件限制。
- [ ] S4　SSE 斷線後狀態收斂、隔離和重送。
- [ ] S5　loopback、password、proxy、Origin/Host/CSRF。
- [ ] S6　Windows supervisor、Job Object、睡眠、登出和路徑。
- [ ] S7　授權、provenance、secret scan。
- [ ] 鎖 48 題知識合成集與字詞匹配基線，留存七份 spike 證據及 reviewer 通過。

### Phase 1　Runtime 與 SOP→XLSX

- [ ] 管理監督程序、OpenCode client/session mapping 與權限。
- [ ] 通過 Gateway 契約、兩 session 隔離與 evidence stub。
- [ ] 完成 run/receipt/manifest，SOP→XLSX 連續 5/5，注入失敗的假成功為 0。
- [ ] 提交 Phase 1 驗收和獨立 review。

### Phase 2　Web、launcher 與附件

- [ ] 單鍵 Windows 啟動與同源 Web chat、上傳和下載。
- [ ] 驗證路徑邊界、隔離、Origin/CSRF、重連及程序樹清理。
- [ ] 提交 Phase 2 驗收和獨立 review。

### Phase 3a　唯讀 BI/Wiki

- [ ] 乾跑／shadow 遷移、provenance、備份還原、唯讀概覽。
- [ ] FTS5 繁中與料號查詢、明確 Ask retrieval-first、共用 verifier、聊天 MCP。
- [ ] 固定 gold set 達標，提交 Phase 3a 驗收和獨立 review。

### Phase 3b　Ingest／review／publish

- [ ] BI staging／schema/evidence、Wiki sandbox 與人工核准。
- [ ] 永續 job/effect ledger、冪等發布、失敗恢復及 rollback。
- [ ] 提交 Phase 3b 驗收和獨立 review。

### Phase 4　Telegram 和三種 BI 觸發

- [ ] Main／BI bot 隔離、durable inbox/cursor、outbox、`/ask`。
- [ ] 即時、定時、Run Now 共用 claim，睡眠／時區／漏跑，來源阻塞保留補件。
- [ ] 合成 crash/replay 與兩真 bot smoke，提交 Phase 4 驗收和獨立 review。

### Phase 5　發行及回歸

- [ ] Windows VM 安裝、全程 E2E、升級、rollback 與備份恢復。
- [ ] SBOM、NOTICE、checksums、secret scan 和操作文件。
- [ ] 提交 Phase 5 驗收和獨立 review。
