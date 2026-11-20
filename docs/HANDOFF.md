# OEP 交接

更新日期 2026-11-21（Asia/Taipei）。OpenCode Engineer Platform（OEP）是公開 repo 中規劃的單使用者 Windows 平台。OpenCode 負責 agent harness，OEP 負責本機 Web、附件、BI/Wiki、Telegram、知識詢問和工作帳本。AEP 是唯讀參考。從 [Phase 0 gate](reviews/PHASE0_GATE_REPORT.md)、[v2 修訂](IMPLEMENTATION_PLAN_V2.md#2026-11-21phase-0-實測修訂) 和 [任務清單](TASKS.md) 接手。

## 目前狀態

| Stage | 進度 |
|---|---|
| 1　獨立審查 | 兩份報告完成。 [Codex](reviews/CODEX_STAGE1_REVIEW.md) · [Claude Code](reviews/CLAUDE_STAGE1_REVIEW.md) |
| 2　交叉審查 | Codex 完整閱讀 Claude 的兩份報告並回查原始碼。Claude 因 token 限制只讀 Codex §A、§G、§H，§B–§F 未讀。 [Codex 交叉審查](reviews/CODEX_CROSS_REVIEW.md) · [Claude 有限交叉審查](reviews/CLAUDE_CROSS_REVIEW.md) |
| 3　整合 | 完成 [審查對照](REVIEW_COMPARISON.md)、[ADR](ARCHITECTURE_DECISIONS.md)、[v2 計畫](IMPLEMENTATION_PLAN_V2.md)、[AEP 差距](AEP_FEATURE_GAP_ANALYSIS.md)、[任務](TASKS.md) 與 [決策紀錄](DECISIONS.md)。[v1](IMPLEMENTATION_PLAN.md) 保留作歷史。 |
| 4　owner 核准 | **已核准**。2026-11-21 owner 回覆「接受所有建議預設並開工」，接受 v2 和 D01–D09。 [決策紀錄](DECISIONS.md) |
| 5　開發 | `phase-0/spikes` 已完成第 2 輪 Phase 0 修正與開發者重測。Owner 修訂 gate 後，O-3a 通過，仍待獨立複核，本機尚未合併，Phase 1 未開始。 |

## 來源與驗證狀態

- 已讀 AEP 固定快照 `c9961b2d0d66eef3892375213ce305883ebde960`。BI/Wiki in-process plugins、Inbox、`bi_overview`、staging/vault/FTS5 及 Telegram cursor 都有原始碼證據，AEP root 無通用 LICENSE。既有測試未重跑。 [AEP 快照](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960)
- 已讀 OpenCode `v2.3.2`（`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`）原始碼、release metadata 與固定 OpenAPI。Automation 存在但實驗性，BI 維持 OEP ledger。SSE 無重播，重連需對帳。XLSX 須轉換，OpenCode 應在 OEP 同源代理之後。 [OpenCode 發行](https://github.com/anomalyco/opencode/releases/tag/v2.3.2)
- 先前真 Gateway 紀錄保留。舊 20 回合 PASS 依獨立審查降為 **UNVERIFIED**。新斷言已在固定版 OpenCode 的無網路合成 relay 通過兩 alias 各 10 次及完整 forced turn。真 Gateway 模式因 HTTPS 前置條件拒絕目前設定，scope 及 500／400 根因待結。 [S2](validation/p0-s2-gateway.md)
- Windows pin、合成 Job tree 與 O-3a 本機 native OpenCode 已驗。O-3b 為 **WAIVED by owner – not tested**。D06 登入常駐、登出暫停、睡眠恢復、24 小時補跑、RPO/RTO 仍為 **UNVERIFIED**。SSE 三次斷線在容器收斂，upstream overflow 待驗。 [S4](validation/p0-s4-sse.md) · [S6](validation/p0-s6-windows.md)
- 48 題基線 Recall@5 為 24/24。Phase 0 只新增 probes、合成 fixtures 與 repo hygiene。本地分支有 commits，未 push、未開 PR。公司程式、秘密、位址、真實資料與 AEP benchmark 排除。 [知識基線](validation/p0-knowledge-baseline.md)

## 接手操作

1. 在 `phase-0/spikes` 用 `git diff bc61330..HEAD` 取得第 2 輪修正，交由獨立 reviewer 複核。 [獨立審查](reviews/PHASE0_INDEPENDENT_REVIEW.md) · [修正證據](reviews/PHASE0_GATE_REPORT.md)
2. 依修訂門檻核對修正及 O-3a，取得獨立複核。原 v2 要求 O-1 至 O-4 全結，修訂門檻達成時記錄 **conditionally passed**。合併前執行兩邊 commit tree 與工作樹掃描。 [Owner 核准修訂](IMPLEMENTATION_PLAN_V2.md#phase-0-owner-amendment) · [合併前掃描](validation/p0-s7-licensing.md)

<a id="phase-0-owner-checklist"></a>

## Phase 0　責任人提交清單

- [ ] **O-1，Gateway 管理員（TRACKED KNOWN RISK）**　私下提供短期、可撤銷、模型 allowlist 與限額的 scoped key 證據，說明核准 egress／retention，並提供可驗 TLS 的 HTTPS 測試入口。Gateway 僅用於合成 spike，repo 僅保留去敏摘要。
- [ ] **O-2，Gateway 管理員（TRACKED KNOWN RISK）**　說明無 key 得 500、錯 key 得 400 的原因、預期認證狀態及可公開的重測摘要。非 2xx 皆判失敗，憑證、私有主機名及原始請求留在授權渠道。
- [x] **O-3a，本機原生基本驗收**　Windows 11 x64 的固定版 OpenCode、Job Object、mock relay、認證及 SSE 已驗。 [S6](validation/p0-s6-windows.md)
- **O-3b，WAIVED by owner – not tested**　無 GPT dots、VM 或 Hyper-V 工作。Phase 4 保留啟動／恢復對帳及模擬時鐘跳躍、終止程序／重啟測試，涵蓋模擬條件。使用者文件須說明，owner 於實務驗證前，OEP 對跨真實 OS 睡眠／登出的排程正確性無保證。
- [x] **O-4，Owner 已核定**　最小煙霧 oracle 只驗管線接線，PDF 對照、13 格型別及值、雜湊測試已通過。需要更改核定值時先取得新的 owner 核准，較完整 oracle 為 Phase 1 可選後續。 [D08 核定與 SHA-256](validation/d08-oracle.md) · [填寫範本](validation/d08-oracle.template.md)
