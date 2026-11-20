# OEP 階段與任務清單

日期 2026-11-21（Asia/Taipei）。Phase 0 第 2 輪修正與開發者重測已交付。修訂後的 gate 待獨立複核，本機合併尚未執行。原 v2 的 O-1 至 O-4 全部結清門檻保留作歷史。 [Owner 核准修訂](IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment) · [Phase 0 gate](reviews/PHASE0_GATE_REPORT.md)

## Stage 1–4　審查與開工核准

- [x] Stage 1　Claude Code 與 Codex 完成獨立審查。
- [x] Stage 2　Codex 完整審查 Claude 兩份報告並回查固定版原始碼。Claude 只交叉讀了 Codex §A、§G、§H，§B–§F 未讀。
- [x] Stage 3　完成審查對照、ADR、v2、AEP gap、任務、決策與交接。
- [x] Stage 4　owner 回覆「接受所有建議預設並開工」，確認 v2 與 D01–D09。 [核准紀錄](DECISIONS.md#2026-11-21stage-4-核准與-phase-0-開工)

## Stage 5　開發

### Phase 0　驗證假設

- [ ] S1　版本、client、OpenAPI hash 已驗，容器 API 五類與 Automation 通過。O-3a 另驗原生 Windows `/api/info` 與基本 session；完整原生契約不在 O-3a 內。 [S1](validation/p0-s1-version.md)
- [ ] S2　舊真 Gateway 穩定性 PASS 降為 **UNVERIFIED**。新斷言於合成 relay 證實兩 alias 各 10 回合及完整 forced turn。真 Gateway 重測待可驗 TLS 的 HTTPS 入口，key scope、認證異常與真故障矩陣仍待結。 [S2](validation/p0-s2-gateway.md)
- [x] S3　合成附件有界轉換、逐格 oracle、Windows junction／路徑與入口限制通過。模型側證據取同一組 S2 容器 probe。 [S3](validation/p0-s3-attachments.md)
- [ ] S4　隔離容器三次斷線收斂達標。原生 Windows 時序與 upstream overflow 待驗。 [S4](validation/p0-s4-sse.md)
- [ ] S5　隔離容器的 auth、loopback、proxy、Origin／Host／CSRF 已驗。O-3a 原生 Windows listener 核對通過，完整原生 proxy 集成另行驗收。 [S5](validation/p0-s5-security.md)
- [x] O-3a　Windows 11 x64 本機的 native OpenCode 基本測試與合成 Job probe 通過。 [S6](validation/p0-s6-windows.md)
- O-3b　**WAIVED by owner – not tested**。真實 OS 睡眠／喚醒與登出／再登入無測試；此項無 GPT dots、VM 或 Hyper-V 工作。D06 行為與 RPO/RTO 仍為 **UNVERIFIED** 設計假設。
- [x] S7　已列授權、provenance、MIT、secret scan 和 hook。合成測試證明裸私網 IPv4 可脫離環境值偵測。公開 CI 執行待允許推送的時機。 [S7](validation/p0-s7-licensing.md)
- [x] 固定 48 題知識合成集、Recall@5、延遲與七份 probe 報告。 [基線](validation/p0-knowledge-baseline.md)
- [x] 修正第 1 輪　I-1 完整 forced turn、I-2 私網 IPv4 掃描、I-3 Phase 1 出口驗收補充。 [修正證據](reviews/PHASE0_GATE_REPORT.md)
- [x] O-4　Owner 核定最小 D08 smoke oracle，PDF 對照與雜湊測試通過；核定範圍僅限管線接線。 [D08 核定](validation/d08-oracle.md)
- [ ] Gate　第 2 輪修正待獨立複核；O-3a 已通過。O-1／O-2 由 Gateway 管理員追蹤為 known risks，O-3b 已免測。 [責任人清單](HANDOFF.md#phase-0-owner-checklist)
- [ ] 合併前掃描來源與目標 commit tree 及工作樹，記錄零命中。 [S7](validation/p0-s7-licensing.md)

### Phase 1　Runtime 與 SOP→XLSX

- [ ] 管理監督程序、OpenCode client/session mapping 與權限。
- [ ] 通過 Gateway 契約、兩 session 隔離與 evidence stub。
- [ ] 在 Windows VM 驗證 OpenCode 及子程序只能透過受限 relay 連核准 Gateway，完成旁路負例。 [出口驗收](IMPLEMENTATION_PLAN_V2.md#phase-1-egress-acceptance)
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
- [ ] 即時、定時、Run Now 共用 claim，處理時區、漏跑與來源阻塞；實作啟動／恢復對帳，以模擬時鐘跳躍與終止程序／重啟做單元及整合驗收。真實 OS 睡眠／登出行為仍為 **UNVERIFIED**。
- [ ] 合成 crash/replay 與兩真 bot smoke，提交 Phase 4 驗收和獨立 review。

### Phase 5　發行及回歸

- [ ] Windows VM 安裝、全程 E2E、升級、rollback 與備份恢復。
- [ ] SBOM、NOTICE、checksums、secret scan 和操作文件，含真實 OS 睡眠／登出的排程已知限制。 [文件計畫](IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment)
- [ ] 提交 Phase 5 驗收和獨立 review。
