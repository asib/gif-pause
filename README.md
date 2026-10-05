# GIF Pause

A Chrome extension that stops animated GIFs (and APNG / animated WebP) from
playing automatically. Every animated image shows its first frame only.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Reload any tabs that were already open.

Click the toolbar icon to switch freezing on or off. While it's off the icon
shows an `off` badge.

## How it works

The extension sets Chrome's built-in image animation policy
([`chrome.accessibilityFeatures.animationPolicy`][api]) to `"none"`. The
browser itself then refuses to advance animation frames, so it covers
`<img>` tags, CSS background images and iframes on every site, with no
content scripts and no page slowdown. Turning the extension off (or
uninstalling it) hands the setting back to Chrome's default.

[api]: https://developer.chrome.com/docs/extensions/reference/api/accessibilityFeatures

## Limitations

- Changes apply to pages loaded after the switch; reload open tabs.
- Many sites (X/Twitter, Reddit, Giphy, Imgur) serve "GIFs" as muted,
  looping `<video>` elements. Those aren't images, so they aren't frozen yet.
- Only one extension can own the animation setting. If another extension
  (e.g. Google's "Animation Policy") controls it, the popup says so.
