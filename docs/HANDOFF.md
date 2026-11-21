# OEP 交接

更新日期 2026-11-21（Asia/Taipei）。OpenCode Engineer Platform（OEP）是公開 repo 中規劃的單使用者 Windows 平台。OpenCode 負責 agent harness，OEP 負責本機 Web、附件、BI/Wiki、Telegram、知識詢問和工作帳本。AEP 是唯讀參考。從 [Phase 0 gate](reviews/PHASE0_GATE_REPORT.md)、[v2 修訂](IMPLEMENTATION_PLAN_V2.md#2026-11-21phase-0-實測修訂) 和 [任務清單](TASKS.md) 接手。

## 目前狀態

| Stage | 進度 |
|---|---|
| 1　獨立審查 | 兩份報告完成。 [Codex](reviews/CODEX_STAGE1_REVIEW.md) · [Claude Code](reviews/CLAUDE_STAGE1_REVIEW.md) |
| 2　交叉審查 | Codex 完整閱讀 Claude 的兩份報告並回查原始碼。Claude 因 token 限制只讀 Codex §A、§G、§H，§B–§F 未讀。 [Codex 交叉審查](reviews/CODEX_CROSS_REVIEW.md) · [Claude 有限交叉審查](reviews/CLAUDE_CROSS_REVIEW.md) |
| 3　整合 | 完成 [審查對照](REVIEW_COMPARISON.md)、[ADR](ARCHITECTURE_DECISIONS.md)、[v2 計畫](IMPLEMENTATION_PLAN_V2.md)、[AEP 差距](AEP_FEATURE_GAP_ANALYSIS.md)、[任務](TASKS.md) 與 [決策紀錄](DECISIONS.md)。[v1](IMPLEMENTATION_PLAN.md) 保留作歷史。 |
| 4　owner 核准 | **已核准**。2026-11-21 owner 回覆「接受所有建議預設並開工」，接受 v2 和 D01–D09。 [決策紀錄](DECISIONS.md) |
| 5　開發 | Phase 0 由 owner 豁免結案。Phase 1 已合併至 `main`（`e616e6a`）並推送。GPT 與 Haiku 各有一輪連續 5 筆通過 D08。Owner 已授權 `phase-2/web-gui` 開工。 [決策紀錄](DECISIONS.md) · [真模型重測](reviews/PHASE1_GATE_REPORT.md#gateway-恢復後的真模型重測) |

## 來源與驗證狀態

- 已讀 AEP 固定快照 `c9961b2d0d66eef3892375213ce305883ebde960`。BI/Wiki in-process plugins、Inbox、`bi_overview`、staging/vault/FTS5 及 Telegram cursor 都有原始碼證據，AEP root 無通用 LICENSE。既有測試未重跑。 [AEP 快照](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960)
- 已讀 OpenCode `v2.3.2`（`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`）原始碼、release metadata 與固定 OpenAPI。Automation 存在但實驗性，BI 維持 OEP ledger。SSE 無重播，重連需對帳。XLSX 須轉換，OpenCode 應在 OEP 同源代理之後。 [OpenCode 發行](https://github.com/anomalyco/opencode/releases/tag/v2.3.2)
- 先前真 Gateway 紀錄保留。舊 20 回合 PASS 依獨立審查降為 **UNVERIFIED**。第 4 輪無網路合成 relay 重測兩個 alias 各 10 次及各一次完整 forced turn，以 call ID 核對每個 slot 的完整結果形狀與文字。真 Gateway 模式先前因 HTTPS 前置條件拒絕設定，scope 及 500／400 根因仍由 Gateway 管理員追蹤。 [S2](validation/p0-s2-gateway.md)
- Windows pin、合成 Job tree 與 O-3a 本機 native OpenCode 已驗。O-3b 為 **WAIVED by owner – not tested**。D06 登入常駐、登出暫停、睡眠恢復、24 小時補跑、RPO/RTO 仍為 **UNVERIFIED**。SSE 三次斷線在容器收斂，upstream overflow 待驗。 [S4](validation/p0-s4-sse.md) · [S6](validation/p0-s6-windows.md)
- 48 題基線 Recall@5 為 24/24。Phase 0 只新增 probes、合成 fixtures 與 repo hygiene。本地分支有 commits，未 push、未開 PR。公司程式、秘密、位址、真實資料與 AEP benchmark 排除。 [知識基線](validation/p0-knowledge-baseline.md)

## 接手操作

1. Phase 0 五項證據降為 **UNVERIFIED**：S4 跨客戶端／路徑重複送件計數與緩衝事件後切斷的重連、S2 工具失敗回合的內容／call ID／形狀、S4／S2 teardown 的跳過清理／502 後 exit 0／遺失原始原因、S6 worker `null` 退出碼。三項 Minor 為兩把 Git 設定鎖的文件、`CloseHandle` 回傳值、無模式 scanner 靜默 exit 0。只在 Phase 1 產品測試直接涵蓋時補證據。 [前置清單](TASKS.md) · [豁免紀錄](DECISIONS.md)
2. Phase 1 worktree 已安裝既有 hooks，每次提交前已執行 `npm run scan`。原生 Windows OpenCode、兩 session 隔離、合成 Markdown／PDF→XLSX 連續 5/5 與 9 類故障已驗。 [重現步驟](validation/p1-runtime.md)
3. 真模型普通跑次共 23 筆，19 筆通過。保留 GPT 的 4 筆逾時相關失敗，兩個 alias 都有通過的 PDF 工具回合。Haiku 的真模式故障驗收共 8 筆，控制組通過、7 個負例全判失敗。原始資料路徑、完整雜湊和每次延遲／token 位置見報告。目標 VM 出口與完整真錯誤契約仍待驗。 [Gate 報告與原始紀錄](reviews/PHASE1_GATE_REPORT.md#gateway-恢復後的真模型重測)
4. Phase 2 在 `phase-2/web-gui` 完成同源 Web、launcher、附件、事件、下載與 BI 待審示範。操作入口是 `scripts/windows/Start-OEP.vbs`。真 Gateway 15 筆中 14 筆通過，最終 Chromium 重測 3/3。將差異與未驗項目交 Claude Code 一次輕量複核，Phase 2 gate 保留 **UNVERIFIED**。 [操作](validation/p2-windows-web.md) · [Gate 報告](reviews/PHASE2_GATE_REPORT.md)

<a id="phase-0-owner-checklist"></a>

## Phase 0　責任人提交清單

- [ ] **O-1，Gateway 管理員（TRACKED KNOWN RISK）**　私下提供短期、可撤銷、模型 allowlist 與限額的 scoped key 證據，說明核准 egress／retention，後續提供 HTTPS 入口。Owner 已授權 Phase 1 合成資料實測，repo 僅保留去敏摘要。
- [ ] **O-2，Gateway 管理員（TRACKED KNOWN RISK）**　說明無 key 得 500、錯 key 得 400 的原因、預期認證狀態及可公開的重測摘要。非 2xx 皆判失敗，憑證、私有主機名及原始請求留在授權渠道。
- [x] **O-3a，本機原生基本驗收**　Windows 11 x64 的固定版 OpenCode、Job Object、mock relay、認證及 SSE 已驗。 [S6](validation/p0-s6-windows.md)
- **O-3b，WAIVED by owner – not tested**　無 GPT dots、VM 或 Hyper-V 工作。Phase 4 保留啟動／恢復對帳及模擬時鐘跳躍、終止程序／重啟測試，涵蓋模擬條件。使用者文件須說明，owner 於實務驗證前，OEP 對跨真實 OS 睡眠／登出的排程正確性無保證。
- [x] **O-4，Owner 已核定**　最小煙霧 oracle 只驗管線接線，PDF 對照、13 格型別及值、雜湊測試已通過。需要更改核定值時先取得新的 owner 核准，較完整 oracle 為 Phase 1 可選後續。 [D08 核定與 SHA-256](validation/d08-oracle.md) · [填寫範本](validation/d08-oracle.template.md)

## 2026-11-21　Phase 2 owner 實測與 Phase 3a 開工

Owner 確認已推送的 Phase 2 可做基本對話，從 `main` 的 `a6aa863` 建立 `phase-3/knowledge-read`。先提交唯讀盤點、版面及計畫修訂，再做 Phase 3a 的唯讀快照、檢索與明確 Ask。Phase 2b 先提供規格，在後續階段逐步交付並於 Phase 5 打包前驗收。 [計畫修訂](IMPLEMENTATION_PLAN_V2.md#phase-2b-gui-parity) · [功能矩陣](AEP_GUI_PARITY.md) · [版面](GUI_LAYOUT.md)

## 2026-11-21　Phase 3a 交接

實作與測試已在本機分支 `phase-3/knowledge-read` 提交。Windows 啟動後從左側知識庫進入，匯入以 `npm run knowledge:migrate` 讀本機已發布快照。CLI 先做 shadow 驗證，發送證據給模型須依快照明確授權。一般 OpenCode 聊天可選用內建知識工具。 [操作](validation/p3a-knowledge.md)

合成 BI／Wiki、SQLite 備份回復、Chromium 與原生 MCP 均已驗。最終 48 題兩 alias 達 D03。第一輪 Haiku 的兩個無支持回答，以及後續封鎖與重測皆保留。整體 gate 為 **UNVERIFIED**，待 owner 提供權利核准的 AEP 快照本機路徑並在目標 VM 補測。真模型一般聊天是否自行選用工具仍待真實 smoke，明確 Ask 已跑真模型。 [Gate 報告](reviews/PHASE3A_GATE_REPORT.md)

工作止於 3a。3b 的 ingest／review／publish 待後續授權與階段先決條件。2b 的通用 GUI 項目仍依矩陣排入後續階段。 [任務清單](TASKS.md)

## 2026-11-21　Phase 3a 儲存庫資料夾交接

從本機 `main` 的 `7e50d76` 建立 `phase-3a/repo-reader`。BI 資料夾可在 Web 知識頁檢查或匯入，也可用 `knowledge:inspect` 及 `knowledge:migrate -- --import-repo`。Web 及 CLI 的模型使用預設關閉。匯入隨交易切換發布指標，`--restore-repo` 可回復保留的世代。Wiki 已發布 manifest 沿用原有入口。 [格式與操作](validation/p3a-repo-reader.md)

合成鏡像、Chromium、MCP 與兩個真 Gateway alias 達既有門檻。GPT 可答 23/24、Haiku 24/24，不可答皆拒答 24/24，公開引用皆可重現。Owner 的實際資料夾、原生 OneDrive 檔案隨選與目標 VM 仍為 **UNVERIFIED**。交接以 owner 本機去敏 inspect 為下一個驗證點。分支只留本機，工作止於 3a。 [本輪報告](reviews/PHASE3A_REPO_READER_REPORT.md)

## Phase 3b handoff

The local feature branch is based on caf60b9. Core ingest, review, publish, rollback and recovery tests use synthetic BI and Wiki inputs. Knowledge contains the BI and Wiki review panels. The gate report records GUI parity gaps and regression results. [Publish and recovery](validation/p3b-publish.md) · [Gate report](reviews/PHASE3B_GATE_REPORT.md)

## Phase 3a retrieval follow-up

Local branch `phase-3a/retrieval-quality` starts from `00735ef`. Gold mirror Recall@5 is 24/24, and bilingual synthetic forecast recall improved from 0/2 to 2/2. Both live aliases met D03 on the synthetic gold mirror. Chromium verified the Traditional Chinese Gateway rejection message and one upstream request for the synthetic rejected question. The real-repository follow-up and the upstream filter trigger remain **UNVERIFIED**. [Retrieval report](reviews/PHASE3A_RETRIEVAL_REPORT.md)

## 2026-11-21　Phase 3b review improvements

Local branch `phase-3b/usable-review` starts from `99e860b`. BI review now stages changes against the active revision. The source form uploads bounded UTF-8 content, and model proposals are explicit pending reviews. First rollback deactivates and preserves history. Ask and MCP share the read-only database connection. The Technical Lead owns merge via `npm run merge-check`. [Operations](validation/p3b-publish.md) · [Improvement report](reviews/PHASE3B_IMPROVEMENT_REPORT.md)

## Phase 4 handoff

Local branch `phase-4/telegram-jobs` starts from `38520a3`. The Windows launcher wires private Telegram bots and BI scheduling into the **工作與排程** view. Synthetic validation covers shared BI claims, Telegram replays, Main topic isolation, verified Ask, outbox retry and simulated startup/resume. Real bots, real OS sleep and logout, full GUI parity, and Technical Lead review remain **UNVERIFIED**. The Technical Lead owns merge via `npm run merge-check`. [Operations](validation/p4-telegram.md) · [Gate report](reviews/PHASE4_GATE_REPORT.md)
