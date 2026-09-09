#!/usr/bin/env node
/**
 * Zero-dependency AI-native CI gate for kilocean-translate.
 * Exit non-zero with clear messages on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ALLOWED_PERMISSIONS = new Set(["activeTab", "scripting", "storage"]);
const ALLOWED_HOST = "https://api.deepseek.com/*";
const JS_FILES = ["background.js", "content.js", "popup.js", "shared.js"];
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const errors = [];

function fail(msg) {
  errors.push(msg);
}

function readJson(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    fail(`missing file: ${rel}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    fail(`invalid JSON ${rel}: ${error.message}`);
    return null;
  }
}

function checkManifest() {
  const manifest = readJson("manifest.json");
  if (!manifest) {
    return;
  }

  if (manifest.manifest_version !== 3) {
    fail(`manifest_version must be 3, got ${JSON.stringify(manifest.manifest_version)}`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    fail("manifest.name is required");
  }
  if (typeof manifest.version !== "string" || !SEMVER_RE.test(manifest.version)) {
    fail(`manifest.version must be semver-ish X.Y.Z, got ${JSON.stringify(manifest.version)}`);
  }
  if (!manifest.background?.service_worker) {
    fail("manifest.background.service_worker is required");
  }
  if (!manifest.action?.default_popup) {
    fail("manifest.action.default_popup is required");
  }

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const perm of permissions) {
    if (!ALLOWED_PERMISSIONS.has(perm)) {
      fail(`disallowed permission: ${perm} (allowlist: ${[...ALLOWED_PERMISSIONS].join(", ")})`);
    }
  }
  for (const required of ALLOWED_PERMISSIONS) {
    if (!permissions.includes(required)) {
      fail(`missing required permission: ${required}`);
    }
  }

  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  if (hosts.length === 0) {
    fail("host_permissions must include https://api.deepseek.com/*");
  }
  for (const host of hosts) {
    if (host !== ALLOWED_HOST && !host.startsWith("https://api.deepseek.com/")) {
      fail(`disallowed host_permission: ${host} (only https://api.deepseek.com/* allowed)`);
    }
  }
}

function stripCommentsForScan(source) {
  // Remove block comments and line comments so we do not false-positive on them.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => `${p1}${" ".repeat(m.length - p1.length)}`);
}

function checkSyntax(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    fail(`missing JS file: ${rel}`);
    return;
  }

  const result = spawnSync(process.execPath, ["--check", full], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim() || `exit ${result.status}`;
    fail(`syntax check failed for ${rel}: ${detail}`);
  }
}

function checkStaticBans(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    return;
  }
  const raw = fs.readFileSync(full, "utf8");
  const source = stripCommentsForScan(raw);

  if (/\beval\s*\(/.test(source)) {
    fail(`${rel}: forbidden pattern eval(`);
  }
  if (/\bnew\s+Function\s*\(/.test(source)) {
    fail(`${rel}: forbidden pattern new Function(`);
  }

  // Flag chrome.scripting.executeScript({ ... world: "MAIN" ... }) as unsafe.
  // Only when world MAIN is clearly present near executeScript usage.
  const execRe = /chrome\.scripting\.executeScript\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let match;
  while ((match = execRe.exec(source)) !== null) {
    const opts = match[1];
    if (/\bworld\s*:\s*['"]MAIN['"]/.test(opts)) {
      fail(`${rel}: forbidden chrome.scripting.executeScript with world MAIN`);
    }
  }
}

function main() {
  console.log("kilocean-translate ci-check");
  console.log(`root: ${ROOT}`);

  checkManifest();

  for (const file of JS_FILES) {
    checkSyntax(file);
    checkStaticBans(file);
  }

  if (errors.length > 0) {
    console.error("\nCI CHECK FAILED:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log("OK: manifest, permissions, syntax, static bans");
  process.exit(0);
}

main();
