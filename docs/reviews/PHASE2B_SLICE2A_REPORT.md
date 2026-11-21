# Phase 2b Slice 2A 驗收

## 已驗收

- **VERIFIED** Chromium 驗證側欄搜尋與清除、長標題省略、相對時間、鍵盤開啟列選單、循環焦點、Escape 還原焦點。既有改名、刪除、窄版抽屜、兩個工作區與附件隔離案例均保留。
- **VERIFIED** 訊息以 DOM 文字節點和 Markdown 區塊呈現。合成回覆中的 script、img onerror 和 javascript 連結保持惰性。Chromium 驗證列表、表格和程式碼，並驗證工具卡展收、假憑證與外部路徑遮蔽，以及頁面重載後的工具卡對帳。
- **VERIFIED** 停止慢速合成 Excel 回合後，上游回報 interrupted，台帳保持 cancelled，輸入框恢復送出，重複停止得到相同狀態，產物下載回 404。Phase 1 工作簿完成、驗證與錯誤處理皆保留取消狀態。
- **VERIFIED** lint 檢查 138 檔、typecheck 通過、test 50/50、scan 零命中、Web HTTP 三個附件案例、Chromium 三個附件案例及上述延伸驗收、合成 Excel 5/5、Knowledge E2E 1/1、ingest 16/16、knowledge 11/11、Telegram 5/5。知識基線 Recall@5 24/24。

[Chromium 驗收](../../tests/e2e/web-browser.test.ts) · [Phase 1 帳本測試](../../tests/contract/workspace.test.ts)

## 截圖

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
|---|---|---|---|---|
| 側欄 | [PNG](../validation/gui/workbench-light-wide.png) | [PNG](../validation/gui/workbench-dark-wide.png) | [PNG](../validation/gui/workbench-light-narrow.png) | [PNG](../validation/gui/workbench-dark-narrow.png) |
| 對話，工具卡收合 | [PNG](../validation/gui/conversation-light-wide.png) | [PNG](../validation/gui/conversation-dark-wide.png) | [PNG](../validation/gui/conversation-light-narrow.png) | [PNG](../validation/gui/conversation-dark-narrow.png) |
| 工具卡展開 | [PNG](../validation/gui/tools-expanded-light-wide.png) | [PNG](../validation/gui/tools-expanded-dark-wide.png) | [PNG](../validation/gui/tools-expanded-light-narrow.png) | [PNG](../validation/gui/tools-expanded-dark-narrow.png) |
| 執行中 | [PNG](../validation/gui/running-light-wide.png) | [PNG](../validation/gui/running-dark-wide.png) | [PNG](../validation/gui/running-light-narrow.png) | [PNG](../validation/gui/running-dark-narrow.png) |

視覺檢查後縮小主工作區加號的固定寬度以避免標題折行，修正桌面設定入口超出側欄邊框，縮小窄版訊息區和輸入區間距，調整搜尋提示與深色示範狀態對比。

## 開放項目

- **UNVERIFIED** 真正逐 token 串流。瀏覽器會收到 OpenCode 文字更新訊號並重新對帳。既有 Gateway relay 先緩衝整個回應，以遮蔽分跨多個 frame 的敏感內容並驗證完成框架，所以瀏覽器目前無法驗收模型仍在生成時逐 token 呈現。
- **UNVERIFIED** 強制切斷已建立的 SSE 後逐事件補齊。瀏覽器重載與網路切換驗證了工具卡投影無重複。活動摘要僅保留程序存活期間收到的事件，程式重啟或上游事件遺失後仍缺完整重播。
- **UNVERIFIED** 停止時有執行中的工具卡、所有非目前會話的狀態點、完整 WCAG AA 稽核。合成停止案例在模型請求期間觸發。
