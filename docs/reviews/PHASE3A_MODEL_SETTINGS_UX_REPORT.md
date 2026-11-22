# Phase 3A 模型設定體驗

2026-11-22（Asia/Taipei）。基準為 `main` 的 `db4ff99`，交付分支為 `phase-3/model-settings-ux`。

## 已交付

- 模型勾選或新會話的預設模型與已儲存設定不同時，頁首顯示「有尚未儲存的變更」。切換設定分類、返回對話或前往其他主功能時，沿用工作台的捨棄確認。取消會保留草稿，確認會還原已儲存設定。
- 「儲存並套用」是清單正下方的主要操作。清單可獨立捲動，操作列在較短的視窗底部維持可見。僅更改已啟用的預設模型時，原有 API 會在儲存時生效。
- 需要重啟時，儲存會接著呼叫既有重啟路由。收到忙碌回應後，每兩秒查詢既有模型狀態並在仍有待套用的選擇時重試。重啟路由會檢查進行中的對話與工作。離開模型設定會取消等待，返回後可使用「立即套用」。
- 重啟後沿用啟動器新開的配對分頁。新分頁連線並確認已啟用本次儲存的設定後，在輸入框旁與模型設定顯示「已套用」。分頁交接使用兩分鐘有效的瀏覽器標記，內容為前一連接埠與設定雜湊。
- 目前輸入框只有預設模型、已儲存選擇也只有一項時，顯示「到設定選擇更多模型」。既有 API 回傳有效的選擇，介面以此判斷是否顯示連結。所有新增文字均有繁體中文及英文版本。

## 瀏覽器驗收調整

`tests/e2e/gateway-models-browser.ts` 新增勾選與預設模型的未儲存提示、主要操作位置、離開分類和設定頁時的確認與捨棄、離開後停止重試、閒置自動套用、重啟後的確認及前往模型設定連結。

| 既有驗收 | 調整理由 |
|---|---|
| 儲存後看到「已儲存」 | 自動套用會更新儲存進度。執行中改驗延後套用文字及未儲存提示消失，並保留重新載入後的勾選、預設模型與待套用狀態驗證。 |
| 重新載入以「儲存」按鈕啟用作為就緒條件 | 沒有待儲存變更時，儲存按鈕停用。改用重新整理清單按鈕確認模型設定已載入，並保留舊頁面標記及連線檢查。 |
| 「請稍後重試」及閒置後第二次手動點擊重啟 | 先驗證儲存後的自動嘗試與重試，重新載入後再以「立即套用」驗證同一忙碌情境。釋放會話後，等待重啟狀態與啟動器回呼，覆蓋自動重試。 |

原有的發現及快取、單個模型檢查、套用前後的模型選單、知識庫評測名單、原模型移除後的會話行為、敏感資料檢查與版面寬度斷言均保留。

## 合成樣張

以 `OEP_CAPTURE_GATEWAY_MODELS=1` 執行 Chromium 驗收可重建八張原路徑樣張。樣張顯示未儲存草稿與可按下的「儲存並套用」，視窗為 1440 × 900 與 390 × 844。

| 語言 | 寬・淺色 | 寬・深色 | 窄・淺色 | 窄・深色 |
|---|---|---|---|---|
| 繁體中文 | [PNG](../validation/gui/settings-model-light-wide.png) | [PNG](../validation/gui/settings-model-dark-wide.png) | [PNG](../validation/gui/settings-model-light-narrow.png) | [PNG](../validation/gui/settings-model-dark-narrow.png) |
| English | [PNG](../validation/gui/settings-model-light-wide-en.png) | [PNG](../validation/gui/settings-model-dark-wide-en.png) | [PNG](../validation/gui/settings-model-light-narrow-en.png) | [PNG](../validation/gui/settings-model-dark-narrow-en.png) |

初次樣張顯示開啟下一份草稿後，上一輪的「已套用」仍出現在儲存按鈕旁。修正後開始編輯會清除這項訊息，新增瀏覽器斷言並重新擷取樣張。

## 驗收輸出

Windows 11 x64、Node 24.14.1、PowerShell 7.6.10。依序執行，每個指令使用各自新建的暫存 `OEP_DATA_DIR`。Python 驗證只在驗收程序使用既有的 `oep-verify-venv`。本工作樹啟用 Phase 0 Git hooks。

| 指令 | 實際輸出摘要 |
|---|---|
| `npm run lint` | `Checked 213 source and configuration files.` |
| `npm run typecheck` | `tsc --noEmit`，exit 0 |
| `npm test` | 68 通過、0 失敗，包含雙語字串及介面／轉接服務用語鍵值驗證。 |
| `npm run build:release` | `OEP-0.0.0-windows-x64.zip`，SHA-256 `cddd32ee52c5a1cc4ba0fb0080f5beae564862058eb7af97e3d965f453996bcf`，敏感資料掃描通過。 |
| `npm run test:e2e:browser` | 三輪均通過，耗時 67.36、67.89、67.96 秒。每輪 `supervisorExit: 0`、`childExit: 0`、`orphans: 0`，模型驗收涵蓋未儲存提示、離開確認、自動與延後套用、重新載入及對話提示。 |
| `npm run test:e2e:knowledge` | 1 通過、0 失敗。Chromium 顯示可重現的引用，OpenCode MCP 回傳已驗證及拒絕的結果。 |
| `npm run test:e2e:mcp` | exit 0。`Isolated MCP probes passed with verified Job cleanup.` 與 `Chromium MCP add, catalog test, apply, persistence, edit, disable, and remove verified.` |
| `npm run test:compliance` | 2 通過、0 失敗。 |
| `npm run test:release:determinism` | 1 通過、0 失敗。兩份 ZIP 的 SHA-256 均與發行建置相同。 |
| `npm run scan` | `{"mode":"tree","files":528,"hits":0,"rules":{}}` |

## 待審核者驗收

- `npm run test:e2e:web`、`npm run test:e2e:excel`、`npm run test:install`、`npm run test:upgrade`、`npm run test:backup`。
- 模型清單、套用與樣張使用合成閘道。擁有者的 OEP 持續執行。
