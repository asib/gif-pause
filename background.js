// Freezes animated images by driving Chrome's built-in image animation
// policy. With the policy set to "none", Chrome renders only the first frame
// of every animated GIF, APNG and WebP, whether it's an <img>, a CSS
// background or inside an iframe.

const DEFAULTS = { enabled: true };

async function applySettings() {
  const { enabled } = await chrome.storage.sync.get(DEFAULTS);
  const policy = chrome.accessibilityFeatures.animationPolicy;

  if (enabled) {
    await policy.set({ value: "none" });
  } else {
    // Release control so Chrome falls back to its default ("allowed").
    await policy.clear({});
  }

  await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  await chrome.action.setBadgeText({ text: enabled ? "" : "off" });
}

chrome.runtime.onInstalled.addListener(applySettings);
chrome.runtime.onStartup.addListener(applySettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && "enabled" in changes) applySettings();
});
