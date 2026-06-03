# launchd-svc-panel

A tiny, **zero-dependency** local web panel to view and control your macOS
`launchd` services — status, start/stop/restart, live logs, and health checks —
all from one page at `http://localhost:8990`.

Built with the Python standard library only (no `pip install`, no venv needed to
run). You hardcode the handful of services you care about in one JSON file; the
panel does the rest via `launchctl`.

> Originally built to manage a small fleet of always-on services (an agent
> gateway, a web UI, a `cloudflared` tunnel) on a Mac mini. Generic enough for
> any `launchd`-managed services.

## Screenshot

```
┌─ launchd 服務控制台 ───────────────────────────────────────────┐
│ 服務            狀態       健康     PID     運行時間   操作       │
│ my-web-app      ● running  ● 正常   3001    06:05:03  [重啟][停止][log] │
│ my-daemon       ● running  ● 正常   4210    05:14:24  [重啟][停止][log] │
│ my-tunnel       ● running  ● 正常   2436    00:55     [重啟][停止][log] │
│ launchd-svc-panel ● running ● 正常  2491    00:55     唯讀 · 用 panelctl │
└────────────────────────────────────────────────────────────────┘
```

## Why

macOS already runs your background services with `launchd`, but there's no
friendly way to see them all at a glance or restart one without remembering long
labels and `launchctl` incantations. This is a thin, curated control surface
over `launchctl` for **just the services you list**.

## Design goals

There are several mature launchd managers out there, and they're great if you want
a full GUI to browse and edit every job on your system. This project aims at a
different, smaller niche:

- **Zero dependencies, no build step.** System `python3`, stdlib only. No
  toolchain, no `npm`, no app to install — clone and `./panelctl install`.
- **Config-as-code.** Your services live in one small `services.json`, not a GUI
  you click through. Diff it, version it, copy it to another Mac.
- **Curated, not exhaustive.** It shows only the handful of always-on services you
  list — not every job `launchctl list` would dump.
- **Automation / agent friendly.** Hand the folder to an AI agent (or a teammate):
  "add my new service" is a few-line JSON edit, not a GUI walkthrough.

In short: a minimal dashboard for a *known set* of services that you — or an
agent — can configure in seconds.

## Requirements

- macOS (uses `launchctl`)
- `python3` (the system one at `/usr/bin/python3` is fine) — **no third-party packages**

## Install

```bash
git clone https://github.com/SmallYuanSY/launchd-svc-panel.git ~/launchd-svc-panel
cd ~/launchd-svc-panel
cp services.example.json services.json   # then edit for your machine
./panelctl install                        # generates the LaunchAgent + starts it
```

Open **http://localhost:8990**.

## Configure

Edit `services.json`. Each service is one object:

```json
{
  "name": "my-web-app",
  "desc": "one-line description",
  "label": "local.my-web-app",
  "plist": "~/Library/LaunchAgents/local.my-web-app.plist",
  "logs": { "out": "~/Library/Logs/my-web-app.log", "err": "~/Library/Logs/my-web-app.err.log" },
  "health": { "kind": "http", "url": "http://127.0.0.1:3000/" },
  "readonly": false
}
```

- Paths support `~` and `$ENV`. The panel auto-detects your UID.
- `label` **must match** the `<key>Label</key>` inside that service's plist.
- `health.kind` is one of:
  - `tcp` — with `host` + `port` (OK if the port accepts a connection)
  - `http` — with `url` (OK if status < 500)
  - `cloudflared` — with `url` pointing at the tunnel's metrics endpoint (OK if `ha_connections > 0`)
- `readonly: true` services can't be started/stopped from the UI (used for the panel itself).

The `panel.self_label` field tells `panelctl` which LaunchAgent label is the panel
itself.

After editing: `./panelctl restart`, then refresh the page. Only `services.json`
changes — never `server.py`.

### Adding a service with an AI agent

Don't want to hand-write a plist? Hand this repo to any AI agent and tell it what
you want kept alive (e.g. *"keep my app on port 3000 running and show it here"*).
[`AGENTS.md`](AGENTS.md) is a step-by-step contract the agent follows to create the
LaunchAgent and register it in the panel for you.

## Controlling the panel itself

The panel can't stop itself from the UI (so you can't lock yourself out). Use the
entry script:

```bash
./panelctl install    # generate plist + load (first run)
./panelctl start
./panelctl stop
./panelctl restart    # apply changes to server.py / static files
./panelctl status
./panelctl logs 100
```

## How it works

```
browser  static/index.html + app.js     polls /api/status every 3s
   │  HTTP, bound to 127.0.0.1 only
server.py  (stdlib http.server)          the only thing that touches the system
   │  subprocess → launchctl / tail / curl
launchctl  gui/$UID                       starts/stops the LaunchAgents
```

`server.py` reads `services.json` and exposes a tiny REST API
(`/api/status`, `/api/action`, `/api/logs`, `/api/ping`). It shells out to
`launchctl print/bootstrap/bootout/kickstart` and does health probes. Inputs are
validated against the service whitelist; nothing user-supplied is passed to a
shell.

## Security

The server binds **`127.0.0.1` only** and has no authentication — because it can
start/stop system services, it must never be exposed. To reach it remotely, put
it behind your own authenticated tunnel/proxy (e.g. Cloudflare Access). Don't
change the bind address to `0.0.0.0`.

## License

MIT — free to use, modify, and distribute, **provided you retain the copyright
and license notice** (i.e. keep attribution to the original author). See
[LICENSE](LICENSE).
