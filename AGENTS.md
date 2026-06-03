# AGENTS.md — Add a service to this panel (for AI agents)

This file is a **contract for an AI agent**. If a user hands you this repo and says
something like *"keep my app on port 3000 always running and show it in the panel"*,
follow the steps below to:

1. turn their service into a macOS **LaunchAgent** (auto-start, auto-restart), and
2. **register it** in this panel so it appears at `http://localhost:8990`.

You do **not** need to understand launchd beforehand — everything you need is here.

> Scope: **adding (or removing) one service.** Do not try to recreate the panel
> itself. The panel's own entry is `readonly` and is managed by `./panelctl`.

---

## 0. Assumptions

- macOS, and this repo is already installed and running (`./panelctl status` shows it loaded).
- The panel directory is the repo root (where `panelctl`, `server.py`, `services.json` live).
- `services.json` exists (if not: `cp services.example.json services.json` first).
- Run all commands from the repo root.

## 1. Collect these inputs (ask the user, or infer from context)

| Input | Meaning | Example |
|---|---|---|
| `NAME` | short id shown in the panel | `my-web-app` |
| `COMMAND` | the exact command + args to run the service | `/opt/homebrew/bin/node /Users/me/app/server.js` |
| `WORKDIR` | working directory (optional) | `/Users/me/app` |
| `PORT` | the TCP port it listens on (if any) | `3000` |
| `HEALTH` | how to tell it's alive — see table in step 4 | `http` |
| `LOG` | where to write its stdout/stderr | `~/Library/Logs/my-web-app.log` |

Derive a **launchd label** in reverse-DNS form: `local.<NAME>` (e.g. `local.my-web-app`).
Keep it unique. **The label MUST be identical in the plist and in `services.json`.**

## 2. Write the LaunchAgent plist

Write to `~/Library/LaunchAgents/<LABEL>.plist`. Template (substitute the `<<...>>`
parts; drop `WorkingDirectory` if not needed). Each arg of `COMMAND` is its own
`<string>` inside `ProgramArguments`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string><<LABEL>></string>
    <key>ProgramArguments</key>
    <array>
        <string><<arg0>></string>
        <string><<arg1>></string>
    </array>
    <key>WorkingDirectory</key>
    <string><<WORKDIR>></string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string><<LOG>></string>
    <key>StandardErrorPath</key>
    <string><<LOG>></string>
</dict>
</plist>
```

> Use **absolute paths** inside the plist (launchd does not expand `~`). Resolve
> `~` to the user's home yourself when writing the plist.

## 3. Load it (idempotent)

```bash
UID_N=$(id -u)
PLIST="$HOME/Library/LaunchAgents/<LABEL>.plist"
# If a job with this label is already loaded, unload it first so changes apply:
launchctl bootout "gui/$UID_N/<LABEL>" 2>/dev/null
launchctl bootstrap "gui/$UID_N" "$PLIST"
# Confirm it came up:
launchctl print "gui/$UID_N/<LABEL>" | grep -E 'state =|pid ='
```

## 4. Register it in `services.json`

Append one object to the `"services"` array. Do **not** edit `server.py`.

```json
{
  "name": "<NAME>",
  "desc": "<one-line description>",
  "label": "<LABEL>",
  "plist": "~/Library/LaunchAgents/<LABEL>.plist",
  "logs": { "out": "<LOG>", "err": "<LOG>" },
  "health": { "kind": "<HEALTH>", "...": "..." },
  "readonly": false
}
```

Pick `health.kind` from the user's service type:

| Service type | `health` block |
|---|---|
| Listens on a TCP port (db, generic server) | `{ "kind": "tcp", "host": "127.0.0.1", "port": <PORT> }` |
| Serves HTTP | `{ "kind": "http", "url": "http://127.0.0.1:<PORT>/" }` (OK if status < 500) |
| A `cloudflared` tunnel | `{ "kind": "cloudflared", "url": "http://127.0.0.1:<METRICS_PORT>/metrics" }` |
| No easy check | use any of the above pointing somewhere unreachable — it just shows `down`, harmless |

Paths in `services.json` may use `~` and `$ENV` (the panel expands them).

## 5. Apply & verify

```bash
./panelctl restart                 # reloads services.json
curl -s http://127.0.0.1:8990/api/status | python3 -m json.tool
```

Confirm the new `NAME` appears with `state: running` and `health: ok`. Tell the
user to refresh `http://localhost:8990`. **Done.**

---

## Rules (MUST / MUST NOT)

- **MUST** keep the label in the plist (`<key>Label</key>`) identical to `services.json`'s `label`. Mismatch → the panel shows it permanently `stopped`.
- **MUST** use absolute paths inside the plist; `~` only inside `services.json`.
- **MUST NOT** modify `server.py`, `panelctl`, or the panel's own `readonly` entry.
- **MUST NOT** change the server's bind address — it stays `127.0.0.1` only. Do not expose it.
- **MUST NOT** put secrets (tokens, passwords) into the plist or `services.json`; pass them via the service's own environment/config.

## Rollback (remove a service you added)

```bash
UID_N=$(id -u)
launchctl bootout "gui/$UID_N/<LABEL>" 2>/dev/null   # stop & unload
rm -f "$HOME/Library/LaunchAgents/<LABEL>.plist"     # remove the agent
# then delete that service's object from services.json, and:
./panelctl restart
```

---

## Worked example — a Node app on port 3000

User: *"I have a Node server at `~/myapp/server.js` on port 3000, keep it alive and show it."*

1. `LABEL = local.myapp`, `LOG = ~/Library/Logs/myapp.log`, HTTP health on 3000.
2. Write `~/Library/LaunchAgents/local.myapp.plist` with
   `ProgramArguments = [/opt/homebrew/bin/node, /Users/<user>/myapp/server.js]`,
   `WorkingDirectory = /Users/<user>/myapp` (absolute paths!).
3. `launchctl bootout gui/$(id -u)/local.myapp 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.myapp.plist`
4. Add to `services.json`:
   ```json
   {
     "name": "myapp",
     "desc": "Node server",
     "label": "local.myapp",
     "plist": "~/Library/LaunchAgents/local.myapp.plist",
     "logs": { "out": "~/Library/Logs/myapp.log", "err": "~/Library/Logs/myapp.log" },
     "health": { "kind": "http", "url": "http://127.0.0.1:3000/" },
     "readonly": false
   }
   ```
5. `./panelctl restart` → it shows up at `http://localhost:8990`, running, health ok.
