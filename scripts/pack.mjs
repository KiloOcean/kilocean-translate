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

// Canonical ship-list entry name: posix separators, no duplicate separators,
// no "." segments. Absolute paths (unix /, windows drive / UNC), URL schemes
// and any ".." segment are rejected outright — a manifest or bundled
// reference must never name anything outside the extension root.
export function normalizeEntryName(rel, origin = "entry") {
  const raw = String(rel ?? "");
  const posix = raw.split(path.sep).join("/").replace(/\/+/g, "/").trim();
  if (
    posix === "" ||
    posix.startsWith("/") ||
    posix.startsWith("\\") ||
    /^[a-zA-Z]:/.test(posix) ||
    /^[a-z][a-z\d+\-.]*:/i.test(posix)
  ) {
    throw new Error(`pack: ${origin} must be a relative path inside the extension root, got: ${raw}`);
  }
  const parts = [];
  for (const part of posix.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new Error(`pack: ${origin} must not traverse outside the extension root (..): ${raw}`);
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new Error(`pack: ${origin} must name a file, got: ${raw}`);
  }
  return parts.join("/");
}

// Every shipped path must be a regular file (never a symlink — lstat, so the
// link itself is rejected even when it points back inside the root) whose
// realpath stays under the root's realpath, so neither a crafted manifest
// reference nor a swapped symlink can smuggle file contents from outside the
// extension root into the zip.
export function assertSafeRealFile(rootDir, rel) {
  const full = path.join(rootDir, rel);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    throw new Error(`pack: missing file: ${rel}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`pack: symlink must not ship: ${rel}`);
  }
  if (!stat.isFile()) {
    throw new Error(`pack: not a regular file: ${rel}`);
  }
  const rootReal = fs.realpathSync(rootDir);
  const fileReal = fs.realpathSync(full);
  if (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep)) {
    throw new Error(`pack: file resolves outside the extension root: ${rel}`);
  }
}

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
    // Normalize + validate at the single choke point every reference flows
    // through (manifest fields, html href/src, injected file lists): a path
    // that is absolute or climbs with .. never enters the ship list.
    const name = normalizeEntryName(rel, origin);
    if (!files.has(name)) {
      files.add(name);
      pending.push([name, origin]);
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
  // Validate before anything is read: a reference to a missing file, a
  // symlink, or a path whose realpath leaves the root fails the pack.
  while (pending.length > 0) {
    const [rel, origin] = pending.shift();
    try {
      assertSafeRealFile(rootDir, rel);
    } catch (error) {
      throw new Error(`pack: ${origin} references an unsafe or missing file: ${rel} (${error.message})`);
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
    // Defense in depth: entry names are re-normalized and every file is
    // lstat/realpath-checked right before it is read, so even a caller-supplied
    // list cannot zip a symlink or anything outside the root.
    const name = normalizeEntryName(rel, "zip entry");
    assertSafeRealFile(rootDir, name);
    return zipEntry(name, fs.readFileSync(path.join(rootDir, name)), when);
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

  writeZipSafely(outPath, rootDir, Buffer.concat([...parts, centralBuf, eocd]));
  return entries.map((entry) => entry.nameBuf.toString("utf8"));
}

// The dist directory must be a real directory inside the root (never a
// symlink — a swapped link could aim the output anywhere), a pre-existing
// output file must be a regular file (a symlink is unlinked, never followed,
// so the write cannot clobber whatever it points at), and the payload only
// ever lands via an O_EXCL temp file + rename, so a crash cannot leave a
// half-written zip in dist.
export function writeZipSafely(outPath, rootDir, data) {
  const distDir = path.dirname(outPath);
  fs.mkdirSync(distDir, { recursive: true });

  let distStat;
  try {
    distStat = fs.lstatSync(distDir);
  } catch (error) {
    throw new Error(`pack: cannot stat output directory ${distDir}: ${error.message}`);
  }
  if (distStat.isSymbolicLink()) {
    throw new Error(`pack: output directory must not be a symlink: ${distDir}`);
  }
  if (!distStat.isDirectory()) {
    throw new Error(`pack: output path's parent is not a directory: ${distDir}`);
  }
  const rootReal = fs.realpathSync(rootDir);
  const distReal = fs.realpathSync(distDir);
  if (distReal !== rootReal && !distReal.startsWith(rootReal + path.sep)) {
    throw new Error(`pack: output directory resolves outside the extension root: ${distDir}`);
  }

  const tempPath = path.join(
    distDir,
    `.${path.basename(outPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    // "wx" (O_EXCL): create-or-fail, so a plant at tempPath can never be
    // followed or overwritten — same trick assertSafeRealFile plays on reads.
    const fd = fs.openSync(tempPath, "wx");
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }

    let outStat = null;
    try {
      outStat = fs.lstatSync(outPath);
    } catch {
      // No destination yet — rename will create it.
    }
    if (outStat) {
      if (outStat.isSymbolicLink()) {
        // Replace the link itself; rename() would too, but unlinking first
        // makes "never follow" explicit and keeps the lstat/rename window
        // free of link targets entirely.
        fs.unlinkSync(outPath);
      } else if (!outStat.isFile()) {
        throw new Error(`pack: output path exists and is not a regular file: ${outPath}`);
      }
    }
    fs.renameSync(tempPath, outPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Temp file never got created, or the rename already consumed it.
    }
    throw error;
  }
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
