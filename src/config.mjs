#!/usr/bin/env node
// Reads staffer.config.json, which sits next to this file (init writes it there).
//   node config.mjs get <key>       print one value (arrays one per line); used by the shell scripts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME_DIR = dirname(fileURLToPath(import.meta.url));
const LEGACY = join(HOME_DIR, "pm.config.json"); // name before the rename; rerun init to migrate
export const CONFIG_PATH = !existsSync(join(HOME_DIR, "staffer.config.json")) && existsSync(LEGACY) ? LEGACY : join(HOME_DIR, "staffer.config.json");

export const DEFAULTS = {
  project: "My project",
  workdir: homedir(),
  repos: [],
  ticketPrefix: "",
  tracker: "",
  owner: "the user",
  skill: "project-pm",
  workspaceName: "ADMIN",
  workerRules: "worker-rules.md",
  claudeArgs: ["--permission-mode", "bypassPermissions"],
  cmuxBin: "/Applications/cmux.app/Contents/Resources/bin/cmux",
};

const expand = (p) => (typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`${CONFIG_PATH}: ${e.message}`);
  }
  const c = { ...DEFAULTS, ...raw };
  c.workdir = expand(c.workdir);
  c.cmuxBin = process.env.CMUX_BIN || expand(c.cmuxBin);
  c.workerRules = resolve(HOME_DIR, expand(c.workerRules));
  return c;
}

export const config = loadConfig();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, key] = process.argv.slice(2);
  if (cmd !== "get" || !key || !(key in config)) {
    console.error("usage: config.mjs get <key>");
    process.exit(2);
  }
  const v = config[key];
  console.log(Array.isArray(v) ? v.join("\n") : String(v));
}
