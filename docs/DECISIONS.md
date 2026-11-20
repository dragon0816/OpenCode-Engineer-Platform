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
