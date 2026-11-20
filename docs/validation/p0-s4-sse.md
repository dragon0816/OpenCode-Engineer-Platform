# S4　SSE 中斷後讀取狀態

固定版 Linux 容器，以合成慢速回覆與兩個 OpenCode session 驗證。執行 `pwsh -NoProfile -File scripts/phase0/run-container.ps1 -Mode contract`。

`GET /api/event` 在 probe 內可同時見兩個 session。`server.connected` 表示串流已開始，`session.execution.started` 和 `session.execution.succeeded` 的 `data.sessionID` 用於所有權比對。事件含 location 及可用的 durable 序號，但重訂閱應先讀 durable 狀態。每次在 A 剛開始後關閉連線，離線期間觀察新增 assistant 完成，再重訂閱並讀 session outcome、訊息、inbox 及 permission。未投影 B，重連也只讀取。 [固定事件契約](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/protocol/src/groups/event.ts)

```json
{"test":"S4-disconnect","elapsed":[16,8,7],"captured":3,"foreignDropped":3,"foreignExposed":0,"durableUniqueSubmissions":3,"duplicateSubmissions":0}
```

三次斷線與 5 秒收斂在容器通過。三次各遺失離線期間的即時完成事件，讀取後均收斂為 `succeeded`。此次注入連線中止，實際 upstream buffer overflow 與原生 Windows 時序為 **UNVERIFIED**。Phase 2 仍需驗正式 OEP event 投影與工作帳本。
