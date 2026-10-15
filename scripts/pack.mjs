#!/usr/bin/env node
/**
 * Pack the extension into dist/kilocean-translate-<version>.zip.
 *
 * Pure Node (no third-party deps, no system zip): entries are deflate-packed
 * via node:zlib with a hand-rolled ZIP container (local headers + central
 * directory + EOCD). The file list is derived from manifest.json references —
 * background service worker, action popup (+ the js/css its html references),
 * content scripts, icons, web_accessible_resources — plus the
 * chrome.scripting.executeScript file lists found in bundled scripts.
 * Anything else (.git, tests, scripts, promo, selftest, docs, node_modules,
 * .env, …) can never be referenced and is rejected defensively.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

// Paths that must never end up inside the shipped zip.
export const EXCLUDED_PREFIXES = [
  ".git/",
  ".github/",
  "dist/",
  "docs/",
  "node_modules/",
  "promo/",
  "scripts/",
  "selftest/",
  "tests/",
  "test/"
];
export const EXCLUDED_NAMES = [
  ".DS_Store",
  "AGENTS.md",
  "README.md"
];
export const EXCLUDED_NAME_PREFIXES = [".env"];

const toPosix = (rel) => rel.split(path.sep).join("/");
const isLocalReference = (value) =>
  Boolean(value) &&
  !/^[a-z][a-z\d+\-.]*:/i.test(value) && // http:, data:, mailto:, …
  !value.startsWith("//") &&
  !value.startsWith("#") &&
  !value.startsWith("/");

function readManifest(rootDir) {
  const manifestPath = path.join(rootDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`pack: manifest.json not found at ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`pack: manifest.json is not valid JSON: ${error.message}`);
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`pack: manifest.version must be X.Y.Z, got ${JSON.stringify(manifest.version)}`);
  }
  return manifest;
}

// Additional files referenced by an html page we already ship: stylesheets,
// scripts and other local href/src targets (icons referenced inline, …).
function collectHtmlReferences(rootDir, htmlRel, add) {
  const html = fs.readFileSync(path.join(rootDir, htmlRel), "utf8");
  const baseDir = path.dirname(htmlRel);
  for (const tag of html.matchAll(/<(?:link|script|img)\b[^>]*>/gi)) {
    for (const attr of ["href", "src"]) {
      const match = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag[0]);
      if (!match || !isLocalReference(match[1])) {
        continue;
      }
      const ref = toPosix(path.join(baseDir, decodeURIComponent(match[1])))
        // Guard against href="/" / href="./" resolving to a directory.
        .replace(/\/\.$/, "")
        .replace(/^\.$/, "");
      if (ref) {
        add(ref, `referenced by ${htmlRel}`);
      }
    }
  }
}

// chrome.scripting.executeScript({ files: ["shared.js", "content.js"] }) —
// the injection file lists live in script source, not the manifest.
function collectScriptFileLists(rootDir, jsRel, add) {
  const source = fs.readFileSync(path.join(rootDir, jsRel), "utf8");
  for (const list of source.matchAll(/files\s*:\s*\[([^\]]*)\]/g)) {
    for (const item of list[1].matchAll(/["']([^"']+)["']/g)) {
      if (isLocalReference(item[1])) {
        add(toPosix(item[1]), `injected by ${jsRel}`);
      }
    }
  }
}

/**
 * Derive the exact ship list from manifest references.
 * @param {string} rootDir extension root (repo root)
 * @returns {{ files: string[], version: string }} posix-relative, sorted
 */
export function collectExtensionFiles(rootDir = ROOT) {
  const manifest = readManifest(rootDir);
  const files = new Set();
  const pending = [];

  const add = (rel, origin) => {
    if (!rel || rel.endsWith("/")) {
      return;
    }
    if (!files.has(rel)) {
      files.add(rel);
      pending.push([rel, origin]);
    }
  };

  add("manifest.json", "the manifest itself");
  if (manifest.background?.service_worker) {
    add(toPosix(manifest.background.service_worker), "manifest background.service_worker");
  }
  const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
  if (popup) {
    add(toPosix(popup), "manifest action.default_popup");
  }
  for (const script of manifest.content_scripts || []) {
    for (const js of script.js || []) {
      add(toPosix(js), "manifest content_scripts.js");
    }
    for (const css of script.css || []) {
      add(toPosix(css), "manifest content_scripts.css");
    }
  }
  const iconEntries = [
    ...(manifest.icons ? Object.values(manifest.icons) : []),
    ...(manifest.action?.default_icon
      ? Object.values(manifest.action.default_icon)
      : []),
    ...(manifest.browser_action?.default_icon
      ? Object.values(manifest.browser_action.default_icon)
      : [])
  ];
  for (const icon of iconEntries) {
    add(toPosix(icon), "manifest icons");
  }
  const war = manifest.web_accessible_resources || [];
  const warFiles = Array.isArray(war)
    ? (typeof war[0] === "string"
        ? war
        : war.flatMap((entry) => (entry && Array.isArray(entry.resources) ? entry.resources : [])))
    : [];
  for (const resource of warFiles) {
    add(toPosix(resource), "manifest web_accessible_resources");
  }

  // Walk the reference graph: html pulls css/js, js pulls injected file lists.
  while (pending.length > 0) {
    const [rel, origin] = pending.shift();
    const full = path.join(rootDir, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`pack: ${origin} references missing file: ${rel}`);
    }
    if (rel.endsWith(".html") || rel.endsWith(".htm")) {
      collectHtmlReferences(rootDir, rel, add);
    } else if (rel.endsWith(".js") || rel.endsWith(".mjs") || rel.endsWith(".cjs")) {
      collectScriptFileLists(rootDir, rel, add);
    }
  }

  assertNoExcludedFiles([...files]);
  return { files: [...files].sort(), version: manifest.version };
}

/** Throw when a ship list contains anything that must never ship. */
export function assertNoExcludedFiles(files) {
  for (const rel of files) {
    if (EXCLUDED_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) {
      throw new Error(`pack: excluded path must not ship: ${rel}`);
    }
    if (EXCLUDED_NAMES.includes(rel)) {
      throw new Error(`pack: excluded file must not ship: ${rel}`);
    }
    if (EXCLUDED_NAME_PREFIXES.some((prefix) => path.posix.basename(rel).startsWith(prefix))) {
      throw new Error(`pack: excluded file pattern must not ship: ${rel}`);
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

function zipEntry(name, data, when) {
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  // Store is smaller for already-compressed payloads (png).
  const useDeflate = compressed.length < data.length;
  const payload = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0;
  const { time, day } = dosDateTime(when);

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra len
  nameBuf.copy(local, 30);

  return { local, payload, nameBuf, crc, method, time, day, compSize: payload.length, uncompSize: data.length };
}

/**
 * Build the zip at outPath from the given posix-relative file list.
 * @returns {string[]} the shipped entry names
 */
export function buildZip(outPath, rootDir, files, when = new Date()) {
  const entries = files.map((rel) => {
    const full = path.join(rootDir, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new Error(`pack: cannot zip missing file: ${rel}`);
    }
    return zipEntry(rel, fs.readFileSync(full), when);
  });

  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    parts.push(entry.local, entry.payload);
    const cd = Buffer.alloc(46 + entry.nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: unix, spec 3.0
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // UTF-8 names
    cd.writeUInt16LE(entry.method, 10);
    cd.writeUInt16LE(entry.time, 12);
    cd.writeUInt16LE(entry.day, 14);
    cd.writeUInt32LE(entry.crc, 16);
    cd.writeUInt32LE(entry.compSize, 20);
    cd.writeUInt32LE(entry.uncompSize, 24);
    cd.writeUInt16LE(entry.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r--
    cd.writeUInt32LE(offset, 42);
    entry.nameBuf.copy(cd, 46);
    central.push(cd);
    offset += entry.local.length + entry.payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([...parts, centralBuf, eocd]));
  return entries.map((entry) => entry.nameBuf.toString("utf8"));
}

/** Parse a zip's central directory (for verification). */
export function listZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) {
    throw new Error("pack: zip has no EOCD record");
  }
  const count = buf.readUInt16LE(eocdAt + 10);
  let cursor = buf.readUInt32LE(eocdAt + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`pack: zip central directory entry ${i} is corrupt`);
    }
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    entries.push({ name, method, crc, compSize, uncompSize, localOffset });
    cursor += 46 + nameLen;
  }
  return entries;
}

/** Read + inflate one entry back (verification). */
export function readZipEntry(zipPath, entry) {
  const buf = fs.readFileSync(zipPath);
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  const data = entry.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
  if (data.length !== entry.uncompSize || crc32(data) !== entry.crc) {
    throw new Error(`pack: zip entry failed CRC/size verification: ${entry.name}`);
  }
  return data;
}

export function pack(rootDir = ROOT) {
  const { files, version } = collectExtensionFiles(rootDir);
  const outPath = path.join(rootDir, "dist", `kilocean-translate-${version}.zip`);
  buildZip(outPath, rootDir, files);
  return { outPath, files, version };
}

const invokedAsScript = (() => {
  const argvEntry = process.argv[1];
  if (!argvEntry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(path.resolve(argvEntry)).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  const { outPath, files, version } = pack();
  console.log(`kilocean-translate ${version} → ${path.relative(process.cwd(), outPath) || outPath}`);
  for (const rel of files) {
    console.log(`  + ${rel}`);
  }
  console.log(`${files.length} files packed.`);
}
