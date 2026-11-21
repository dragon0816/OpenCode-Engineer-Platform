# Phase 1 Runtime 實測與重現

2026-11-21（Asia/Taipei）。於實體 Windows 11 Pro x64 build 26200，使用 Node 24.14.1、PowerShell 7.6.10、Python 3.12.7 及 openpyxl 3.1.5。二進位檔、client 與 OpenAPI 全部固定於 OpenCode v2.3.2，下載與 build 輸出放在忽略的 `.phase0/`。 [釘選值](../../config/opencode.pin.json)

## 準備與執行

在 Phase 1 worktree 根目錄執行。可用 `OEP_PYTHON` 指定 Python 執行檔。預設執行資料在 `%LOCALAPPDATA%\OEP\phase1-*`，亦可用 `OEP_DATA_DIR` 指定絕對資料目錄。

```powershell
npm ci
pwsh -NoProfile -File scripts/phase0/fetch-pins.ps1
node scripts/phase0/install-hooks.mjs
python -m pip install --only-binary=:all: --require-hashes --target .phase0/python -r tests/oracles/requirements.txt
$env:PYTHONPATH = (Resolve-Path .phase0/python).Path
npm run lint
npm run typecheck
npm test
npm run build
npm run test:contract
npm run test:contract:native
npm run test:e2e:excel:faults
npm run test:e2e:excel:synthetic
npm run test:e2e:excel
```

`npm run runtime` 啟動背景 OpenCode，保持 launcher 程序執行，以 Ctrl+C 停止。真實模式使用 Windows User 或程序範圍的 `OEP_LITELLM_BASE_URL` 和 `OEP_LITELLM_API_KEY`。預設模型為 `gpt-5.4-mini`。可用 `OEP_MODEL_ALIAS` 選另一個核准 alias，再由同一 OpenCode provider 驗合成 nonce。驗收使用合成 SOP，不呼叫管理端點。

## 產物判定與紀錄

- 每次 run 使用新 workspace。Markdown 由 OpenCode 讀取，PDF 以固定 fixture bytes 附加。模型透過 OpenCode 的工具寫 `program.js`，OEP 工作程序執行並嘗試建立 `output.xlsx`。
- SQLite `runs.sqlite` 保存當前狀態與事件歷史。逐次記錄輸出至 `attempts.jsonl`，內容含 run／session／submission ID、程式及產物路徑與雜湊、退出狀態、stdout／stderr、OEP 重送次數及錯誤。可取得的失敗產物也保留摘要。Gateway 另在 `gateway.jsonl` 記每個請求的狀態及耗時。
- `verified` 需要對應 run 與程式雜湊的完成收據、exit 0、新檔案和產物 SHA-256，並以 openpyxl 核對完整工作表與 13 格型別及值。等待程式完成時為 `background`。送件或執行狀態不明時記 `indeterminate`，驗收期限內缺有效收據即失敗。
- 全部合成跑次、故障注入、真 Gateway 啟動嘗試、實際結果與原始資料位置見 gate。 [Phase 1 gate](../reviews/PHASE1_GATE_REPORT.md)
