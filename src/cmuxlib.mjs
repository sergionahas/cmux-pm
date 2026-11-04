// Thin wrappers over the cmux CLI. cmux only takes commands from its own terminals.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "./config.mjs";

const run = promisify(execFile);
export const CMUX = config.cmuxBin;
const env = { ...process.env, CMUX_QUIET: "1" };

export async function cmux(...args) {
  try { return (await run(CMUX, args, { timeout: 8_000, env, maxBuffer: 4 << 20 })).stdout; } catch { return null; }
}

/** Workspaces in a window: [{ ref, name }]. */
export async function workspaces(window) {
  const out = await cmux("workspace", "list", ...(window ? ["--window", window] : []));
  if (out === null) return null;
  return out.split("\n").map((l) => l.match(/(workspace:\d+)\s+(.*?)(\s+\[selected\])?\s*$/))
    .filter(Boolean).map((m) => ({ ref: m[1], name: m[2].trim() }));
}

export const screen = (ws, lines = 60) => cmux("read-screen", "--workspace", ws, "--lines", String(lines));

/** Types a line into a surface (a Claude Code prompt) and submits it. */
export async function say(target, text) {
  const where = ["--workspace", target.workspace, "--surface", target.surface];
  if ((await cmux("send", ...where, text)) === null) return false;
  await new Promise((r) => setTimeout(r, 300));
  return (await cmux("send-key", ...where, "Enter")) !== null;
}
