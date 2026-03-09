// background.js

// Background service worker for handling global events if needed.
// For Phase 1, most state will be in chrome.storage.local. 

chrome.runtime.onInstalled.addListener(() => {
    console.log("DevFlow Autopilot installed.");
});
