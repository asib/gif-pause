// Helpers shared by the content script and the background worker for
// working with raw image files.

// How much of a file to read before giving up on deciding whether it's
// animated. The answer is almost always in the first few hundred bytes.
const SNIFF_LIMIT = 256 * 1024;

// Works out from a file's leading bytes what kind of image it is and whether
// it's animated. `animated` is true or false, or null if more bytes are
// needed. Pass `final` when no more bytes are coming (the whole file, or as
// much as we're willing to read).
function sniffImage(bytes, final = false) {
  const ascii = (at, len) => String.fromCharCode(...bytes.subarray(at, at + len));

  if (bytes.length < 12) return { type: null, animated: final ? false : null };
  if (ascii(0, 4) === "GIF8") {
    return { type: "image/gif", animated: gifAnimated(bytes, final) };
  }
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
    return { type: "image/png", animated: pngAnimated(bytes, final) };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return { type: "image/webp", animated: webpAnimated(bytes, final) };
  }
  if (ascii(4, 4) === "ftyp") return avifInfo(bytes, final);
  return { type: null, animated: false };
}

// A GIF is animated if it has more than one image block. When we run out of
// bytes before seeing a second one, a looping extension is a good hint.
function gifAnimated(b, final) {
  let pos = 13;
  if (b[10] & 0x80) pos += 3 << ((b[10] & 7) + 1); // global color table
  let frames = 0;
  let loops = false;

  const skipSubBlocks = () => {
    while (pos < b.length) {
      const size = b[pos++];
      if (size === 0) return true;
      pos += size;
    }
    return false;
  };

  while (pos < b.length) {
    const block = b[pos];
    if (block === 0x3b) return frames > 1; // trailer
    if (block === 0x21) {
      // Extension; NETSCAPE2.0 / ANIMEXTS1.0 carry the loop count.
      if (b[pos + 1] === 0xff && b[pos + 2] === 11 && pos + 14 <= b.length) {
        const id = String.fromCharCode(...b.subarray(pos + 3, pos + 14));
        if (id === "NETSCAPE2.0" || id === "ANIMEXTS1.0") loops = true;
      }
      pos += 2;
      if (!skipSubBlocks()) break;
    } else if (block === 0x2c) {
      if (++frames > 1) return true;
      if (pos + 10 > b.length) break;
      const flags = b[pos + 9];
      pos += 10;
      if (flags & 0x80) pos += 3 << ((flags & 7) + 1); // local color table
      pos += 1; // LZW minimum code size
      if (!skipSubBlocks()) break;
    } else {
      return frames > 1; // malformed; go with what we've seen
    }
  }
  return final ? frames > 1 || loops : null;
}

// APNG puts an acTL chunk before the first IDAT.
function pngAnimated(b, final) {
  const u32 = (at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  let pos = 8;
  while (pos + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(pos + 4, pos + 8));
    if (type === "acTL") return pos + 12 <= b.length ? u32(pos + 8) > 1 : final ? false : null;
    if (type === "IDAT" || type === "IEND") return false;
    pos += 12 + u32(pos);
  }
  return final ? false : null;
}

// Animated WebP uses the extended (VP8X) format with the animation flag set.
function webpAnimated(b, final) {
  if (b.length < 21) return final ? false : null;
  if (String.fromCharCode(...b.subarray(12, 16)) !== "VP8X") return false;
  return (b[20] & 0x02) !== 0;
}

// AVIF image sequences declare the "avis" brand in their ftyp box.
function avifInfo(b, final) {
  const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  if (size > b.length) return { type: null, animated: final ? false : null };
  const brands = new Set();
  for (let at = 8; at + 4 <= size; at += 4) {
    if (at !== 12) brands.add(String.fromCharCode(...b.subarray(at, at + 4))); // 12..16 is the minor version
  }
  if (!brands.has("avif") && !brands.has("avis")) return { type: null, animated: false };
  return { type: "image/avif", animated: brands.has("avis") };
}

// Reads just enough of a response to sniff it, then drops the rest.
async function sniffResponse(response, limit = SNIFF_LIMIT) {
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        const joined = new Uint8Array(bytes.length + value.length);
        joined.set(bytes);
        joined.set(value, bytes.length);
        bytes = joined;
      }
      const final = done || bytes.length >= limit;
      const result = sniffImage(bytes, final);
      if (result.animated !== null || final) return result;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// Extension messages are JSON, so bytes travel as base64.
function toBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
