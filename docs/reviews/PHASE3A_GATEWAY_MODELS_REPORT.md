# Phase 3A 閘道模型清單

2026-11-22（Asia/Taipei）。基準為 `main` 的 `110df36`，交付分支為 `phase-3/gateway-models`。

## 已交付

- 工作台啟動和「重新整理清單」都對 OpenAI 相容端點發送 `GET /v1/models`。沿用閘道網址正規化、憑證遮蔽、回應大小限制及拒絕重新導向，要求在 8 秒內完成。最多保存 256 個通過檢查的唯一模型 ID 及查詢時間。空清單、格式錯誤及連線失敗都保留最近一次成功的清單，初次失敗時顯示內建清單。
- 設定的「模型」頁可勾選 1 至 8 個已發現或內建的模型，並選擇新會話的預設模型。每列可使用原有的連線檢查測試模型。設定只保存 ID，維持既有安裝的兩個內建選項與已保存的預設值，直到擁有者另存選擇。
- 更改已勾選的名單後，在設定頁重新啟動執行環境可套用，執行中有操作會顯示稍後重試。在當前名單中更改預設模型會立即生效。轉送服務、輸入框選單及知識庫品質檢查使用已套用的選擇。知識庫問答使用目前的預設模型，品質檢查保留原有的題集、證據及評分規則。
- 清單成功更新後，已消失且不屬於內建清單的 ID 會從保存的選擇移除。若預設模型消失，改用第一個保留的已選模型。若全部消失，改用第一個內建模型。原模型已從執行環境移除的會話與訊息保留，會話在下一則訊息送出時改用當時的預設模型，輸入框顯示切換提示。
- 模型 ID 在介面原樣顯示，所有新增介面文字都有繁體中文與英文版本。清單、錯誤回應、測試與樣張只使用合成資料進行驗證。

## 測試調整與理由

| 檔案 | 調整與理由 |
|---|---|
| `tests/contract/gateway-models.test.ts` | 驗證 OpenAI 清單格式、網址正規化、唯一 ID 上限、缺漏或錯誤內容、空清單、過大回應、非 200、實際 HTTP 重新導向與回應逾時。以合成憑證核對錯誤沒有任意上游內容、沒有寫入日誌，並驗證資料庫重開、舊預設值、最後成功清單、選擇驗證及移除後備援。會話回歸另驗證拒絕原模型、切換失敗保持原狀、重試成功、回合採用預設模型及同一訊息不會重送。 |
| `tests/contract/local-api.test.ts` | 在整份模型設定回應的既有精確比對中加入清單、選擇、發現時間及重啟狀態欄位。沿用原有的配對及核准預設值斷言，新增拒絕未知模型的勾選及單獨測試請求。 |
| `tests/e2e/web-browser.test.ts` | 既有合成閘道回覆 `/v1/models`，原有 Chromium 流程結束後執行模型驗收。既有定位與斷言均保留。 |
| `tests/e2e/gateway-models-browser.ts` | 以本機合成 HTTP 閘道驗證啟動查詢、手動查詢、失敗時保留快取、單個模型測試、儲存後重載、執行中拒絕重啟、閒置後套用，以及新會話與移除模型的既有會話。核對新名單的轉送、知識庫品質檢查名單、拒絕手動切回已移除模型、介面沒有閘道連線資訊，以及各主題與寬度沒有橫向溢出。 |
| `tests/e2e/gui-locales.ts` | 在語言檢查中辨識既有及新增測試用的固定合成模型 ID，因為介面現在顯示 ID 原文。所有 UI 字串仍受兩種語言的檢查。 |
| `tests/e2e/forbidden-shell-text.ts` | 既有禁用詞檢查原本禁止顯示三個合成模型 ID。只在模型標籤、選項、測試按鈕及備援提示接受該三個完整 ID，因為模型 ID 必須原樣顯示。既有斷言仍會攔截其他位置出現的這些 ID，以及所有其他禁用詞。 |
| `tests/e2e/custom-mcp-launcher.ts` | 合成啟動器的 HTTP fixture 支援 `/v1/models`，避免啟動查詢進入原本的聊天請求解析。既有 MCP 斷言均保留。 |

## 合成樣張

樣張使用 Chromium 的 1440 × 900 及 390 × 844 視窗。執行 `OEP_CAPTURE_GATEWAY_MODELS=1` 的瀏覽器驗收可重建這八張圖。

| 語言 | 寬・淺色 | 寬・深色 | 窄・淺色 | 窄・深色 |
|---|---|---|---|---|
| 繁體中文 | [PNG](../validation/gui/settings-model-light-wide.png) | [PNG](../validation/gui/settings-model-dark-wide.png) | [PNG](../validation/gui/settings-model-light-narrow.png) | [PNG](../validation/gui/settings-model-dark-narrow.png) |
| English | [PNG](../validation/gui/settings-model-light-wide-en.png) | [PNG](../validation/gui/settings-model-dark-wide-en.png) | [PNG](../validation/gui/settings-model-light-narrow-en.png) | [PNG](../validation/gui/settings-model-dark-narrow-en.png) |

## 驗收輸出

Windows 11 x64、Node 24.14.1、PowerShell 7.6.1。依序執行驗收，每個指令使用新建的暫存 `OEP_DATA_DIR`。Python 驗證只在測試程序使用既有的 `oep-verify-venv`。此工作樹已啟用 Phase 0 Git hooks。

| 指令 | 實際輸出摘要 |
|---|---|
| `npm run lint` | `Checked 204 source and configuration files.` |
| `npm run typecheck` | `tsc --noEmit`，exit 0 |
| `npm test` | 依序驗收為 61 通過、0 失敗。新增會話備援 contract 後重跑 lint、typecheck 與單元測試，結果為 62 通過、0 失敗 |
| `npm run build:release` | `OEP-0.0.0-windows-x64.zip`，SHA-256 `3779413026452348e97303c4b613669b26d9369f393ced7fea3eb2717caecc64`，敏感資料掃描通過 |
| `npm run test:e2e:browser` | 三輪均通過，耗時 62.81、62.41、63.48 秒。每輪 `supervisorExit: 0`、`childExit: 0`、`orphans: 0`，另驗證發現、選擇、重啟與會話備援 |
| `npm run test:e2e:knowledge` | 1 通過、0 失敗。依序驗證空知識庫、儲存庫匯入、可重現引用，以及 Chromium 與 OpenCode MCP 的問答 |
| `npm run test:ingest` | 16 通過、0 失敗 |
| `npm run test:telegram` | 5 通過、0 失敗 |
| `npm run test:e2e:mcp` | 重跑 exit 0。`Isolated MCP probes passed with verified Job cleanup.` 與 `Chromium MCP add, catalog test, apply, persistence, edit, disable, and remove verified.` |
| `npm run test:compliance` | 2 通過、0 失敗 |
| `npm run test:release:determinism` | 1 通過、0 失敗。兩次 ZIP 的 SHA-256 與發行建置相同，檔案清單完整 |
| `npm run scan` | `"hits":0` |

開發中第一次完整瀏覽器驗收因既有禁用字檢查拒絕顯示合成模型 ID 而失敗。調整指定模型欄位的檢查後，重新開始依序驗收。

MCP 首次執行在缺少執行檔的情境回傳「無法確認測試程序已結束」，預期為「找不到指定的執行檔」。使用新的暫存資料目錄重跑全套 MCP 驗收後通過，該斷言保留。既有 Chromium MCP 驗收會建立並清除一筆唯一命名的合成使用者範圍憑證。

## 待審核者驗收

- `npm run test:e2e:web`、`npm run test:e2e:excel`、`npm run test:install`、`npm run test:upgrade`、`npm run test:backup` 留給審核者在可取得執行或維護鎖的環境執行。驗收期間擁有者正在使用 OEP 0.1.0。
- 未執行選用的真實閘道查詢。模型清單、錯誤、轉送、會話備援及樣張均以合成閘道驗證。
