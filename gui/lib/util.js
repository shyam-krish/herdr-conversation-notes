// Small helpers the Herdr app's script runtime lacks (no TextEncoder/TextDecoder),
// plus Python-compatible formatting so note keys match the TUI plugin exactly.

/** UTF-8 bytes for a string (surrogate pairs combined; lone surrogates as U+FFFD). */
export function utf8Encode(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

export class UnicodeError extends Error {}

/** Strict UTF-8 decode of bytes[start, end); throws UnicodeError like Python's decoder. */
export function utf8Decode(bytes, start = 0, end = bytes.length) {
  let out = "";
  let chunk = [];
  const flush = () => {
    if (chunk.length) {
      out += String.fromCharCode.apply(null, chunk);
      chunk = [];
    }
  };
  let i = start;
  while (i < end) {
    const b = bytes[i];
    let code, need, min;
    if (b < 0x80) { code = b; need = 0; min = 0; }
    else if (b >= 0xc2 && b <= 0xdf) { code = b & 31; need = 1; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { code = b & 15; need = 2; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { code = b & 7; need = 3; min = 0x10000; }
    else throw new UnicodeError("invalid UTF-8 start byte");
    if (need && i + need >= end) throw new UnicodeError("truncated UTF-8 sequence");
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) throw new UnicodeError("invalid UTF-8 continuation byte");
      code = (code << 6) | (c & 63);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new UnicodeError("invalid UTF-8 code point");
    }
    i += need + 1;
    if (code >= 0x10000) {
      code -= 0x10000;
      chunk.push(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
    } else chunk.push(code);
    if (chunk.length >= 8192) flush();
  }
  flush();
  return out;
}

/** sha256 hex of the UTF-8 encoding, as Python's hashlib.sha256(value.encode()). */
export async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", utf8Encode(value));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * json.dumps(value, ensure_ascii=False) for the shapes this plugin hashes or sends:
 * strings, numbers, booleans, null, arrays and plain objects, with Python's default
 * ", " and ": " separators. JSON.stringify escapes strings the same way.
 */
export function pyDumps(value) {
  if (Array.isArray(value)) return "[" + value.map(pyDumps).join(", ") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ": " + pyDumps(v)).join(", ") + "}";
  }
  return JSON.stringify(value);
}

/** Python's str.splitlines() boundaries. */
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
export function splitlines(text) {
  if (!text) return [];
  const lines = text.split(LINE_BREAKS);
  if (lines.length && lines[lines.length - 1] === "" && LINE_BREAKS.test(text.slice(-2))) lines.pop();
  return lines;
}

/** Python's str.isprintable() per character (space is printable). */
let UNPRINTABLE;
try {
  UNPRINTABLE = new RegExp("[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}]|(?! )\\p{Zs}", "u");
} catch {
  // A runtime without Unicode property escapes still drops control characters.
  UNPRINTABLE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
}
export function printableOnly(text) {
  return Array.from(text).filter((c) => !UNPRINTABLE.test(c)).join("");
}

/** Python's " ".join(text.split()). */
export function collapseSpace(text) {
  return text.split(/[\s\x1c-\x1f\x85]+/u).filter(Boolean).join(" ");
}

export function basename(path) {
  const parts = String(path).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1];
}

export function dirname(path) {
  const trimmed = String(path).replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at <= 0 ? "/" : trimmed.slice(0, at);
}

export function isAbsolute(path) {
  return typeof path === "string" && path.startsWith("/");
}

/** A Python-style time.time() float. */
export function nowSeconds() {
  return Date.now() / 1000;
}
