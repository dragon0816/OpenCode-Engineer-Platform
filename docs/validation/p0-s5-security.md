# S5　本機認證、CORS 與 proxy

執行 `pwsh -NoProfile -File scripts/phase0/run-container.ps1 -Mode contract`。隔離容器內以 `/proc/net/tcp` 檢查實際 OpenCode listener，啟動參數為 `--hostname 127.0.0.1` 並每次生成獨立 OpenCode 密碼。Podman 未發布 port。

```json
{"test":"S5-loopback","bind":true,"noAuth":401,"authenticated":200,"upstreamLocalhostCors":true,"proxy":200,"badHost":403,"badOrigin":403,"missingCsrf":403,"noSession":401,"passwordVisible":false}
```

受保護的 `/api/session` 驗證了 401/200。上游允許另一個 `localhost` port 的 CORS。一次性 proxy 針對受保護的同源操作驗確切 Host、Origin、session cookie 和 CSRF token，對瀏覽器可見的 JSON／headers 檢查 upstream Authorization 與明文密碼，皆未出現。錯誤 Host 用明確送出 `Host` 的原生 Node HTTP client，因一般 `fetch` 會代填合法 host。

原生 Windows OpenCode 與 proxy 的 `Get-NetTCPConnection` 驗證為 **UNVERIFIED**。S6 在同一 Windows 主機用 `Get-NetTCPConnection` 查到獨立的 Job Object 合成 worker 僅在 `127.0.0.1`，這是 Windows listener 輔證。 [S6](p0-s6-windows.md)

## Phase 0 限定的 Gateway 出口

`contract` 使用 `--network none`。`gateway` 與 `gateway-capabilities` 為 Phase 0 一次性實測，使用 `--network bridge` 讓 relay 能連私有測試 Gateway。此 bridge 允許容器對外連線。Loopback、無 port publish、金鑰只交 relay 和 provider allowlist 限定了服務入口或應用行為，容器網路本身沒有出口 allowlist。

Phase 1 的 Windows runtime 需以網路隔離強制 OpenCode 與其子程序只走受控 relay，再由 relay 連核准的 Gateway。須在隔離 Windows VM 驗證正反例，驗收見 [v2 Phase 1 出口修訂](../IMPLEMENTATION_PLAN_V2.md#phase-1-egress-acceptance)。

## 第 3 輪　同一 TCP 連線驗證對端

建立 IPv4 loopback TCP 後先送一個不含憑證或 headers 的空行，讓延後接受的 Linux listener 完成 `accept`。之後核對已連線的 server／client 四元組。Linux 的 server-side established socket inode 須屬於 OpenCode 子程序，Windows 的反向 established tuple 須屬於 Job 內的 OpenCode PID。通過才在同一 socket 寫出 HTTP 與 Basic 認證；錯誤的 listener／peer 及 redirect 都會拒絕。以本機合成 responder 核對實際收到 HTTP 的 client port 正是驗過的 port，錯誤 peer 未收到 HTTP。兩套實機 probe 均重測通過。 [Gate 證據](../reviews/PHASE0_GATE_REPORT.md)
