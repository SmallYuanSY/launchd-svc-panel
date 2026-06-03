// launchd-svc-panel — frontend (vanilla JS, no framework)
// Polls /api/status every POLL_MS and redraws; buttons POST /api/action;
// the log drawer polls /api/logs while open. Bilingual (en / zh-Hant).

const POLL_MS = 3000;
const LOG_MS = 2000;

const STRINGS = {
  en: {
    appTitle: "launchd Service Panel",
    refreshTitle: "Refresh now",
    colService: "Service", colStatus: "Status", colHealth: "Health",
    colPid: "PID", colUptime: "Uptime", colActions: "Actions",
    loading: "Loading…", empty: "No services",
    stateRunning: "running", stateStopped: "stopped", stateLoaded: "loaded · idle",
    healthOk: "● OK", healthDown: "✕ no response", healthNa: "—",
    btnStart: "Start", btnRestart: "Restart", btnStop: "Stop", btnLog: "log",
    readonly: "read-only · use panelctl",
    hint: "Bound to 127.0.0.1 only. To start/stop the panel itself, use ",
    hintCode: "./panelctl",
    disconnected: "disconnected",
    autoRefresh: "auto-refresh",
    logTitle: (n) => `${n} — log (last 300 lines)`,
    logEmpty: "(empty)", logFail: "(failed to read log)",
    actionResult: (name, action, ok, msg) => `${name}: ${action} → ${ok ? "OK" : msg}`,
    actionFail: (name, action) => `${name}: ${action} failed`,
  },
  "zh-Hant": {
    appTitle: "launchd 服務控制台",
    refreshTitle: "立即重整",
    colService: "服務", colStatus: "狀態", colHealth: "健康",
    colPid: "PID", colUptime: "運行時間", colActions: "操作",
    loading: "載入中…", empty: "無服務",
    stateRunning: "running", stateStopped: "stopped", stateLoaded: "已載入·未跑",
    healthOk: "● 正常", healthDown: "✕ 無回應", healthNa: "—",
    btnStart: "啟動", btnRestart: "重啟", btnStop: "停止", btnLog: "log",
    readonly: "唯讀 · 用 panelctl",
    hint: "只綁 127.0.0.1。要啟停面板自己,請在終端機用 ",
    hintCode: "./panelctl",
    disconnected: "連線中斷",
    autoRefresh: "自動更新",
    logTitle: (n) => `${n} — log (尾部 300 行)`,
    logEmpty: "(空)", logFail: "(讀取 log 失敗)",
    actionResult: (name, action, ok, msg) => `${name}: ${action} → ${ok ? "OK" : msg}`,
    actionFail: (name, action) => `${name}: ${action} 失敗`,
  },
};

let LANG =
  localStorage.getItem("lang") ||
  ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh-Hant" : "en");

const t = (key) => (STRINGS[LANG] && STRINGS[LANG][key]) ?? STRINGS.en[key] ?? key;

let logTimer = null;
let currentLog = null;
let lastData = null;

const $ = (id) => document.getElementById(id);

function applyStaticI18n() {
  document.documentElement.lang = LANG === "zh-Hant" ? "zh-Hant" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
  // hint contains an inline <code> element
  $("hint").innerHTML = `${t("hint")}<code>${t("hintCode")}</code>`;
  // language toggle shows the OTHER language
  $("lang-toggle").textContent = LANG === "zh-Hant" ? "EN" : "中";
}

function setLang(lang) {
  LANG = lang;
  localStorage.setItem("lang", lang);
  applyStaticI18n();
  if (lastData) render(lastData);
  if (currentLog) $("log-title").textContent = t("logTitle")(currentLog);
}

function toast(msg, isErr) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "show" + (isErr ? " err" : "");
  setTimeout(() => (el.className = ""), 2600);
}

function stateCell(s) {
  const label = { running: t("stateRunning"), stopped: t("stateStopped"), loaded: t("stateLoaded") }[s.state] || s.state;
  return `<span class="state-${s.state}"><span class="dot"></span>${label}</span>`;
}

function healthCell(h) {
  const cls = { ok: "health-ok", down: "health-down" }[h] || "health-na";
  const txt = { ok: t("healthOk"), down: t("healthDown") }[h] || t("healthNa");
  return `<span class="${cls}">${txt}</span>`;
}

function actionsCell(s) {
  if (s.readonly) return `<span class="ro-tag">${t("readonly")}</span>`;
  const running = s.state === "running";
  return `
    <button class="act" data-act="start" data-name="${s.name}" ${running ? "disabled" : ""}>${t("btnStart")}</button>
    <button class="act" data-act="restart" data-name="${s.name}">${t("btnRestart")}</button>
    <button class="act danger" data-act="stop" data-name="${s.name}" ${running ? "" : "disabled"}>${t("btnStop")}</button>
    <button class="act" data-act="logs" data-name="${s.name}">${t("btnLog")}</button>`;
}

function render(data) {
  const rows = data.services || [];
  const tbody = $("rows");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">${t("empty")}</td></tr>`;
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
    lastData = await r.json();
    render(lastData);
    $("clock").textContent = new Date().toLocaleTimeString();
  } catch (e) {
    $("clock").textContent = t("disconnected");
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
    toast(t("actionResult")(name, action, data.ok, data.message), !data.ok);
  } catch (e) {
    toast(t("actionFail")(name, action), true);
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
    body.textContent = data.log || t("logEmpty");
    if (atBottom) body.scrollTop = body.scrollHeight;
  } catch (e) {
    $("log-body").textContent = t("logFail");
  }
}

function openLog(name) {
  currentLog = name;
  $("log-title").textContent = t("logTitle")(name);
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

// event delegation
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button.act");
  if (btn) {
    const { name, act } = btn.dataset;
    if (act === "logs") openLog(name);
    else doAction(name, act);
  }
});
$("lang-toggle").addEventListener("click", () => setLang(LANG === "zh-Hant" ? "en" : "zh-Hant"));
$("refresh").addEventListener("click", poll);
$("log-close").addEventListener("click", closeLog);
$("log-overlay").addEventListener("click", (e) => {
  if (e.target.id === "log-overlay") closeLog();
});

applyStaticI18n();
poll();
setInterval(poll, POLL_MS);
