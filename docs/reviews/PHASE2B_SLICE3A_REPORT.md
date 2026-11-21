# Phase 2b Slice 3A 驗收

合成驗收使用 Windows、Chromium 與固定版 OpenCode 2.3.2。基線為 `4abb212`。金標資料及畫面均使用合成資料。

| 項目 | 狀態 | 證據 |
| --- | --- | --- |
| 知識頁與建置 | VERIFIED | 四個分頁、已發布版本選單、空庫、鍵盤分頁切換、窄版，以及原有 BI／Wiki 審核與回退。 |
| 概覽 | VERIFIED | 1,500 張卡片分頁、排序、條件篩選、全文搜尋標示、欄位與出處、證據、雙向關係、SQLite 8／9 缺少選用資料與索引重建。 |
| 問答 | VERIFIED | Chromium 開啟引用原文、鍵盤關閉抽屜、顯示發布版本。保留 Gateway 拒絕、授權與原有 MCP 引用核對。 |
| 品質 | VERIFIED | Chromium 新增題集、選取段落、增改題目、透過合成 Gateway 執行、D03 通過、取消正在執行的題目。內建 48 題可瀏覽。 |
| 示範與設定 | VERIFIED | 合成示範載入及移除。Atlas 拒絕 HTTP，明確點擊且確認後向瀏覽器要求開啟。停用 BI 工具後，新會話的工具清單及實際模型請求均省略該工具。 |
| Owner 實際資料及真 Gateway | UNVERIFIED | 本輪驗收使用合成儲存庫及合成 Gateway。 |
| Atlas 外部服務 | UNVERIFIED | 使用合成網址與瀏覽器開啟攔截驗證確認行為。 |

[Chromium 驗收](../../tests/e2e/knowledge.test.ts) · [效能契約](../../tests/contract/knowledge-browser.test.ts) · [功能矩陣](../AEP_GUI_PARITY.md)

## 效能與迴歸

1,500 張卡片及 1,500 段證據，含冷啟查詢。每類量測使用最大值，門檻 200 ms。

| 測試層 | 列表 | 篩選 | FTS |
| --- | ---: | ---: | ---: |
| 本機 SQLite 與資料投影，20 次 | 12.38 ms | 0.25 ms | 51.52 ms |
| 配對 HTTP 加 JSON 解碼，12 次 | 34.52 ms | 0.81 ms | 57.22 ms |

- **VERIFIED** lint、typecheck、test 54/54、scan 零命中、Web HTTP 3/3、Chromium、Knowledge E2E 1/1、Excel 合成 5/5、ingest 16/16、knowledge 12/12、Telegram 5/5。
- **VERIFIED** 固定語料 baseline Recall@5 24/24、發布儲存庫金標 Recall@5 24/24，以及 3a 的繁中混合查詢、去重、證據上限與 Gateway 拒絕迴歸。

## 開放項目

- 功能矩陣保留進階 BI／Wiki 建置表單、多人同步、Atlas 嵌入、通用 MCP 管理。
- Benchmark 先交付手動撰寫與既有管線。AI 草擬與進階 SQL 作者功能維持後續範圍。
- 文件與 Chromium 覆蓋目前合成 SQLite 8／9 結構。Owner 實際資料及完整輔助技術稽核仍待驗證。

## 截圖

檢視四種寬度與主題組合後，固定截圖起始位置、改用合成顯示路徑、限制表格高度並保留可捲動區域。窄版保留控制項和抽屜的鍵盤操作。

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
| --- | --- | --- | --- | --- |
| 概覽 | [PNG](../validation/gui/slice3a-overview-light-wide.png) | [PNG](../validation/gui/slice3a-overview-dark-wide.png) | [PNG](../validation/gui/slice3a-overview-light-narrow.png) | [PNG](../validation/gui/slice3a-overview-dark-narrow.png) |
| 問答 | [PNG](../validation/gui/slice3a-ask-light-wide.png) | [PNG](../validation/gui/slice3a-ask-dark-wide.png) | [PNG](../validation/gui/slice3a-ask-light-narrow.png) | [PNG](../validation/gui/slice3a-ask-dark-narrow.png) |
| 品質 | [PNG](../validation/gui/slice3a-quality-light-wide.png) | [PNG](../validation/gui/slice3a-quality-dark-wide.png) | [PNG](../validation/gui/slice3a-quality-light-narrow.png) | [PNG](../validation/gui/slice3a-quality-dark-narrow.png) |
| 建置 | [PNG](../validation/gui/slice3a-build-light-wide.png) | [PNG](../validation/gui/slice3a-build-dark-wide.png) | [PNG](../validation/gui/slice3a-build-light-narrow.png) | [PNG](../validation/gui/slice3a-build-dark-narrow.png) |
| 卡片抽屜 | [PNG](../validation/gui/slice3a-drawer-light-wide.png) | [PNG](../validation/gui/slice3a-drawer-dark-wide.png) | [PNG](../validation/gui/slice3a-drawer-light-narrow.png) | [PNG](../validation/gui/slice3a-drawer-dark-narrow.png) |
