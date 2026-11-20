# S5　本機認證、CORS 與 proxy

執行 `pwsh -NoProfile -File scripts/phase0/run-container.ps1 -Mode contract`。隔離容器內以 `/proc/net/tcp` 檢查實際 OpenCode listener，啟動參數為 `--hostname 127.0.0.1` 並每次生成獨立 OpenCode 密碼。Podman 未發布 port。

```json
{"test":"S5-loopback","bind":true,"noAuth":401,"authenticated":200,"upstreamLocalhostCors":true,"proxy":200,"badHost":403,"badOrigin":403,"missingCsrf":403,"noSession":401,"passwordVisible":false}
```

受保護的 `/api/session` 驗證了 401/200。上游允許另一個 `localhost` port 的 CORS。一次性 proxy 針對受保護的同源操作驗確切 Host、Origin、session cookie 和 CSRF token，對瀏覽器可見的 JSON／headers 檢查 upstream Authorization 與明文密碼，皆未出現。錯誤 Host 用明確送出 `Host` 的原生 Node HTTP client，因一般 `fetch` 會代填合法 host。

原生 Windows OpenCode 與 proxy 的 `Get-NetTCPConnection` 驗證為 **UNVERIFIED**。S6 在同一 Windows 主機用 `Get-NetTCPConnection` 查到獨立的 Job Object 合成 worker 僅在 `127.0.0.1`，這是 Windows listener 輔證。 [S6](p0-s6-windows.md)
