# OEP 階段與任務清單

日期 2026-11-21（Asia/Taipei）。Stage 5 已完成 Phase 0 probes 與報告，gate **未通過**。下一 phase 待阻擋項、owner 及獨立審查。 [v2 計畫與各 Phase 驗收](IMPLEMENTATION_PLAN_V2.md) · [Phase 0 gate](reviews/PHASE0_GATE_REPORT.md)

## Stage 1–4　審查與開工核准

- [x] Stage 1　Claude Code 與 Codex 完成獨立審查。
- [x] Stage 2　Codex 完整審查 Claude 兩份報告並回查固定版原始碼。Claude 只交叉讀了 Codex §A、§G、§H，§B–§F 未讀。
- [x] Stage 3　完成審查對照、ADR、v2、AEP gap、任務、決策與交接。
- [x] Stage 4　owner 回覆「接受所有建議預設並開工」，確認 v2 與 D01–D09。 [核准紀錄](DECISIONS.md#2026-11-21stage-4-核准與-phase-0-開工)

## Stage 5　開發

### Phase 0　驗證假設

- [ ] S1　版本、client、OpenAPI hash 已驗，容器 API 五類與 Automation 通過。原生 Windows OpenCode CLI／API 待隔離 VM。 [S1](validation/p0-s1-version.md)
- [ ] S2　實際 Gateway 經 OpenCode 達 20 連續工具回合，schema 與 PNG/PDF 通過。憑證 scope、認證異常、forced 回合、真故障矩陣待結。 [S2](validation/p0-s2-gateway.md)
- [x] S3　合成附件有界轉換、逐格 oracle、Windows junction／路徑與入口限制通過。模型側證據取同一組 S2 容器 probe。 [S3](validation/p0-s3-attachments.md)
- [ ] S4　隔離容器三次斷線收斂達標。原生 Windows 時序與 upstream overflow 待驗。 [S4](validation/p0-s4-sse.md)
- [ ] S5　隔離容器的 auth、loopback、proxy、Origin／Host／CSRF 已驗。原生 Windows OpenCode listener 仍待驗。 [S5](validation/p0-s5-security.md)
- [ ] S6　原生 Windows 合成 Job Object 正常／強制清除通過。OpenCode 程序樹、私有 VM 睡眠、登出與恢復待驗。 [S6](validation/p0-s6-windows.md)
- [x] S7　已列授權、provenance、MIT、secret scan 和 hook，公開 CI 執行待允許推送的時機。 [S7](validation/p0-s7-licensing.md)
- [x] 固定 48 題知識合成集、Recall@5、延遲與七份 probe 報告。 [基線](validation/p0-knowledge-baseline.md)
- [ ] Gate　Claude Code 獨立 review 和阻擋項關閉，確認通過後才開 Phase 1。

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
