// Freezes animated images by driving Chrome's built-in image animation
// policy. With the policy set to "none", Chrome renders only the first frame
// of every animated GIF, APNG and WebP, whether it's an <img>, a CSS
// background or inside an iframe.
//
// It also fetches images from other origins for the click-to-play content
// script, which can't read them itself because of CORS.

importScripts("image-bytes.js");

const DEFAULTS = { enabled: true };
const MAX_BYTES = 40 * 1024 * 1024; // keeps base64 under the 64 MiB message cap

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = { probe, fetch: fetchImage }[message?.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  handler(message.url).then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true;
});

function checkUrl(url) {
  const { protocol } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`Can't fetch ${protocol} URLs`);
  }
}

// Reads only the start of the file; that's enough to tell if it's animated.
async function probe(url) {
  checkUrl(url);
  const res = await fetch(url, {
    credentials: "include",
    headers: { Range: `bytes=0-${SNIFF_LIMIT - 1}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { animated } = await sniffResponse(res);
  return { animated: animated === true };
}

// Only hands back bytes that really are an animated image, so content
// scripts can't use this to read arbitrary cross-origin data.
async function fetchImage(url) {
  checkUrl(url);
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length")) > MAX_BYTES) {
    throw new Error("Image is too large to play");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("Image is too large to play");
  const { type, animated } = sniffImage(bytes, true);
  if (!animated) throw new Error("Not an animated image");
  return { type, data: toBase64(bytes) };
}
