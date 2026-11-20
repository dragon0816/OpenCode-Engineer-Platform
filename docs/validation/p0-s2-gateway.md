# S2　透過 OpenCode 的 LiteLLM 測試

2026-11-21。固定版 `@opencode/client` 向隔離的 OpenCode v2.3.2 Linux binary 送合成指令，使用 `@opencode/ai/providers/openai-compatible`。Node relay 僅轉送 allowlist 內的 `POST /v1/chat/completions`，直接呼叫限 v2 要求的 liveness 和模型清單診斷。OpenCode 只看到 loopback relay 與測試 placeholder。PowerShell 用程序或 Windows User scope 取指定環境變數，再以 stdin 傳入 relay 程序記憶體。無 port publish、管理端點、原始 payload 或私有值輸出。每輪串行，最多 60 個 completion，重複強制選工具在 relay 停住。

```powershell
pwsh -NoProfile -File scripts/phase0/run-container.ps1 -Mode contract
pwsh -NoProfile -File scripts/phase0/run-container.ps1 -Mode gateway
pwsh -NoProfile -File scripts/phase0/run-container.ps1 -Mode gateway-capabilities
```

## 實際 Gateway

| 項目 | 結果 |
|---|---|
| liveness／帶測試 key 模型清單 | PASS，兩者 HTTP 200 |
| 無憑證／錯誤憑證的模型清單 | FAIL，分別重現 500／400，不符預期的明確認證拒絕。Gateway 管理員仍需對帳根因 |
| `gpt-5.4-mini`、`claude-haiku-4-5-20251001` | PASS，兩者最小健康 probe HTTP 200，完成且回正確合成短碼 |
| `qwen-36-27b`、`gemma-4-31b` | FAIL，兩者明列於 models，OpenCode 實際呼叫回 HTTP 400 `Model not found`。排除於啟用清單 |
| `gpt-5.5`、`gpt-5.6`、`claude-sonnet-5`、`claude-opus-5` | PASS，只測每一 alias 的最小文字健康。未宣告工具、schema 與媒體能力 |
| 20 次連續工具回合 | PASS，第二輪交替兩 alias，各 10 次。20 次從 streamed deltas 重組參數，解析合法 JSON，核對唯一 ID、下一個請求的 tool-result IDs 及最終答案。10 次同一步含 2 個工具 calls |
| `tool_choice: none`、JSON Schema、失敗工具回報 | PASS，兩個 alias 均驗證 provider payload，工具未執行、結果經固定 JSON schema 欄位／值核對、失敗工具以可辨識結果回報 |
| forced `tool_choice`／`parallel_tool_calls: true` | PASS，兩者首個強制請求帶明確工具名與參數並實際執行 fixture。FAIL，固定 model `body` 會持續套用至下一步。probe 攔住第二次 forced admission，沒有完成自然終止的 forced turn |
| PNG、PDF | PASS，兩個 alias 均在 OpenCode session 從 fixture 讀出 `ORBIT-7349`／`PRINT-2746`。 [S3 fixture hash](p0-s3-attachments.md) |
| scoped key、allowlist、費率／預算、retention、egress 及 Gateway fallback | **UNVERIFIED**。現有 key 的種類（含是否為 master key）未知。未查管理端點，由 owner／管理員私下證實，無模型可用性結論可代替 scope 驗證 |

首輪記錄 19/20，最長連續 12。第 8 輪有 fixture 執行且 OpenCode 回 `succeeded`，但第一個 relay 請求沒有工具 delta，probe 當時依賴請求順序，原始資料按去敏政策未留存。後續用第一個含工具 delta 的請求定位，仍要求精確 call 數、參數、同組識別值、後續 tool result、`[DONE]`、最終答案與 fixture call 數。強制工具先前耗盡該輪 probe cap，另跑 `gateway-capabilities` 限每 alias 一次真正的 forced 請求完成能力分項測試。首輪與重測結果均保留。

```json
{"test":"S2-diagnostics","liveness":200,"modelsValid":200,"modelsNone":500,"modelsWrong":400}
{"test":"S2-tool-summary","maxStreak":20,"fragmented":20,"parallel":10}
{"test":"S2-forced-wire","alias":"gpt-5.4-mini","ok":true,"stoppedRepeatedForcedCall":true,"outcome":"deadline-or-error"}
{"test":"S2-capability","alias":"claude-haiku-4-5-20251001","capability":"pdf","ok":true,"outcome":"succeeded","status":200}
```

診斷 `test` 與 status 為本地對照欄位。未收集可供管理員直接查詢的 gateway request ID。管理員可以依私下提供的時間窗查 500 與 400，不將識別值、內容或私有位址寫進公開 repo。 [Claude 直接預備測試](../reviews/S2_GATEWAY_PRELIMINARY_CHECK.md)

## 合成故障通過 OpenCode

| 故障 | 實測 |
|---|---|
| 401／403 | 每項 1 次，session `failed`，fallback 0 |
| 429／503 | 各 3 次同 alias，probe 8 秒到期後停止，`deadline-or-error`，fallback 0 |
| 400 | 合成長輸入拒絕狀態，1 次 `failed`，fallback 0 |
| 逾時 | 300 ms probe deadline，已確認送到慢速 synthetic endpoint，`deadline-or-error` |

真 Gateway 的長輸入、限流、5xx、timeout 尚未驗證。測試未刻意觸發 Gateway 限流、服務異常或耗用大輸入。OpenCode 重試與 OEP 上層硬 deadline 應分開監測。provider 使用政策與 relay allowlist 拒絕其他 provider，200 但 outcome 為 failed 不算成功。Gateway trace／管理員紀錄仍需確認服務端是否 fallback。

## 啟動 alias 健康檢查設計

1. 從核准的本機設定取 alias、必備能力、固定版及 deadline，用受限 key。比對版本和 key 設定輪替，讓舊健康資訊失效。模型清單僅可用於顯示與診斷。
2. 每個核准 alias 透過相同 OpenCode provider 送一次最短合成 nonce，逐一檢查 model ID、最終狀態、回傳值與延遲。所需工具、schema 與附件能力保留獨立的通過證據及驗證日期。變更 provider、alias 或 pin 時重新驗證相關能力。
3. 分類 `model unavailable`、`credential rejected`、`rate limited`、`upstream error`、`timeout` 與 `protocol mismatch`。400 從端點及安全分類判別，無憑證 500 保留為異常，未知錯誤不得自動當作成功。
4. 必備 alias 未通過時阻止相應工作，顯示具體原因與下一次重檢時點。明確 allowlist 內的重試做有界 backoff，避免每個 UI reload 重燒配額。預設無 fallback。只保存公開 alias 或去敏指標、狀態、時間、耗時、經核准的 correlation 值。
