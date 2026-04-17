const KEY_ACTIVE = "tt_active";
const KEY_STATS = "tt_stats_today";
const KEY_HOST = "tt_host_status";

const els = {
  statusLine: document.getElementById("statusLine"),
  trackingState: document.getElementById("trackingState"),
  siteLine: document.getElementById("siteLine"),
  titleLine: document.getElementById("titleLine"),
  categoryLine: document.getElementById("categoryLine"),
  segmentTimer: document.getElementById("segmentTimer"),
  todayTotal: document.getElementById("todayTotal"),
  breakdownList: document.getElementById("breakdownList"),
  pingBtn: document.getElementById("pingBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  actionMessage: document.getElementById("actionMessage"),
};

const viewState = {
  active: null,
  stats: null,
  host: null,
};

function formatMs(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(safe / 1000);
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function normalizeHostname(urlValue) {
  if (!urlValue) return "—";
  try {
    return new URL(urlValue).hostname || "—";
  } catch {
    return "—";
  }
}

function renderBreakdown(byCategory = {}) {
  const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    els.breakdownList.classList.add("empty");
    els.breakdownList.innerHTML = "<li>No tracked segments for today yet.</li>";
    return;
  }

  els.breakdownList.classList.remove("empty");
  els.breakdownList.innerHTML = entries
    .map(([name, duration]) => {
      const safeName = name || "uncategorized";
      return `<li><span>${safeName}</span><strong>${formatMs(duration)}</strong></li>`;
    })
    .join("");
}

function render() {
  const active = viewState.active || {};
  const stats = viewState.stats || {};
  const host = viewState.host || {};

  const tracking = Boolean(active.tracking);
  els.trackingState.textContent = tracking ? "Tracking" : "Idle";

  const hostOk = host.ok === true;
  const hostKnownError = host.ok === false;
  els.statusLine.classList.remove("state-ok", "state-error");
  if (hostOk) {
    els.statusLine.textContent = "Host OK";
    els.statusLine.classList.add("state-ok");
  } else if (hostKnownError) {
    const err = host.last_error || host.error || "Host unavailable";
    els.statusLine.textContent = `Host Error: ${err}`;
    els.statusLine.classList.add("state-error");
  } else {
    els.statusLine.textContent = "Host status unknown";
  }

  const url = active.url || "";
  els.siteLine.textContent = url ? normalizeHostname(url) : "No active website yet";
  els.titleLine.textContent = active.title || "Open a tracked page to start";
  els.categoryLine.textContent = active.category || "—";

  if (tracking && active.start_ts_ms) {
    els.segmentTimer.textContent = formatMs(Date.now() - Number(active.start_ts_ms));
  } else {
    els.segmentTimer.textContent = "00:00:00";
  }

  els.todayTotal.textContent = formatMs(stats.total_ms || 0);
  renderBreakdown(stats.by_category || {});
}

async function refreshFromStorage() {
  const stored = await chrome.storage.local.get([KEY_ACTIVE, KEY_STATS, KEY_HOST]);
  viewState.active = stored[KEY_ACTIVE] || null;
  viewState.stats = stored[KEY_STATS] || null;
  viewState.host = stored[KEY_HOST] || null;
  render();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[KEY_ACTIVE]) viewState.active = changes[KEY_ACTIVE].newValue || null;
  if (changes[KEY_STATS]) viewState.stats = changes[KEY_STATS].newValue || null;
  if (changes[KEY_HOST]) viewState.host = changes[KEY_HOST].newValue || null;
  render();
});

els.pingBtn.addEventListener("click", async () => {
  els.actionMessage.textContent = "Pinging host...";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "tt_ping_host" });
    if (resp?.ok) {
      els.actionMessage.textContent = "Ping OK";
    } else {
      els.actionMessage.textContent = `Ping failed: ${resp?.error || "unknown"}`;
    }
  } catch (err) {
    els.actionMessage.textContent = `Ping failed: ${String(err)}`;
  }
});

els.reloadBtn.addEventListener("click", () => {
  chrome.runtime.reload();
});

setInterval(render, 1000);
refreshFromStorage();
chrome.runtime.sendMessage({ type: "tt_refresh_stats" }).catch(() => {});