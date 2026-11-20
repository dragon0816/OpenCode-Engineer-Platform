# S2 預備檢查：公司 LiteLLM Gateway tool-calling（2026-11-21）

> 這是 Phase 0 S2 spike 的 **預備**煙霧測試，由 Claude Code 在 owner 明確要求下執行；**不是** S2 的驗收。
> Gateway 位址與金鑰不在 repo：分別由使用者環境變數 `OEP_LITELLM_BASE_URL`、`OEP_LITELLM_API_KEY` 提供。
> 只送合成提示（天氣查詢範例），未送任何公司資料。金鑰未印出、未寫檔。

## 結果
| 項目 | 結果 |
|---|---|
| `GET /v1/models`（帶 token） | 成功，回 11 個 model alias |
| `GET /v1/models`（無 token） | 先前 HTTP 500；（錯誤 token）HTTP 400。**非標準 401**，OEP 的錯誤處理不可假設 401 |
| `gpt-5.4-mini`：一般回覆 | 通過 |
| `gpt-5.4-mini`：tool call（要求並行呼叫兩城市） | 2 個 tool_calls、id 皆有、arguments 皆為合法 JSON、`finish_reason=tool_calls` |
| `gpt-5.4-mini`：tool result 往返（`tool_call_id`） | 通過，最終回答使用了 tool 結果 |
| `gpt-5.4-mini`：**串流** tool call | 通過：分片組回 2 個 call、id 與合法 JSON 皆正確、收到 `[DONE]` |
| `claude-haiku-4-5-20251001`：一般 / tool call / 往返 | 皆通過（模型多呼叫 1 次，共 3 個，皆有 id 與合法 JSON） |
| `claude-haiku-4-5-20251001`：**串流** tool call | 通過：2 個 call、id 與合法 JSON 正確、`[DONE]` |
| `qwen-36-27b`、`gemma-4-31b` | **全部 HTTP 400**：`Hosted_vllmException - Model not found`。Gateway 列出 alias，但後端未提供 → **「列在 /v1/models」不代表可用**，OEP 需要啟動時的 alias 健康檢查 |

## 尚未測（仍需 S2 正式執行）
`tool_choice`（forced / none）、結構化輸出（json_schema）、圖片與 PDF modality、`gpt-5.5/5.6`、`claude-sonnet-5/opus-5`、
錯誤碼矩陣（超長輸入、逾時、速率限制）、fallback 行為、連續 ≥20 次穩定性、OpenCode 經 openai-compatible provider 實際走通（本檢查是直接打 Gateway，**不是**透過 OpenCode）、
key 的 scope（預算 / model allowlist / 是否為 master key）、資料留存與外送政策。

## 對計畫的影響
1. 支持 ADR 方向：LiteLLM 後的 OpenAI 相容路徑對 tool-calling（含串流與往返）基本可行，R2 風險下降但未關閉。
2. 新增驗收：模型 alias 的 **啟動健康檢查**（對每個核准 alias 做一次最小呼叫），不能只信 `/v1/models`。
3. 新增驗收：Gateway 錯誤（400/500 非標準）須被 OEP 正確分類與回報，不得吞掉或誤判為成功。
