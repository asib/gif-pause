const DEFAULTS = { enabled: true };

const toggle = document.getElementById("enabled");
const status = document.getElementById("status");
const warning = document.getElementById("warning");
const reloadRow = document.getElementById("reload-row");
const hint = document.getElementById("hint");

function render(enabled) {
  toggle.checked = enabled;
  hint.hidden = !enabled;
  status.textContent = enabled
    ? "GIFs show their first frame only"
    : "GIFs play normally";
}

// Another extension or an enterprise policy can own this setting, in which
// case ours is ignored. Say so rather than silently doing nothing.
async function checkControl() {
  const { levelOfControl } =
    await chrome.accessibilityFeatures.animationPolicy.get({});
  const messages = {
    not_controllable: "This setting is locked by your browser's policy.",
    controlled_by_other_extensions:
      "Another extension controls image animation. Disable it for GIF Pause to work.",
  };
  warning.textContent = messages[levelOfControl] ?? "";
  warning.hidden = !messages[levelOfControl];
}

toggle.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: toggle.checked });
  render(toggle.checked);
  reloadRow.hidden = false;
});

document.getElementById("reload").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.tabs.reload(tab.id);
  window.close();
});

chrome.storage.sync.get(DEFAULTS).then(({ enabled }) => render(enabled));
checkControl();
