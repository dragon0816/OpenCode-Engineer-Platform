# OEP 交接

更新日期 2026-11-21（Asia/Taipei）。OpenCode Engineer Platform（OEP）是公開 repo 中規劃的單使用者 Windows 平台。OpenCode 負責 agent harness，OEP 負責本機 Web、附件、BI/Wiki、Telegram、知識詢問和工作帳本。AEP 是唯讀參考。請先讀 [v2 的「待 owner 決定」](IMPLEMENTATION_PLAN_V2.md#待-owner-決定)，再查 [架構決策](ARCHITECTURE_DECISIONS.md) 和 [任務清單](TASKS.md)。

## 目前狀態

| Stage | 進度 |
|---|---|
| 1　獨立審查 | 兩份報告完成。 [Codex](reviews/CODEX_STAGE1_REVIEW.md) · [Claude Code](reviews/CLAUDE_STAGE1_REVIEW.md) |
| 2　交叉審查 | Codex 完整閱讀 Claude 的兩份報告並回查原始碼。Claude 因 token 限制只讀 Codex §A、§G、§H，§B–§F 未讀。 [Codex 交叉審查](reviews/CODEX_CROSS_REVIEW.md) · [Claude 有限交叉審查](reviews/CLAUDE_CROSS_REVIEW.md) |
| 3　整合 | 完成 [審查對照](REVIEW_COMPARISON.md)、[ADR](ARCHITECTURE_DECISIONS.md)、[v2 計畫](IMPLEMENTATION_PLAN_V2.md)、[AEP 差距](AEP_FEATURE_GAP_ANALYSIS.md)、[任務](TASKS.md) 與 [決策紀錄](DECISIONS.md)。[v1](IMPLEMENTATION_PLAN.md) 保留作歷史。 |
| 4　owner 核准 | **待核准**。D01–D09 集中於 v2。Owner 曾表示討論完成後優先由 Codex 開發，v2 核准仍待這一輪回覆。 |
| 5　開發 | **未開始**。Stage 4 完成後才可開始 Phase 0 spike 和後續 phases。 |

## 來源與驗證狀態

- 已讀 AEP 固定快照 `c9961b2d0d66eef3892375213ce305883ebde960`。BI/Wiki in-process plugins、Inbox、`bi_overview`、staging/vault/FTS5 及 Telegram cursor 都有原始碼證據，AEP root 無通用 LICENSE。既有測試未重跑。 [AEP 快照](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960)
- 已讀 OpenCode `v2.3.2`（`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`）原始碼、release metadata 與固定 OpenAPI。Automation 存在但實驗性，BI 維持 OEP ledger。SSE 無重播，重連需對帳。XLSX 須轉換，OpenCode 應在 OEP 同源代理之後。 [OpenCode 發行](https://github.com/anomalyco/opencode/releases/tag/v2.3.2)
- **UNVERIFIED**　公司 Gateway／模型 tools 和模態、Telegram 真實收件／通知、Windows binary 與 lifecycle、AEP 真實遷移／benchmark、實際授權範圍、所有 OEP 應用程式驗收。本輪未連公司 Gateway 或 Telegram，未啟動服務。
- OEP 僅修改文件，保持未 commit。這輪無應用程式改動、分支、commit 或 push。AEP 未修改，且不得把公司程式、資料、設定、地址或 secrets 複製入公開 repo。

## 接手操作

1. 取得 owner 對 v2 的確認，記錄 D01–D09 的回覆與任何限制。預設可用「接受所有建議預設，確認 v2」。仍缺的業務輸入依該決策負責人處理。
2. 核准後才由 Codex 在 OEP 的個別 phase feature branch/worktree 啟動 Phase 0，依 v2 做 S1–S7 及合成基線。未達 gate 的驗收留具體證據與 blocker。
3. 每 phase 由 Codex 開發與跑測試，Claude Code 獨立審查。Claude 不可用時，由獨立 Codex review delegate 驗證，報告須明示 reviewer 身分及並非 Claude。失敗由開發者修復並重新驗證，phase gate 通過後才開下一 phase。
