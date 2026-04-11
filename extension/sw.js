const HOST = "com.example.time_tracker";
const RULES_PATH = "rules.json";
const ACTIVE_SEGMENT_LOCAL_KEY = "tt_current_active_segment";
const TODAY_SUMMARY_LOCAL_KEY = "tt_today_summary";

console.log("[TT] SW boot");

const state = {
  activeWindowId: null,
  activeTabId: null,
  activeUrl: undefined,
  activeTitle: undefined,
  windowFocused: false,
  idleState: "active",
  segment: null,
  rules: [],
};

let opQueue = Promise.resolve();

function enqueue(task) {
  opQueue = opQueue
    .then(() => task())
    .catch((err) => {
      console.warn("[TT] queue task failed:", err);
    });
  return opQueue;
}

function sendToHost(payload) {
  chrome.runtime.sendNativeMessage(HOST, payload, (resp) => {
    if (chrome.runtime.lastError) {
      console.warn("[TT] native send error:", chrome.runtime.lastError.message, payload);
      return;
    }
    console.log("[TT] host ack:", resp);
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

function safeProtocol(urlValue) {
  if (!urlValue) return undefined;
  try {
    return new URL(urlValue).protocol;
  } catch {
    return undefined;
  }
}

function sendRawEvent(name, details = {}) {
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

async function updateTodaySummary(finalizedSegment) {
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

  await chrome.storage.local.set({ [TODAY_SUMMARY_LOCAL_KEY]: summary });
  console.log("[TT] updated today summary:", summary);
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
}

async function finalizeSegment(reason) {
  const current = state.segment;
  if (!current) return;

  const endTs = Date.now();
  if (endTs <= current.start_ts_ms) {
    console.log("[TT] skip segment finalize due to non-positive duration");
    state.segment = null;
    await persistCurrentSegment();
    return;
  }

  const payload = {
    type: "segment",
    start_ts_ms: current.start_ts_ms,
    end_ts_ms: endTs,
    url: current.url,
    title: current.title,
    category: current.category,
    rule: current.rule,
    reason,
  };

  console.log("[TT] segment finalize:", payload);
  sendToHost(payload);
  await updateTodaySummary(payload);

  state.segment = null;
  await persistCurrentSegment();
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
  }
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
  await recomputeSegment("bootstrap");
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
  sendToHost({ type: "ping", ts: Date.now() });
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

    sendRawEvent("tab_activated", {
      tabId: activeInfo.tabId,
      windowId: activeInfo.windowId,
      url,
      protocol: safeProtocol(url),
    });

    await recomputeSegment("switch");
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  enqueue(async () => {
    const url = normalizeUrl(changeInfo.url || tab?.url);

    sendRawEvent("tab_updated", {
      tabId,
      windowId: tab?.windowId,
      status: changeInfo.status,
      url,
      protocol: safeProtocol(url),
    });

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
  enqueue(async () => {
    state.windowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;

    let tabId;
    let url;
    if (state.windowFocused) {
      try {
        await refreshActiveContext(windowId);
        tabId = state.activeTabId;
        url = state.activeUrl;
      } catch (err) {
        console.warn("[TT] onFocusChanged active tab lookup failed:", err);
      }
    } else {
      state.activeWindowId = null;
      state.activeTabId = null;
      state.activeUrl = undefined;
      state.activeTitle = undefined;
    }

    sendRawEvent("window_focus_changed", {
      windowId,
      tabId,
      url,
      protocol: safeProtocol(url),
    });

    await recomputeSegment("blur");
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  enqueue(async () => {
    if (tabId !== state.activeTabId) {
      return;
    }

    state.activeTabId = null;
    state.activeUrl = undefined;
    state.activeTitle = undefined;

    sendRawEvent("tab_closed", {
      tabId,
      windowId: removeInfo?.windowId,
    });

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
