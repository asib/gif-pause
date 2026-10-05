// Click-to-play for animated images.
//
// Chrome keeps every animated image on its first frame (see background.js)
// and can't exempt a single image from that. So to play one on request we
// decode the file ourselves with ImageDecoder and draw its frames onto a
// canvas laid exactly over the original <img>.

(() => {
  // ImageDecoder only exists in secure contexts, and the button needs an
  // HTML document to live in.
  if (typeof ImageDecoder === "undefined") return;
  if (!(document.documentElement instanceof HTMLElement)) return;

  const MIN_SIZE = 40; // px; smaller images don't get a play button
  const INSET = 8; // px between the image's corner and the button
  const HIDE_DELAY = 250; // ms

  // --- Settings --------------------------------------------------------------

  let enabled = true;

  function setEnabled(value) {
    enabled = value !== false;
    if (!enabled) hideButton();
  }

  chrome.storage.sync.get({ enabled: true }).then((s) => setEnabled(s.enabled));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.enabled) setEnabled(changes.enabled.newValue);
  });

  // --- Reading image files ---------------------------------------------------

  // Same-origin, data: and blob: URLs can be read from the page's own context,
  // usually straight from cache. Anything else goes through the background
  // worker, which has host permissions to fetch across origins.
  function readableHere(url) {
    const { protocol, origin } = new URL(url, location.href);
    return protocol === "data:" || protocol === "blob:" || origin === location.origin;
  }

  async function fetchHere(url) {
    if (!readableHere(url)) return null;
    try {
      return await fetch(url, { cache: "force-cache" });
    } catch {
      return null; // network error or the page's CSP; try the background
    }
  }

  async function viaBackground(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply || reply.error) throw new Error(reply?.error ?? "No response");
    return reply;
  }

  const probes = new Map(); // url -> Promise<boolean>

  function isAnimated(url) {
    if (!url) return Promise.resolve(false);
    let result = probes.get(url);
    if (!result) {
      result = probe(url).catch(() => false);
      probes.set(url, result);
    }
    return result;
  }

  async function probe(url) {
    const { pathname } = new URL(url, location.href);
    if (/\.(jpe?g|svg|bmp|ico)$/i.test(pathname)) return false;
    const res = await fetchHere(url);
    if (res) return res.ok && (await sniffResponse(res)).animated === true;
    try {
      return (await viaBackground({ type: "probe", url })).animated === true;
    } catch {
      // The host wouldn't let us read it (e.g. hotlink protection). Still
      // offer the button on anything that looks like a GIF, so that clicking
      // it at least explains why it can't play.
      return /\.gif$/i.test(pathname);
    }
  }

  async function load(url) {
    const res = await fetchHere(url);
    if (res) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, type: sniffImage(bytes, true).type };
    }
    const { data, type } = await viaBackground({ type: "fetch", url });
    return { bytes: fromBase64(data), type };
  }

  // --- Playback --------------------------------------------------------------

  const players = new Map(); // img -> Player
  const failures = new Map(); // img -> error message

  const srcOf = (img) => img.currentSrc || img.src;

  class Player {
    constructor(img) {
      this.img = img;
      this.url = srcOf(img);
      this.state = "loading"; // loading | playing | paused | destroyed
      this.frame = 0;
      this.plays = 0;
      this.timer = 0;
      this.left = 0;
      this.top = 0;
      players.set(img, this);
      this.start().catch((err) => this.fail(err));
    }

    async start() {
      const { bytes, type } = await load(this.url);
      if (!type || !(await ImageDecoder.isTypeSupported(type))) {
        throw new Error("Unsupported image format");
      }
      if (this.state === "destroyed") return;

      this.decoder = new ImageDecoder({ data: bytes, type });
      await this.decoder.tracks.ready;
      await this.decoder.completed;
      const track = this.decoder.tracks.selectedTrack;
      if (track.frameCount < 2) {
        probes.set(this.url, Promise.resolve(false));
        throw new Error("Not an animated image");
      }
      this.frameCount = track.frameCount;
      this.repetitions = track.repetitionCount; // Infinity loops forever
      if (this.state === "destroyed") return;

      this.mount();
      this.play();
    }

    // The canvas is a sibling of the image, absolutely positioned over it, so
    // it scrolls, clips and stacks along with the page. The image goes
    // transparent rather than hidden so it still gets clicks and hovers, and
    // the canvas takes on its border, padding and other visible styling.
    mount() {
      const { img } = this;
      const cs = getComputedStyle(img);
      const canvas = document.createElement("canvas");
      const styles = {
        position: cs.position === "fixed" ? "fixed" : "absolute",
        left: "0px",
        top: "0px",
        margin: "0",
        display: "block",
        "box-sizing": "content-box",
        "max-width": "none",
        "max-height": "none",
        "min-width": "0",
        "min-height": "0",
        transform: "none",
        "pointer-events": "none",
        "z-index": cs.zIndex,
      };
      for (const name of [
        "border-top", "border-right", "border-bottom", "border-left", "border-radius",
        "padding", "background-color", "box-shadow", "filter", "opacity",
        "object-fit", "object-position", "image-rendering",
      ]) {
        styles[name] = cs.getPropertyValue(name);
      }
      for (const [name, value] of Object.entries(styles)) {
        canvas.style.setProperty(name, value, "important");
      }
      img.after(canvas);

      this.savedOpacity = [
        img.style.getPropertyValue("opacity"),
        img.style.getPropertyPriority("opacity"),
      ];
      img.style.setProperty("opacity", "0", "important");

      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.sync();
      startTracking();
    }

    // Keeps the canvas lined up with the image as layout changes.
    sync() {
      const { img, canvas } = this;
      if (!img.isConnected || !canvas.isConnected || srcOf(img) !== this.url) {
        this.destroy();
        return;
      }
      const cs = getComputedStyle(img);
      const px = (v) => parseFloat(v) || 0;
      const width = img.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
      const height = img.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
      if (width <= 0 || height <= 0) {
        canvas.style.setProperty("display", "none", "important");
        return;
      }
      canvas.style.setProperty("display", "block", "important");
      canvas.style.setProperty("width", `${width}px`, "important");
      canvas.style.setProperty("height", `${height}px`, "important");

      // Measure in viewport pixels, then convert back to layout pixels in
      // case an ancestor is scaled with a transform.
      const imgBox = img.getBoundingClientRect();
      const scale = img.offsetWidth ? imgBox.width / img.offsetWidth : 1;
      const canvasBox = canvas.getBoundingClientRect();
      const dx = (imgBox.left - canvasBox.left) / scale;
      const dy = (imgBox.top - canvasBox.top) / scale;
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        this.left += dx;
        this.top += dy;
        canvas.style.setProperty("left", `${this.left}px`, "important");
        canvas.style.setProperty("top", `${this.top}px`, "important");
      }
    }

    play() {
      if (this.state === "playing" || this.state === "destroyed") return;
      this.setState("playing");
      this.tick();
    }

    pause() {
      if (this.state !== "playing") return;
      clearTimeout(this.timer);
      this.setState("paused");
    }

    async tick() {
      if (this.state !== "playing") return;
      const started = performance.now();

      // Don't burn CPU decoding frames nobody can see.
      const box = this.canvas.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) {
        this.timer = setTimeout(() => this.tick(), 250);
        return;
      }

      let image;
      try {
        ({ image } = await this.decoder.decode({ frameIndex: this.frame }));
      } catch (err) {
        if (this.state === "playing") this.fail(err);
        return;
      }
      if (this.state !== "playing") {
        image.close();
        return;
      }

      const { canvas, ctx } = this;
      if (canvas.width !== image.displayWidth || canvas.height !== image.displayHeight) {
        canvas.width = image.displayWidth;
        canvas.height = image.displayHeight;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      // Browsers treat very short GIF frame delays as 100ms; so do we.
      let delay = (image.duration ?? 0) / 1000;
      if (delay <= 10) delay = 100;
      image.close();

      if (++this.frame >= this.frameCount) {
        this.frame = 0;
        if (++this.plays > this.repetitions) {
          // Non-looping image: stop on the last frame; play restarts it.
          this.plays = 0;
          this.setState("paused");
          return;
        }
      }
      this.timer = setTimeout(() => this.tick(), Math.max(0, delay - (performance.now() - started)));
    }

    fail(err) {
      if (this.state === "destroyed") return; // cancelled mid-load
      const notAnimated = err?.message === "Not an animated image";
      if (!notAnimated) failures.set(this.img, err?.message || String(err));
      this.destroy();
      if (notAnimated && current === this.img) hideButton();
    }

    destroy() {
      if (this.state === "destroyed") return;
      this.state = "destroyed";
      clearTimeout(this.timer);
      this.decoder?.close();
      if (this.canvas) {
        this.canvas.remove();
        const [value, priority] = this.savedOpacity;
        this.img.style.removeProperty("opacity");
        if (value) this.img.style.setProperty("opacity", value, priority);
      }
      players.delete(this.img);
      if (current === this.img) renderButton();
    }

    setState(state) {
      this.state = state;
      if (current === this.img) renderButton();
    }
  }

  function toggle(img) {
    const player = players.get(img);
    if (!player) {
      failures.delete(img);
      new Player(img);
    } else if (player.state === "playing") {
      player.pause();
    } else if (player.state === "paused") {
      player.play();
    } else {
      player.destroy(); // clicked again while loading: cancel
    }
    renderButton();
  }

  // --- Play button -----------------------------------------------------------

  const ICONS = {
    play: "M3 1.5v7l6-3.5z",
    pause: "M2.25 1.5h2v7h-2zM5.75 1.5h2v7h-2z",
    loading: "M5 1.5a3.5 3.5 0 1 1-3.5 3.5",
    error: "M4.25 1.25h1.5v4.75h-1.5zM4.25 7.25h1.5v1.5h-1.5z",
  };

  const STYLES = `
    :host { all: initial; }
    button {
      position: fixed;
      z-index: 2147483647;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 24px;
      margin: 0;
      padding: 0 9px 0 8px;
      border: 0;
      border-radius: 12px;
      background: rgba(17, 17, 24, 0.78);
      color: #fff;
      font: 600 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: 0.04em;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      cursor: pointer;
      visibility: hidden;
      opacity: 0;
      transition: opacity 120ms, visibility 0s 120ms, background 120ms;
    }
    button.visible {
      visibility: visible;
      opacity: 1;
      transition: opacity 120ms, background 120ms;
    }
    button:hover, button:focus-visible { background: rgba(91, 91, 214, 0.95); outline: none; }
    button[data-state="error"] { background: rgba(185, 28, 28, 0.9); }
    svg { width: 10px; height: 10px; fill: currentColor; }
    svg[data-icon="loading"] {
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  let host = null;
  let button = null;
  let icon = null;
  let current = null; // the image the button is for
  let hideTimer = 0;

  function getButton() {
    if (!host) {
      host = document.createElement("gif-pause-ui");
      const root = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      root.adoptedStyleSheets = [sheet];

      button = document.createElement("button");
      button.type = "button";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 10 10");
      svg.setAttribute("aria-hidden", "true");
      icon = document.createElementNS("http://www.w3.org/2000/svg", "path");
      svg.append(icon);
      const label = document.createElement("span");
      label.textContent = "GIF";
      button.append(svg, label);
      root.append(button);

      // Keep clicks on the button away from the page's own handlers, e.g. a
      // link wrapped around the image.
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick"]) {
        button.addEventListener(type, (event) => {
          event.stopPropagation();
          if (type === "mousedown") event.preventDefault();
        });
      }
      button.addEventListener("click", () => current && toggle(current));
    }
    if (!host.isConnected) document.documentElement.append(host);
    return button;
  }

  function renderButton() {
    if (!current || !button) return;
    const player = players.get(current);
    const state = failures.has(current) ? "error" : player?.state ?? "paused";
    const [iconName, label] = {
      loading: ["loading", "Loading GIF…"],
      playing: ["pause", "Pause GIF"],
      paused: ["play", "Play GIF"],
      error: ["error", `Couldn't play this GIF (${failures.get(current)}). Click to retry.`],
    }[state];
    icon.setAttribute("d", ICONS[iconName]);
    icon.parentNode.dataset.icon = iconName;
    button.dataset.state = state;
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function positionButton() {
    if (!current?.isConnected) {
      hideButton();
      return;
    }
    const box = current.getBoundingClientRect();
    button.style.left = `${Math.max(box.left, 0) + INSET}px`;
    button.style.top = `${Math.max(box.top, 0) + INSET}px`;
  }

  function showButton(img) {
    cancelHide();
    current = img;
    getButton();
    renderButton();
    positionButton();
    button.classList.add("visible");
    startTracking();
  }

  function hideButton() {
    cancelHide();
    current = null;
    candidate = null;
    button?.classList.remove("visible");
  }

  function scheduleHide() {
    if (!current || hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      hideButton();
    }, HIDE_DELAY);
  }

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }

  // One animation-frame loop keeps playing canvases and the button lined up
  // with their images while anything is on screen.
  let frameRequest = 0;

  function startTracking() {
    if (!frameRequest) frameRequest = requestAnimationFrame(track);
  }

  function track() {
    frameRequest = 0;
    for (const player of players.values()) {
      if (player.canvas) player.sync();
    }
    if (current) positionButton();
    if (current || players.size) startTracking();
  }

  // --- Hover detection -------------------------------------------------------

  let pointer = null;
  let hoverRequest = 0;
  let candidate = null; // image under the pointer, possibly still being probed

  function onPointer(event) {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
    scheduleHover();
  }

  function scheduleHover() {
    if (enabled && pointer && !hoverRequest) {
      hoverRequest = requestAnimationFrame(updateHover);
    }
  }

  function updateHover() {
    hoverRequest = 0;
    const stack = elementsAt(pointer.x, pointer.y);
    if (host && stack[0] === host) {
      cancelHide(); // on the button itself
      return;
    }
    const img = findImage(stack);
    if (img && img === candidate) {
      cancelHide();
      return;
    }
    candidate = img;
    if (!img) {
      scheduleHide();
      return;
    }
    consider(img);
  }

  async function consider(img) {
    if (!isCandidate(img)) {
      scheduleHide();
      return;
    }
    const animated = players.has(img) || (await isAnimated(srcOf(img)));
    if (candidate !== img || !enabled) return; // pointer moved on meanwhile
    if (animated) showButton(img);
    else scheduleHide();
  }

  function isCandidate(img) {
    if (!img.complete || !img.naturalWidth) return false;
    const box = img.getBoundingClientRect();
    return box.width >= MIN_SIZE && box.height >= MIN_SIZE;
  }

  // Everything under the pointer, top first, looking inside open shadow roots.
  function elementsAt(x, y) {
    let stack = document.elementsFromPoint(x, y);
    for (let depth = 0; depth < 8; depth++) {
      const root = stack[0]?.shadowRoot;
      if (!root || stack[0] === host) break;
      const inner = root.elementsFromPoint(x, y);
      if (!inner.length || inner[0] === stack[0]) break;
      stack = inner;
    }
    return stack;
  }

  // An <img> at the top of the stack, or just beneath a transparent overlay
  // that belongs to the same component (a common pattern for hover effects).
  function findImage(stack) {
    for (let i = 0; i < Math.min(stack.length, 4); i++) {
      const el = stack[i];
      if (el.localName !== "img") continue;
      let scope = el;
      for (let up = 0; up < 3 && scope.parentElement; up++) scope = scope.parentElement;
      return stack.slice(0, i).every((above) => scope.contains(above)) ? el : null;
    }
    return null;
  }

  document.addEventListener("pointermove", onPointer, { capture: true, passive: true });
  document.addEventListener("scroll", scheduleHover, { capture: true, passive: true });
  document.addEventListener("mouseout", (event) => {
    if (!event.relatedTarget) {
      candidate = null;
      scheduleHide(); // pointer left the window
    }
  });
})();
