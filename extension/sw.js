const HOST = "com.example.time_tracker";

console.log("[TT] SW boot");

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
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
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

chrome.action.onClicked.addListener(() => {
  console.log("[TT] click -> ping");
  sendToHost({ type: "ping", ts: Date.now() });
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  let url;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    url = normalizeUrl(tab?.url);
  } catch (err) {
    console.warn("[TT] onActivated tab lookup failed:", err);
  }

  sendRawEvent("tab_activated", {
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId,
    url,
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = normalizeUrl(changeInfo.url || tab?.url);
  sendRawEvent("tab_updated", {
    tabId,
    windowId: tab?.windowId,
    status: changeInfo.status,
    url,
  });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  let url;
  let tabId;

  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    try {
      const [activeTab] = await chrome.tabs.query({ windowId, active: true });
      tabId = activeTab?.id;
      url = normalizeUrl(activeTab?.url);
    } catch (err) {
      console.warn("[TT] onFocusChanged active tab lookup failed:", err);
    }
  }
  sendRawEvent("window_focus_changed", {
    windowId,
    tabId,
    url,
  });
});

  chrome.idle.onStateChanged.addListener((state) => {
  sendRawEvent("idle_state_changed", {
    state,
  });
});