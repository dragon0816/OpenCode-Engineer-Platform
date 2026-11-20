# OEP 交接

更新日期 2026-11-21（Asia/Taipei）。OpenCode Engineer Platform（OEP）是公開 repo 中規劃的單使用者 Windows 平台。OpenCode 負責 agent harness，OEP 負責本機 Web、附件、BI/Wiki、Telegram、知識詢問和工作帳本。AEP 是唯讀參考。從 [Phase 0 gate](reviews/PHASE0_GATE_REPORT.md)、[v2 修訂](IMPLEMENTATION_PLAN_V2.md#2026-11-21phase-0-實測修訂) 和 [任務清單](TASKS.md) 接手。

## 目前狀態

| Stage | 進度 |
|---|---|
| 1　獨立審查 | 兩份報告完成。 [Codex](reviews/CODEX_STAGE1_REVIEW.md) · [Claude Code](reviews/CLAUDE_STAGE1_REVIEW.md) |
| 2　交叉審查 | Codex 完整閱讀 Claude 的兩份報告並回查原始碼。Claude 因 token 限制只讀 Codex §A、§G、§H，§B–§F 未讀。 [Codex 交叉審查](reviews/CODEX_CROSS_REVIEW.md) · [Claude 有限交叉審查](reviews/CLAUDE_CROSS_REVIEW.md) |
| 3　整合 | 完成 [審查對照](REVIEW_COMPARISON.md)、[ADR](ARCHITECTURE_DECISIONS.md)、[v2 計畫](IMPLEMENTATION_PLAN_V2.md)、[AEP 差距](AEP_FEATURE_GAP_ANALYSIS.md)、[任務](TASKS.md) 與 [決策紀錄](DECISIONS.md)。[v1](IMPLEMENTATION_PLAN.md) 保留作歷史。 |
| 4　owner 核准 | **已核准**。2026-11-21 owner 回覆「接受所有建議預設並開工」，接受 v2 和 D01–D09。 [決策紀錄](DECISIONS.md) |
| 5　開發 | `phase-0/spikes` 從 `60bbe88` 完成 S1–S7 probes 與基線。Claude Code 首輪限定範圍審查已記錄，I-1 至 I-3 修正已驗。Phase 0 gate **未通過**，Phase 1 未開始。 |

## 來源與驗證狀態

- 已讀 AEP 固定快照 `c9961b2d0d66eef3892375213ce305883ebde960`。BI/Wiki in-process plugins、Inbox、`bi_overview`、staging/vault/FTS5 及 Telegram cursor 都有原始碼證據，AEP root 無通用 LICENSE。既有測試未重跑。 [AEP 快照](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960)
- 已讀 OpenCode `v2.3.2`（`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`）原始碼、release metadata 與固定 OpenAPI。Automation 存在但實驗性，BI 維持 OEP ledger。SSE 無重播，重連需對帳。XLSX 須轉換，OpenCode 應在 OEP 同源代理之後。 [OpenCode 發行](https://github.com/anomalyco/opencode/releases/tag/v2.3.2)
- Gateway 經固定版 OpenCode Linux binary 達 20 次連續成功 tools。兩個 alias 的 PNG/PDF、schema 及首步 forced 的完整回合通過。現有 key scope 未知，無憑證模型清單 500、錯誤憑證 400，仍阻擋 S2。 [S2](validation/p0-s2-gateway.md)
- Windows pin、原生 Job Object 合成程序樹及附件路徑已驗。原生 OpenCode CLI/API/loopback 與睡眠、登出、恢復待私有 VM。SSE 三次斷線在容器收斂，upstream overflow 待驗。 [S1](validation/p0-s1-version.md) · [S4](validation/p0-s4-sse.md) · [S6](validation/p0-s6-windows.md)
- 48 題基線 Recall@5 為 24/24。Phase 0 只新增 probes、合成 fixtures 與 repo hygiene。本地分支有 commits，未 push、未開 PR。公司程式、秘密、位址、真實資料與 AEP benchmark 排除。 [知識基線](validation/p0-knowledge-baseline.md)

## 接手操作

1. 在 `phase-0/spikes` 讀首輪審查與修正證據。用 `git diff 11a18ee..HEAD` 取得 I-1 至 I-3 修正供獨立複核。 [Claude Code 首輪審查](reviews/PHASE0_CLAUDE_REVIEW.md) · [修正證據](reviews/PHASE0_GATE_REPORT.md)
2. O-1／O-2 由 owner／管理員私下證實受限 key 及策略、查明認證異常。O-3 由 owner 提供隔離 Windows 11 x64 VM，補原生 OpenCode、睡眠與登出案例。O-4 待 owner／domain reviewer 核定 D08 合成 SOP/PDF 與 cell oracle。
3. 完成獨立複核及剩餘 Phase 0 驗收後才開後續 phase。規劃的 Phase 1 Windows relay-only 出口驗收已寫入 v2。 [出口驗收](IMPLEMENTATION_PLAN_V2.md#phase-1-egress-acceptance)
