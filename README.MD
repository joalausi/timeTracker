# Time Tracker

Local Chrome time tracker powered by a Manifest V3 extension and a Go native messaging host.

## Current Status

currently in **working baseline** stage:

- Chrome extension (`extension/`) with service worker + popup UI.
- Native Messaging channel `chrome.runtime.sendNativeMessage(...)` to host `com.example.time_tracker`.
- Go host (`host/`) that:
  - accepts `ping`, `event`, `segment`, `stats_today` messages,
  - appends raw events to `events.jsonl`,
  - persists finalized segments into SQLite (`tt.sqlite3`),
  - returns current-day aggregates (`total_ms`, `by_category`, `by_hour`).
- Popup displays:
  - host status,
  - current tracking state,
  - active site/title/category,
  - current segment timer,
  - today summary with per-category breakdown.

In other words: the **channel Chrome Extension ↔ Native Host ↔ Go is already working**.

---

## What is this project?

The idea behind the project is to create a **local active time tracker in Chrome**.

Important: this is **not** a "stopwatch that runs while the tab is open."

The correct model here is:

- the tab must be active
- the Chrome window must be focused
- the user must not be idle or locked
- the URL must match the tracking rules

In the future, the project will count **activity segments**, not just "tab open time."

---

## Current state of the architecture

Currently, only the **minimal working framework** has been implemented.

### 1. Chrome extension
Extension:
- Loads in Chrome as an unpacked extension
- Contains a background `service worker`
- Sends a `ping` to the native host when clicking the action icon
- Receives an `ack` response

### 2. Native host in Go
Go application:
- Launches Chrome via Native Messaging
- Reads JSON messages from `stdin`
- Responds with a JSON message to `stdout`
- Used as a local backend for the future tracker

### 3. Windows registry
Chrome on Windows finds the native host via the registry key:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.example.time_tracker