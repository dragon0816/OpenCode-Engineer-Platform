# Phase 2b Slice 2C 驗收

## 已驗收

- **VERIFIED** Chromium 從 Ctrl+, 進入設定，以 Tab 與空白鍵 切換分類，驗證取消離開及確認捨棄變更。助理的名稱、自介、指示重載後保持原值。新版頁面說明新會話如何套用指示。
- **VERIFIED** 深色主題與緊湊密度跨重載。合成 PNG 在側欄與助理訊息呈現，能重設，SVG、錯誤檔頭、超過容量及超過尺寸的圖片皆拒絕。
- **VERIFIED** 以合成推論驗證啟動時每個 alias 一次檢查、重新檢查及 30 秒節流、預設與會話模型跨重載、工作階段切換及未知 alias 的 API 拒絕。設定 API 與 DOM 檢查未出現合成憑證、URL 或主機標記。
- **VERIFIED** 回合設定跨重載。工具呼叫上限在工具交給 OpenCode 前攔阻，慢速合成推論達回合時限後中止。兩種狀態各有繁中文案。契約測試驗證歷史保留完整回合及當回合工具結果。
- **VERIFIED** 執行環境顯示 OpenCode v2.3.2、短雜湊、目前會話助理、知識庫及 Telegram 是否已設定。執行設定只允許主要助理，多助理委派顯示停用及原因。
- **VERIFIED** 整合說明涵蓋公司入口與橋接、SSH 決策、外部閘道管理、共用資料庫及資產庫。頁面使用靜態說明。

[Chromium 驗收](../../tests/e2e/web-browser.test.ts) · [歷史與工具次數契約](../../tests/contract/web-turn-limits.test.ts)

## 回合限制

| 欄位 | 預設 | 範圍 |
|---|---:|---:|
| 納入的最近歷史訊息 | 40 | 0–100 |
| 歷史位元組 | 262144 | 0–1048576 |
| 工具呼叫 | 24 | 0–100 |
| 回合秒數 | 105 | 5–180 |

歷史預算計算送往模型的 UTF-8 JSON 訊息，省略較舊的完整回合。保留系統指示、目前訊息與本回合工具結果。閘道本身仍有單次請求時限。

## 截圖

逐張檢查淺色、深色與寬窄版。調整窄版內容內距、將模型操作分組並允許換行，加大數字欄位及分類間距、提高表單邊框對比，並使畫面擷取時的焦點跟隨目前分類。

| 分類 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
|---|---|---|---|---|
| 助理 | [PNG](../validation/gui/settings-assistant-light-wide.png) | [PNG](../validation/gui/settings-assistant-dark-wide.png) | [PNG](../validation/gui/settings-assistant-light-narrow.png) | [PNG](../validation/gui/settings-assistant-dark-narrow.png) |
| 外觀 | [PNG](../validation/gui/settings-appearance-light-wide.png) | [PNG](../validation/gui/settings-appearance-dark-wide.png) | [PNG](../validation/gui/settings-appearance-light-narrow.png) | [PNG](../validation/gui/settings-appearance-dark-narrow.png) |
| 模型 | [PNG](../validation/gui/settings-model-light-wide.png) | [PNG](../validation/gui/settings-model-dark-wide.png) | [PNG](../validation/gui/settings-model-light-narrow.png) | [PNG](../validation/gui/settings-model-dark-narrow.png) |
| 回合限制 | [PNG](../validation/gui/settings-limits-light-wide.png) | [PNG](../validation/gui/settings-limits-dark-wide.png) | [PNG](../validation/gui/settings-limits-light-narrow.png) | [PNG](../validation/gui/settings-limits-dark-narrow.png) |
| 執行環境 | [PNG](../validation/gui/settings-runtime-light-wide.png) | [PNG](../validation/gui/settings-runtime-dark-wide.png) | [PNG](../validation/gui/settings-runtime-light-narrow.png) | [PNG](../validation/gui/settings-runtime-dark-narrow.png) |
| 整合說明 | [PNG](../validation/gui/settings-integrations-light-wide.png) | [PNG](../validation/gui/settings-integrations-dark-wide.png) | [PNG](../validation/gui/settings-integrations-light-narrow.png) | [PNG](../validation/gui/settings-integrations-dark-narrow.png) |

設定面板色票以 WCAG 相對亮度公式計算。對面板背景，正文與次要文字最低為 5.91:1，表單邊框最低為 4.53:1，焦點框最低為 7.97:1。

## 迴歸

- **VERIFIED** lint、typecheck、test 53/53、scan 零命中、Web HTTP 3/3、Chromium、Excel 合成 5/5、Knowledge E2E 1/1、ingest 16/16、knowledge 11/11（Recall@5 24/24）、Telegram 5/5。
- **VERIFIED** 保留第二專案的會話、事件、附件與產物路由隔離測試。

## 開放項目

- **UNVERIFIED** 完整 WCAG AA 稽核及真實外部閘道的模型狀態。
- **未交付** 網頁麥克風／轉錄、專案工作根與唯讀資料夾設定、關於。Telegram 語音依本輪範圍排除。
- **未交付** 設定矩陣中的通用 MCP 管理、郵件設定、能力開關、BI 查詢工具與 Atlas 外部連結控制。
