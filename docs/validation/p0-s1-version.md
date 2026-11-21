# S1　OpenCode 版本與契約

2026-11-21。原生 Windows 11 x64 靜態驗證通過。二進位執行與 API 的 Windows 驗收仍為 **UNVERIFIED**，目前只有隔離 Linux 容器執行證據。

## 可重現命令

```powershell
npm ci --ignore-scripts
pwsh -NoProfile -File scripts/phase0/fetch-pins.ps1
podman pull docker.io/library/node@sha256:e484ae3f1e3c378021c967fd42254f343c302a9263e412280eac32bf5bca7008
pwsh -NoProfile -File scripts/phase0/run-container.ps1 -Mode contract
```

`fetch-pins.ps1` 檢查 immutable release、tag commit、官方資產 digest、獨立 `Get-FileHash -Algorithm SHA256`、解包後執行檔、Git tree／blob 與 client lock。Windows 標準 x64 ZIP 重複解包後 hash 相同。本階段支援矩陣只有 Windows x64 標準資產。Release 另刊載 x64 baseline ZIP `8dcfe392a79412bf908de4c0cf5338c52589147eff54f1a46c25fb24a94708e7` 與 ARM64 ZIP `13dabbf6874c8abfc7ff44bee0e64c3758e918a0e27f56f74173c353d56a842d`，僅記 metadata。 [發行資產 metadata](https://api.github.com/repos/anomalyco/opencode/releases/tags/v2.3.2)

| 項目 | 已核對值 |
|---|---|
| Tag／commit | `v2.3.2`／`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` |
| Windows ZIP SHA-256 | `8ad59f1992a0594d8bd72b5ed3be1f5bfffcd9d1756853eec7e5d3141c25be1f` |
| Windows `opencode.exe` SHA-256 | `5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3` |
| Linux tar.gz／binary SHA-256 | `563b5d663637226b6e3bb4bb6803281bc39b0d2cd88db06d674b6420aab009b0`／`e6543f6e5c39c40971ba38afd1819ac852c29ac735b5a89065d3d148d47f27ad` |
| OpenAPI LF Git blob | `1e241a9bfa20e8766834c70e9b7b2dc9bf318c70`，無 CR，SHA-256 `bc152825b9b65224bfc56bddefcdd8f44b50e7f1d1541f741ae017aa791478ba` |
| Promise client | `@opencode/client@2.3.2`，`sha512-zwlR1Q0MQxpLJU4tILaaNyHrexNQpTbquy4Lv4i5lwkSba5MMuhK0tsPmGhyLIrqAyY+sY1qI75dOzOpsCJK7Q==` |

固定值在 [pin](../../config/opencode.pin.json) 與 [npm lockfile](../../package-lock.json)。OpenAPI 採 Git blob 原始 bytes。Windows 本機可取得官方檔案。OpenCode 實際執行使用固定 Linux binary、Podman 5.4、Node 24.14.1、唯讀 worktree、容器暫存 profile、無網路、無 port publish 與容器內 `127.0.0.1` Basic auth。Windows 上缺少可用的隔離 Windows VM，Windows 執行檔沒有啟動。

## 容器實測

```json
{"test":"S1-cli","version":"2.3.2","platform":"linux"}
{"test":"S1-api","version":"2.3.2"}
{"test":"S1-client","create":true,"prompt":true,"active":true,"interrupt":"interrupted","permission":"ask","cleared":true}
{"test":"S1-automation-off","status":403}
{"test":"S1-automation-on","first":1,"after":1,"status":"done","outcome":"fired"}
```

五類 client probe 均可重現。送 prompt 後驗 durable admission ID，讀 active，呼叫 interrupt 後驗 `interrupted`，permission 由 `ask` 進入待處理清單並可拒絕、清除。Automation 以 `OPENCODE_FLAGS` 做 on/off，開啟時建立單次排程、關機跨過到期時間、用同一隔離資料重啟，run count 為 1 且後續未增加。MVP 維持關閉。`Get-NetTCPConnection` 的原生 OpenCode listener 結果待隔離 Windows VM。
