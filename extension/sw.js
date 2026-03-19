const HOST = "com.example.time_tracker";

console.log("[TT] SW boot");

chrome.action.onClicked.addListener(() => {
  console.log("[TT] click -> ping");

  chrome.runtime.sendNativeMessage(HOST, { type: "ping", ts: Date.now() }, (resp) => {
    console.log("[TT] resp:", resp);
    console.log("[TT] lastError:", chrome.runtime.lastError);
  });
});