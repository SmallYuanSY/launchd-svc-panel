// Hermes 服務控制台 — 前端 (vanilla JS,無框架)
// 邏輯:每 POLL_MS 打 /api/status 重繪表格;按鈕 POST /api/action;
//       log 抽屜開著時每 LOG_MS 打 /api/logs。詳見 CLAUDE.md。

const POLL_MS = 3000;
const LOG_MS = 2000;

let logTimer = null;
let currentLog = null;

const $ = (id) => document.getElementById(id);

function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  setTimeout(() => (t.className = ""), 2600);
}

function stateCell(s) {
  const label = { running: "running", stopped: "stopped", loaded: "已載入·未跑" }[s.state] || s.state;
  return `<span class="state-${s.state}"><span class="dot"></span>${label}</span>`;
}

function healthCell(h) {
  const cls = { ok: "health-ok", down: "health-down" }[h] || "health-na";
  const txt = { ok: "● 正常", down: "✕ 無回應", "n/a": "—" }[h] || h;
  return `<span class="${cls}">${txt}</span>`;
}

function actionsCell(s) {
  if (s.readonly) {
    return `<span class="ro-tag">唯讀 · 用 panelctl</span>`;
  }
  const running = s.state === "running";
  return `
    <button class="act" data-act="start" data-name="${s.name}" ${running ? "disabled" : ""}>啟動</button>
    <button class="act" data-act="restart" data-name="${s.name}">重啟</button>
    <button class="act danger" data-act="stop" data-name="${s.name}" ${running ? "" : "disabled"}>停止</button>
    <button class="act" data-act="logs" data-name="${s.name}">log</button>`;
}

function render(rows) {
  const tbody = $("rows");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">無服務</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (s) => `
    <tr>
      <td><div class="svc-name">${s.name}</div><div class="svc-desc">${s.desc || ""}</div></td>
      <td>${stateCell(s)}</td>
      <td>${healthCell(s.health)}</td>
      <td>${s.pid || "—"}</td>
      <td>${s.uptime || "—"}</td>
      <td class="actions">${actionsCell(s)}</td>
    </tr>`
    )
    .join("");
}

async function poll() {
  try {
    const r = await fetch("/api/status");
    const data = await r.json();
    render(data.services);
    $("clock").textContent = new Date().toLocaleTimeString("zh-TW");
  } catch (e) {
    $("clock").textContent = "連線中斷";
  }
}

async function doAction(name, action) {
  try {
    const r = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, action }),
    });
    const data = await r.json();
    toast(`${name}: ${action} → ${data.ok ? "OK" : data.message}`, !data.ok);
  } catch (e) {
    toast(`${name}: ${action} 失敗`, true);
  }
  setTimeout(poll, 600);
}

async function refreshLog() {
  if (!currentLog) return;
  try {
    const r = await fetch(`/api/logs?name=${encodeURIComponent(currentLog)}&lines=300`);
    const data = await r.json();
    const body = $("log-body");
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.textContent = data.log || "(空)";
    if (atBottom) body.scrollTop = body.scrollHeight;
  } catch (e) {
    $("log-body").textContent = "(讀取 log 失敗)";
  }
}

function openLog(name) {
  currentLog = name;
  $("log-title").textContent = `${name} — log (尾部 300 行)`;
  $("log-overlay").classList.remove("hidden");
  refreshLog();
  clearInterval(logTimer);
  logTimer = setInterval(() => $("log-auto").checked && refreshLog(), LOG_MS);
}

function closeLog() {
  currentLog = null;
  clearInterval(logTimer);
  $("log-overlay").classList.add("hidden");
}

// 事件委派
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button.act");
  if (btn) {
    const { name, act } = btn.dataset;
    if (act === "logs") openLog(name);
    else doAction(name, act);
  }
});
$("refresh").addEventListener("click", poll);
$("log-close").addEventListener("click", closeLog);
$("log-overlay").addEventListener("click", (e) => {
  if (e.target.id === "log-overlay") closeLog();
});

poll();
setInterval(poll, POLL_MS);
