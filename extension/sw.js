const HOST = "com.example.time_tracker";
const RULES_PATH = "rules.json";
const ACTIVE_SEGMENT_LOCAL_KEY = "tt_current_active_segment";
const TODAY_SUMMARY_LOCAL_KEY = "tt_today_summary";

const UI_ACTIVE_KEY = "tt_active";
const UI_STATS_TODAY_KEY = "tt_stats_today";
const UI_HOST_STATUS_KEY = "tt_host_status";
console.log("[TT] SW boot");

const state = {
  activeWindowId: null,
  activeTabId: null,
  activeUrl: undefined,
  activeTitle: undefined,
  windowFocused: false,
  popupOpen: false,
  idleState: "active",
  segment: null,
  rules: [],
};

let opQueue = Promise.resolve();
let blurRecheckTimer = null;
const BLUR_RECHECK_DEBOUNCE_MS = 450;
const WINDOW_FOCUS_DEBOUNCE_MS = 220;
let windowFocusTimer = null;
let pendingFocusWindowId = null;
let nativePort = null;
let nativePortConnectedAt = null;
let nativeRequestSeq = 0;
const nativePending = new Map();
let lastWindowFocusEventKey = null;
let lastIdleEventState = null;

function enqueue(task) {
  opQueue = opQueue
    .then(() => task())
    .catch((err) => {
      console.warn("[TT] queue task failed:", err);
    });
  return opQueue;
}

function clearBlurRecheck() {
  if (blurRecheckTimer) {
    clearTimeout(blurRecheckTimer);
    blurRecheckTimer = null;
  }
}

function clearWindowFocusDebounce() {
  if (windowFocusTimer) {
    clearTimeout(windowFocusTimer);
    windowFocusTimer = null;
  }
}

function nextRequestId() {
  nativeRequestSeq += 1;
  return `sw-${Date.now()}-${nativeRequestSeq}`;
}

function scheduleBlurRecheck(triggerReason = "blur") {
  clearBlurRecheck();
  blurRecheckTimer = setTimeout(() => {
    enqueue(async () => {
      if (state.popupOpen) {
        await publishActiveState();
        return;
      }

      try {
        const win = await chrome.windows.getLastFocused({ populate: false });
        if (win?.focused && win?.id != null && win.id !== chrome.windows.WINDOW_ID_NONE) {
          state.windowFocused = true;
          await refreshActiveContext(win.id);
          await recomputeSegment("focus");
          return;
        }
      } catch (err) {
        console.warn("[TT] blur recheck failed:", err);
      }

      state.windowFocused = false;
      state.activeWindowId = null;
      state.activeTabId = null;
      state.activeUrl = undefined;
      state.activeTitle = undefined;
      await recomputeSegment(triggerReason);
    });
  }, BLUR_RECHECK_DEBOUNCE_MS);
}

async function setHostStatus(partial) {
  const prev = await chrome.storage.local.get(UI_HOST_STATUS_KEY);
  const next = {
    ...(prev[UI_HOST_STATUS_KEY] || {}),
    ...partial,
    updated_ts_ms: Date.now(),
  };
  await chrome.storage.local.set({ [UI_HOST_STATUS_KEY]: next });
}

function requestHostPing(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, payload, async (resp) => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message;
        console.warn("[TT] native send error:", error, payload);
        await setHostStatus({ ok: false, last_error: error });
        resolve({ ok: false, error });
        return;
      }

      if (resp?.ok === false) {
        const hostError = resp.error || "host returned error";
        await setHostStatus({ ok: false, last_error: hostError });
      } else {
        await setHostStatus({ ok: true, last_error: null, last_ack_type: resp?.type || null });
      }

      console.log("[TT] host ack:", resp);
      resolve(resp || { ok: false, error: "empty response" });
    });
  });
}

function teardownNativePort(errorMessage = "native port disconnected") {
  if (nativePort) {
    try {
      nativePort.onMessage.removeListener(handleNativePortMessage);
      nativePort.onDisconnect.removeListener(handleNativePortDisconnect);
    } catch {}
  }
  nativePort = null;
  nativePortConnectedAt = null;
  for (const [, pending] of nativePending.entries()) {
    pending.resolve({ ok: false, error: errorMessage });
  }
  nativePending.clear();
}

function handleNativePortMessage(resp) {
  const requestId = resp?.request_id;
  if (requestId && nativePending.has(requestId)) {
    const pending = nativePending.get(requestId);
    nativePending.delete(requestId);
    pending.resolve(resp || { ok: false, error: "empty response" });
    return;
  }
  console.log("[TT] native port message:", resp);
}

async function handleNativePortDisconnect() {
  const error = chrome.runtime.lastError?.message || "native port disconnected";
  console.warn("[TT] native port disconnected:", error);
  await setHostStatus({ ok: false, last_error: error });
  teardownNativePort(error);
}

async function getNativePort() {
  if (nativePort) {
    return nativePort;
  }
  try {
    nativePort = chrome.runtime.connectNative(HOST);
    nativePortConnectedAt = Date.now();
    nativePort.onMessage.addListener(handleNativePortMessage);
    nativePort.onDisconnect.addListener(handleNativePortDisconnect);
    await setHostStatus({ ok: true, last_error: null, connected_ts_ms: nativePortConnectedAt });
    console.log("[TT] native port connected");
    return nativePort;
  } catch (err) {
    const error = String(err);
    await setHostStatus({ ok: false, last_error: error });
    console.warn("[TT] connectNative failed:", err);
    throw err;
  }
}

async function postToHost(payload, { expectResponse = true } = {}) {
  const requestId = nextRequestId();
  const envelope = {
    ...payload,
    request_id: requestId,
  };
  const port = await getNativePort();
  return new Promise((resolve) => {
    if (expectResponse) {
      const timeoutId = setTimeout(() => {
        if (!nativePending.has(requestId)) return;
        nativePending.delete(requestId);
        resolve({ ok: false, error: "native response timeout" });
      }, 3000);
      nativePending.set(requestId, {
        resolve: (resp) => {
          clearTimeout(timeoutId);
          resolve(resp);
        },
      });
    }

    try {
      port.postMessage(envelope);
      if (!expectResponse) {
        resolve({ ok: true, queued: true });
      }
    } catch (err) {
      if (expectResponse && nativePending.has(requestId)) {
        nativePending.delete(requestId);
      }
      resolve({ ok: false, error: String(err) });
    }
  });
}

function sendToHost(payload) {
  postToHost(payload, { expectResponse: false })
    .then(async (resp) => {
      if (!resp?.ok) {
        await setHostStatus({ ok: false, last_error: resp?.error || "native send failed" });
      } else {
        await setHostStatus({ ok: true, last_error: null });
      }
    })
    .catch(async (err) => {
      console.warn("[TT] sendToHost postToHost failed", err);
      await setHostStatus({ ok: false, last_error: String(err) });
    });
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return undefined;
  try {
    const parsed = new URL(rawUrl);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function getHostname(rawUrl) {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
}

function safeProtocol(urlValue) {
  if (!urlValue) return undefined;
  try {
    return new URL(urlValue).protocol;
  } catch {
    return undefined;
  }
}

function isHttpUrl(urlValue) {
  const protocol = safeProtocol(urlValue);
  return protocol === "http:" || protocol === "https:";
}

function sendRawEvent(name, details = {}) {
  if (name === "window_focus_changed") {
    const eventKey = `${details.windowId ?? "none"}:${details.tabId ?? "none"}:${details.url ?? ""}`;
    if (eventKey === lastWindowFocusEventKey) {
      return;
    }
    lastWindowFocusEventKey = eventKey;
  }
  if (name === "idle_state_changed") {
    if (details.state === lastIdleEventState) {
      return;
    }
    lastIdleEventState = details.state;
  }
  const event = {
    type: "event",
    name,
    ts: Date.now(),
    ...details,
  };
  console.log("[TT] raw event:", event);
  sendToHost(event);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function compileRule(rawRule) {
  const name = typeof rawRule?.name === "string" ? rawRule.name : "unnamed";
  const action = rawRule?.action === "ignore" ? "ignore" : "track";
  const category = typeof rawRule?.category === "string" ? rawRule.category : "uncategorized";

  const regexPatterns = toArray(rawRule?.url_regex);
  const regexList = [];
  for (const pattern of regexPatterns) {
    try {
      regexList.push(new RegExp(pattern));
    } catch (err) {
      console.warn("[TT] invalid regex in rule", name, pattern, err);
    }
  }

  return {
    name,
    action,
    category,
    hostnameExact: toArray(rawRule?.hostname_exact),
    hostnameSuffix: toArray(rawRule?.hostname_suffix),
    pathPrefix: toArray(rawRule?.path_prefix),
    regexList,
    allowNonHttp: Boolean(rawRule?.allow_non_http),
  };
}

async function loadRules() {
  try {
    const url = chrome.runtime.getURL(RULES_PATH);
    const resp = await fetch(url, { cache: "no-cache" });
    if (!resp.ok) {
      throw new Error(`rules fetch failed: ${resp.status}`);
    }

    const parsed = await resp.json();
    const rules = Array.isArray(parsed?.rules) ? parsed.rules.map(compileRule) : [];
    state.rules = rules;
    console.log("[TT] rules loaded:", rules.length);
  } catch (err) {
    console.warn("[TT] failed to load rules; fallback to empty set", err);
    state.rules = [];
  }
}

function matchesRule(urlObj, rule) {
  if (!rule.allowNonHttp && urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    return false;
  }

  const checks = [];

  if (rule.hostnameExact.length > 0) {
    checks.push(rule.hostnameExact.includes(urlObj.hostname));
  }
  if (rule.hostnameSuffix.length > 0) {
    checks.push(rule.hostnameSuffix.some((suffix) => urlObj.hostname.endsWith(suffix)));
  }
  if (rule.pathPrefix.length > 0) {
    checks.push(rule.pathPrefix.some((prefix) => urlObj.pathname.startsWith(prefix)));
  }
  if (rule.regexList.length > 0) {
    checks.push(rule.regexList.some((rx) => rx.test(urlObj.toString())));
  }

  if (checks.length === 0) {
    return false;
  }
  return checks.every(Boolean);
}

function getTrackingDecision(urlValue) {
  if (!urlValue) {
    return { action: "ignore", category: "unmatched", rule: "no_url" };
  }

  let urlObj;
  try {
    urlObj = new URL(urlValue);
  } catch {
    return { action: "ignore", category: "unmatched", rule: "invalid_url" };
  }

  for (const rule of state.rules) {
    if (matchesRule(urlObj, rule)) {
      return {
        action: rule.action,
        category: rule.category,
        rule: rule.name,
      };
    }
  }

  return { action: "ignore", category: "unmatched", rule: "no_match" };
}

function segmentKeyFromContext() {
  const decision = getTrackingDecision(state.activeUrl);
  if (
    decision.action !== "track" ||
    !state.windowFocused ||
    state.idleState !== "active" ||
    state.activeTabId == null ||
    state.activeWindowId == null
  ) {
    return null;
  }

  return {
    tabId: state.activeTabId,
    windowId: state.activeWindowId,
    url: state.activeUrl,
    title: state.activeTitle,
    category: decision.category,
    rule: decision.rule,
  };
}

function dayKeyFromTs(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayBoundsFromTs(ts) {
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return { start, end };
}

function overlapMs(startA, endA, startB, endB) {
  const start = Math.max(startA, startB);
  const end = Math.min(endA, endB);
  return Math.max(0, end - start);
}

async function persistCurrentSegment() {
  await chrome.storage.session.set({ tt_active_segment: state.segment });
  await chrome.storage.local.set({
    [ACTIVE_SEGMENT_LOCAL_KEY]: state.segment
      ? {
          start_ts_ms: state.segment.start_ts_ms,
          url: state.segment.url,
          title: state.segment.title,
          category: state.segment.category,
          rule: state.segment.rule,
        }
      : null,
  });
}

async function updateTodaySummaryLocalFallback(finalizedSegment) {
  const dayKey = dayKeyFromTs(finalizedSegment.end_ts_ms);
  const { start: dayStart, end: dayEnd } = dayBoundsFromTs(finalizedSegment.end_ts_ms);
  const durationMs = overlapMs(finalizedSegment.start_ts_ms, finalizedSegment.end_ts_ms, dayStart, dayEnd);
  if (durationMs <= 0) {
    return;
  }

  const stored = await chrome.storage.local.get(TODAY_SUMMARY_LOCAL_KEY);
  const existing = stored[TODAY_SUMMARY_LOCAL_KEY];

  let summary;
  if (!existing || existing.day !== dayKey) {
    summary = {
      day: dayKey,
      total_ms: 0,
      by_category: {},
    };
  } else {
    summary = {
      day: existing.day,
      total_ms: Number(existing.total_ms) || 0,
      by_category: { ...(existing.by_category || {}) },
    };
  }

  summary.total_ms += durationMs;
  const category = finalizedSegment.category || "uncategorized";
  summary.by_category[category] = (summary.by_category[category] || 0) + durationMs;

  await chrome.storage.local.set({
    [TODAY_SUMMARY_LOCAL_KEY]: summary,
    [UI_STATS_TODAY_KEY]: {
      day: summary.day,
      total_ms: summary.total_ms,
      by_category: summary.by_category,
      by_hour: {},
      source: "local-fallback",
      updated_ts_ms: Date.now(),
    },
  });
  console.log("[TT] updated today summary fallback:", summary);
}

async function publishActiveState() {
  const trackingDecision = getTrackingDecision(state.activeUrl);
  const tracking = Boolean(state.segment);

  const payload = {
    tracking,
    tracker_state: tracking ? "Tracking" : "Idle",
    window_focused: state.windowFocused,
    idle_state: state.idleState,
    tab_id: state.activeTabId,
    window_id: state.activeWindowId,
    url: state.activeUrl || null,
    hostname: getHostname(state.activeUrl) || null,
    title: state.activeTitle || null,
    category: state.segment?.category || (trackingDecision.action === "track" ? trackingDecision.category : null),
    rule: state.segment?.rule || (trackingDecision.action === "track" ? trackingDecision.rule : null),
    start_ts_ms: state.segment?.start_ts_ms || null,
    updated_ts_ms: Date.now(),
  };

  await chrome.storage.local.set({ [UI_ACTIVE_KEY]: payload });
}

async function storeStatsFromHostResponse(resp) {
  if (!resp?.stats_today) return;
  const stats = {
    ...resp.stats_today,
    source: "host",
    updated_ts_ms: Date.now(),
  };
  await chrome.storage.local.set({
    [TODAY_SUMMARY_LOCAL_KEY]: {
      day: stats.day,
      total_ms: stats.total_ms,
      by_category: stats.by_category || {},
    },
    [UI_STATS_TODAY_KEY]: stats,
  });
}

function sameSegmentTarget(segment, target) {
  return (
    segment &&
    target &&
    segment.tabId === target.tabId &&
    segment.windowId === target.windowId &&
    segment.url === target.url &&
    segment.category === target.category &&
    segment.rule === target.rule
  );
}

async function startSegment(target) {
  if (!target) return;
  state.segment = {
    type: "segment",
    tabId: target.tabId,
    windowId: target.windowId,
    start_ts_ms: Date.now(),
    url: target.url,
    title: target.title,
    category: target.category,
    rule: target.rule,
  };
  console.log("[TT] segment start:", state.segment);
  await persistCurrentSegment();
  await publishActiveState();
}

async function finalizeSegment(reason) {
  const current = state.segment;
  if (!current) return;

  const endTs = Date.now();
  if (endTs <= current.start_ts_ms) {
    console.log("[TT] skip segment finalize due to non-positive duration");
    state.segment = null;
    await persistCurrentSegment();
    await publishActiveState();
    return;
  }

  const payload = {
    type: "segment",
    start_ts_ms: current.start_ts_ms,
    end_ts_ms: endTs,
    duration_ms: endTs - current.start_ts_ms,
    url: current.url,
    hostname: getHostname(current.url),
    title: current.title,
    category: current.category,
    rule: current.rule,
    reason,
  };

  console.log("[TT] segment finalize:", payload);
  const resp = await postToHost(payload);
  if (resp?.ok) {
    await storeStatsFromHostResponse(resp);
  } else {
    await updateTodaySummaryLocalFallback(payload);
  }

  state.segment = null;
  await persistCurrentSegment();
  await publishActiveState();
}

async function recomputeSegment(reason) {
  const target = segmentKeyFromContext();

  if (!state.segment && target) {
    await startSegment(target);
    return;
  }

  if (state.segment && !target) {
    await finalizeSegment(reason);
    return;
  }

  if (state.segment && target && !sameSegmentTarget(state.segment, target)) {
    await finalizeSegment(reason);
    await startSegment(target);
    return;
  }
  await publishActiveState();
}

async function refreshActiveContext(windowId) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) {
    state.activeWindowId = null;
    state.activeTabId = null;
    state.activeUrl = undefined;
    state.activeTitle = undefined;
    return;
  }

  const [activeTab] = await chrome.tabs.query({ windowId, active: true });
  state.activeWindowId = windowId;
  state.activeTabId = activeTab?.id ?? null;
  state.activeUrl = normalizeUrl(activeTab?.url);
  state.activeTitle = activeTab?.title;
}

async function bootstrapState() {
  await loadRules();

  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    state.windowFocused = win?.focused ?? false;
    state.activeWindowId = win?.id ?? null;

    const activeTab = win?.tabs?.find((tab) => tab.active);
    state.activeTabId = activeTab?.id ?? null;
    state.activeUrl = normalizeUrl(activeTab?.url);
    state.activeTitle = activeTab?.title;
  } catch (err) {
    console.warn("[TT] bootstrap failed:", err);
  }

  await persistCurrentSegment();
  await publishActiveState();
  await recomputeSegment("bootstrap");
  const stored = await chrome.storage.local.get(TODAY_SUMMARY_LOCAL_KEY);
  const summary = stored[TODAY_SUMMARY_LOCAL_KEY];
  if (summary) {
    await chrome.storage.local.set({
      [UI_STATS_TODAY_KEY]: {
        day: summary.day,
        total_ms: summary.total_ms || 0,
        by_category: summary.by_category || {},
        by_hour: {},
        source: "local-fallback",
        updated_ts_ms: Date.now(),
      },
    });
  }
}

chrome.runtime.onStartup.addListener(() => {
  enqueue(async () => {
    await bootstrapState();
  });
});

chrome.runtime.onInstalled.addListener(() => {
  enqueue(async () => {
    await bootstrapState();
  });
});

chrome.action.onClicked.addListener(() => {
  console.log("[TT] click -> ping");
  requestHostPing({ type: "ping", ts: Date.now() });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "tt_ping_host") {
    enqueue(async () => {
      const resp = await requestHostPing({ type: "ping", ts: Date.now(), source: "popup" });
      sendResponse(resp || { ok: false, error: "no response" });
    });
    return true;
  }

  if (message?.type === "tt_refresh_stats") {
    enqueue(async () => {
      const stored = await chrome.storage.local.get(TODAY_SUMMARY_LOCAL_KEY);
      const summary = stored[TODAY_SUMMARY_LOCAL_KEY];
      if (summary) {
        const resp = {
          ok: true,
          type: "stats_today_ack",
          stats_today: {
            day: summary.day,
            total_ms: summary.total_ms || 0,
            by_category: summary.by_category || {},
            by_hour: {},
          },
        };
        await storeStatsFromHostResponse(resp);
        sendResponse(resp);
        return;
      }
      sendResponse({ ok: true, type: "stats_today_ack", stats_today: { day: null, total_ms: 0, by_category: {}, by_hour: {} } });
    });
    return true;
  }

  if (message?.type === "tt_popup_opened") {
    enqueue(async () => {
      state.popupOpen = true;
      clearBlurRecheck();
      await publishActiveState();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "tt_popup_closed") {
    enqueue(async () => {
      state.popupOpen = false;
      if (!state.windowFocused) {
        scheduleBlurRecheck("popup_closed");
      }
      await publishActiveState();
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  enqueue(async () => {
    let url;
    let title;
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      url = normalizeUrl(tab?.url);
      title = tab?.title;
    } catch (err) {
      console.warn("[TT] onActivated tab lookup failed:", err);
    }

    state.activeWindowId = activeInfo.windowId;
    state.activeTabId = activeInfo.tabId;
    state.activeUrl = url;
    state.activeTitle = title;

    if (isHttpUrl(url)) {
      sendRawEvent("tab_activated", {
        tabId: activeInfo.tabId,
        windowId: activeInfo.windowId,
        url,
        title,
      });
    } else {
      console.log("[TT] skip tab_activated raw event for non-http(s) URL");
    }

    await recomputeSegment("switch");
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  enqueue(async () => {
    if (!changeInfo.url) {
      return;
    }

    const url = normalizeUrl(changeInfo.url);
    if (isHttpUrl(url)) {
      sendRawEvent("tab_updated", {
        tabId,
        windowId: tab?.windowId,
        url,
        title: tab?.title,
      });
    } else {
      console.log("[TT] skip tab_updated raw event for non-http(s) URL");
    }

    if (tabId !== state.activeTabId) {
      return;
    }

    if (tab?.windowId != null) {
      state.activeWindowId = tab.windowId;
    }
    state.activeUrl = url;
    state.activeTitle = tab?.title;

    await recomputeSegment("navigation");
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  pendingFocusWindowId = windowId;
  clearWindowFocusDebounce();
  windowFocusTimer = setTimeout(() => {
    enqueue(async () => {
      const effectiveWindowId = pendingFocusWindowId;
      state.windowFocused = effectiveWindowId !== chrome.windows.WINDOW_ID_NONE;

      let tabId;
      let url;
      if (state.windowFocused) {
        clearBlurRecheck();
        try {
          await refreshActiveContext(effectiveWindowId);
          tabId = state.activeTabId;
          url = state.activeUrl;
        } catch (err) {
          console.warn("[TT] onFocusChanged active tab lookup failed:", err);
        }
      } else if (state.popupOpen) {
        scheduleBlurRecheck("popup_blur");
        await publishActiveState();
        return;
      } else {
        state.activeWindowId = null;
        state.activeTabId = null;
        state.activeUrl = undefined;
        state.activeTitle = undefined;
      }

      sendRawEvent("window_focus_changed", {
        windowId: effectiveWindowId,
        tabId,
        ...(isHttpUrl(url) ? { url, title: state.activeTitle } : {}),
      });

      await recomputeSegment(state.windowFocused ? "focus" : "blur");
    });
  }, WINDOW_FOCUS_DEBOUNCE_MS);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    if (tabId !== state.activeTabId) {
      return;
    }

    state.activeTabId = null;
    state.activeUrl = undefined;
    state.activeTitle = undefined;

    await recomputeSegment("close");
  });
});

chrome.idle.onStateChanged.addListener((idleState) => {
  enqueue(async () => {
    state.idleState = idleState;

    sendRawEvent("idle_state_changed", {
      state: idleState,
    });

    if (idleState === "active" && state.windowFocused && state.activeWindowId != null) {
      try {
        await refreshActiveContext(state.activeWindowId);
      } catch (err) {
        console.warn("[TT] idle active refresh failed:", err);
      }
    }

    await recomputeSegment(idleState === "active" ? "resume" : idleState);
  });
});

enqueue(async () => {
  await bootstrapState();
});
