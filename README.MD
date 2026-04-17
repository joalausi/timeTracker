# Time Tracker

Local Chrome time tracker with native messaging host on Go.

## Current Status

currently in **working baseline** stage:

- Chrome extension (Manifest V3) loads as an unpacked extension
- service worker starts and runs
- `chrome.runtime.sendNativeMessage()` works
- native host is correctly registered on Windows
- Go host starts from Chrome and responds back to the extension
- debug `ping` is successful
- `chrome.runtime.lastError === undefined`

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