# OEP 決策紀錄

## 2026-11-21　Stage 3 架構整合

以下為已收斂的設計及既有約束。Stage 4 仍待 owner 核准 v2。 [ADR](ARCHITECTURE_DECISIONS.md) · [v2 計畫](IMPLEMENTATION_PLAN_V2.md)

- ADR-001、002　鎖 OpenCode v2.3.2 binary、client、OpenAPI SHA-256。OpenCode 擁有 harness，OEP 薄 adapter 只做接入與對帳。
- ADR-003、009　OEP BI 服務擁有 job/effect ledger，立即、定時、Run Now 同走 claim。OpenCode Automation 首版關閉。Telegram 採 durable inbox/cursor、at-least-once 與業務冪等。
- ADR-005、006、008、014　獨立同源 Web、loopback 加 upstream password、OEP 代理與 Host/Origin/CSRF 驗證。XLSX 受控轉換。SSE 用重連對帳，log 保存去敏關聯識別值。
- ADR-010、011　核准後的 revision 由一致發布指標及不可變內容保留，遷移先乾跑及 shadow，備份可驗。先用 FTS5 與繁中詞法。
- ADR-012、013　AEP 唯讀，公開 repo 不放公司程式、資料、設定、端點或 secrets。以獨立實作及合成 fixtures，管理分發授權，憑證存本機受保護空間。
- ADR-015、016　分層驗證並提前建知識基線。SOP→Excel 驗收 5/5、openpyxl 逐格與故障注入。

ADR-004、007、017 的入口範圍、語言及 Windows 策略待裁決。開工條件、授權、Gateway、驗收口徑與產品範圍統一放在 [待 owner 決定](IMPLEMENTATION_PLAN_V2.md#待-owner-決定)。Claude 只交叉讀 Codex §A、§G、§H。此紀錄只依讀碼、metadata 與文件，沒有應用程式執行結果。

## 2026-11-21　Stage 4 核准與 Phase 0 開工

Owner 回覆「接受所有建議預設並開工」。以 Asia/Taipei 日期記錄，確認 v2 及 D01–D09 全部建議預設。此輪從 `60bbe88` 啟動 `phase-0/spikes`，執行至 Phase 0 gate 即停。

- D01　OEP 自有程式採 MIT。AEP 唯讀且僅參考，使用獨立編寫的程式與合成資料。
- D02　採可撤銷、限模型、限預算的測試 gateway key。Owner 授權使用現有測試 gateway 進行低流量、合成 S2；實際 key scope、retention 與模型 egress 仍須確認。現有憑證依 owner 指定優先取程序環境，缺少時讀取 Windows User scope，僅保存在記憶體。禁止管理端點。
- D03　明確 Ask 入口先檢索並強制共用 verifier。
- D04　TypeScript／Node.js 24 LTS 為主，Python 限必要的文件轉換和 openpyxl 驗證。
- D05　先匯入已發布快照與 provenance。
- D06　Windows 11 x64 使用者登入後常駐，24 小時補跑，RPO ≤24 小時、RTO ≤30 分鐘。
- D07　雙 Telegram bot、私聊 allowlist，限核准的公開連結。
- D08　合成 SOP 和逐格 oracle 需 owner 或指定 reviewer 核定。此回覆核定流程，個別內容待審。
- D09　固定 OpenCode v2.3.2 binary、client、OpenAPI hash，採獨立 OEP Web，通用 Automation 預設關閉。

Phase 0 僅提交 probes、報告、合成 fixtures 與 repo hygiene。所謂一次性 probe 指實際執行狀態與下載檔存於 worktree 內隔離且忽略的 `.phase0/`，可重現腳本納入版本控制。下載與靜態檢查可先完成，任何 OpenCode 執行須在隔離環境內進行，與工作目錄或停用 tools 分開驗證。
