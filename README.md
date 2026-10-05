# GIF Pause

A Chrome extension that stops animated GIFs (and APNG / animated WebP /
animated AVIF) from playing automatically. Every animated image shows its
first frame only; hover over one and click **▶ GIF** to play it.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Reload any tabs that were already open.

Click the toolbar icon to switch freezing on or off. While it's off the icon
shows an `off` badge.

## How it works

**Freezing.** The extension sets Chrome's built-in image animation policy
([`chrome.accessibilityFeatures.animationPolicy`][api]) to `"none"`. The
browser itself then refuses to advance animation frames, so it covers
`<img>` tags, CSS background images and iframes on every site, at no cost to
page performance. Turning the extension off (or uninstalling it) hands the
setting back to Chrome's default.

**Click-to-play.** Chrome's policy can't exempt a single image, so playback
is done by the extension. When you hover over an image, the content script
reads the start of the file to see whether it's actually animated, and only
then shows the button. Clicking it decodes the file with the
[`ImageDecoder`][decoder] API and draws its frames onto a canvas placed over
the image. The canvas matches the image's size, `object-fit`, border and
padding. The image itself stays in place (just transparent), so links and
hover effects on it keep working. Click again to pause.

Same-origin images are read from the page (usually from cache). Images on
other origins are fetched by the background worker, which only hands back
files that really are animated images.

[api]: https://developer.chrome.com/docs/extensions/reference/api/accessibilityFeatures
[decoder]: https://developer.mozilla.org/docs/Web/API/ImageDecoder

## Permissions

- `accessibilityFeatures.modify` / `.read`: set the animation policy.
- `storage`: remember the on/off setting.
- Access to all sites: show the play button on any page, and fetch
  cross-origin images to play them.

## Limitations

- Freezing applies to pages loaded after the switch; reload open tabs.
- Click-to-play works on `<img>` elements only. GIFs used as CSS
  backgrounds stay frozen.
- Click-to-play needs HTTPS (or localhost); `ImageDecoder` isn't available
  on plain-HTTP pages.
- Images from other origins are downloaded again when you play them, without
  the page's referrer. Hosts that block that (hotlink protection) can't be
  played; for `.gif` URLs the button turns red and says why on hover.
- Many sites (X/Twitter, Reddit, Giphy, Imgur) serve "GIFs" as muted,
  looping `<video>` elements. Those aren't images, so they aren't frozen yet.
- Only one extension can own the animation setting. If another extension
  (e.g. Google's "Animation Policy") controls it, the popup says so.
