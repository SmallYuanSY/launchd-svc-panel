# launchd-svc-panel

[English](README.md) | **繁體中文**

一個極簡、**零依賴**的本地網頁面板,用來查看與控制你 macOS 上的 `launchd` 服務——
狀態、啟動/停止/重啟、即時 log、健康檢查,全部集中在一頁 `http://localhost:8990`。

只用 Python 標準庫(不需 `pip install`、執行不需 venv)。你把在意的幾個服務寫進一個
JSON 檔,面板透過 `launchctl` 幫你搞定其餘的事。

> 最初是為了管理一台 Mac mini 上一小撮常駐服務(agent gateway、web UI、`cloudflared`
> 通道)而做。通用到適合任何 `launchd` 管理的服務。

## 畫面

```
┌─ launchd 服務控制台 ───────────────────────────────────────────┐
│ 服務            狀態       健康     PID     運行時間   操作       │
│ my-web-app      ● running  ● 正常   3001    06:05:03  [重啟][停止][log] │
│ my-daemon       ● running  ● 正常   4210    05:14:24  [重啟][停止][log] │
│ my-tunnel       ● running  ● 正常   2436    00:55     [重啟][停止][log] │
│ launchd-svc-panel ● running ● 正常  2491    00:55     唯讀 · 用 panelctl │
└────────────────────────────────────────────────────────────────┘
```

## 設計取向

外面已經有幾個成熟的 launchd 管理器,如果你要的是「用完整 GUI 瀏覽/編輯系統上每一個 job」,
它們很適合。這個專案瞄準的是另一個比較小的利基:

- **零依賴、免 build。** 系統 `python3`、純標準庫。沒有工具鏈、沒有 `npm`、不用安裝 app——
  clone 下來 `./panelctl install` 就跑。
- **設定即程式碼(config-as-code)。** 你的服務寫在一個小小的 `services.json`,而不是點來點去的
  GUI。可以 diff、可以版控、可以複製到另一台 Mac。
- **精選,而非全部。** 只顯示你列出的那幾個常駐服務,不會把 `launchctl list` 的幾百個 job 全倒出來。
- **自動化 / agent 友善。** 把整個資料夾丟給 AI agent(或同事):「幫我加一個服務」就是改幾行
  JSON,不是一連串 GUI 操作。

一句話:給「**已知的一組服務**」用的極簡儀表板,而且你——或一個 agent——幾秒就能設定好。

## 需求

- macOS(使用 `launchctl`)
- `python3`(系統內建的 `/usr/bin/python3` 即可)——**不需任何第三方套件**

## 安裝

```bash
git clone https://github.com/SmallYuanSY/launchd-svc-panel.git ~/launchd-svc-panel
cd ~/launchd-svc-panel
cp services.example.json services.json   # 然後依你的機器編輯
./panelctl install                        # 生成 LaunchAgent 並啟動
```

開啟 **http://localhost:8990**。

## 設定

編輯 `services.json`。每個服務是一個物件:

```json
{
  "name": "my-web-app",
  "desc": "一句話描述",
  "label": "local.my-web-app",
  "plist": "~/Library/LaunchAgents/local.my-web-app.plist",
  "logs": { "out": "~/Library/Logs/my-web-app.log", "err": "~/Library/Logs/my-web-app.err.log" },
  "health": { "kind": "http", "url": "http://127.0.0.1:3000/" },
  "readonly": false
}
```

- 路徑支援 `~` 與 `$ENV`。面板會自動偵測你的 UID。
- `label` **必須等於**該服務 plist 內的 `<key>Label</key>`。
- `health.kind` 三選一:
  - `tcp` —— 配 `host` + `port`(連得上該 port 即 ok)
  - `http` —— 配 `url`(狀態碼 < 500 即 ok)
  - `cloudflared` —— 配 `url` 指向通道的 metrics endpoint(`ha_connections > 0` 即 ok)
- `readonly: true` 的服務不能從 UI 啟停(用於面板自己)。

`panel.self_label` 欄位告訴 `panelctl` 哪個 LaunchAgent label 是面板本身。

編輯後:`./panelctl restart`,再重整頁面。只會動 `services.json`——永遠不用碰 `server.py`。

### 用 AI agent 新增服務

不想手寫 plist?把這個 repo 丟給任意 AI agent,跟它說你要讓什麼常駐
(例:「幫我把 3000 port 的 app 保持運行並顯示在這裡」)。
[`AGENTS.md`](AGENTS.md) 是一份逐步契約,agent 照著就能幫你建好 LaunchAgent 並註冊進面板。

## 控制面板自己

面板**不能**從 UI 關掉自己(這樣你不會把自己鎖在外面)。要控制面板本身,用入口腳本:

```bash
./panelctl install    # 生成 plist + 載入(首次)
./panelctl start
./panelctl stop
./panelctl restart    # 改了 server.py / 靜態檔後用這個套用
./panelctl status
./panelctl logs 100
```

## 運作原理

```
浏览器  static/index.html + app.js     每 3 秒 poll /api/status
   │  HTTP,只綁 127.0.0.1
server.py  (標準庫 http.server)         唯一會碰系統的人
   │  subprocess → launchctl / tail / curl
launchctl  gui/$UID                      真正啟停 LaunchAgent
```

`server.py` 讀 `services.json`,提供一個極小的 REST API
(`/api/status`、`/api/action`、`/api/logs`、`/api/ping`)。它 shell out 到
`launchctl print/bootstrap/bootout/kickstart` 並做健康探測。輸入都對服務白名單比對;
不會把使用者輸入丟進 shell。

## 安全

伺服器**只綁 `127.0.0.1`**、沒有任何認證——因為它能啟停系統服務,絕不可對外暴露。
要遠端存取,請放在你自己有認證的通道/代理之後(例如 Cloudflare Access)。
不要把綁定位址改成 `0.0.0.0`。

## 授權

MIT —— 可自由使用、修改、散布,**前提是保留版權與授權聲明**(即保留對原作者的署名)。
詳見 [LICENSE](LICENSE)。
