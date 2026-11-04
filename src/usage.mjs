// Claude usage for the overview: plan limits (what `/usage` in Claude Code shows) and per-worker tokens.
//  - Plan limits: GET api.anthropic.com/api/oauth/usage, the endpoint Claude Code calls for /usage, with the
//    OAuth token Claude Code keeps in the macOS Keychain ("Claude Code-credentials"), or in
//    ~/.claude/.credentials.json where there is no Keychain. The token is only
//    read into memory and sent in that one header; it is never logged or written. The answer (no
//    credentials in it) is cached in state/usage.json and fetched at most once a minute, failures included.
//  - Worker tokens: ~/.claude/sessions/<pid>.json names each live Claude Code session ("ABC-141 Some
//    title", from spawn.sh's -n) and its sessionId and cwd; the transcript is
//    ~/.claude/projects/<cwd with / and . as ->/<sessionId>.jsonl. Read incrementally, deduped by message id.
import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { STATE } from "./state.mjs";

const run = promisify(execFile);
const CACHE = join(STATE, "usage.json");
const MIN_MS = 60_000;

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };

let usage = readJson(CACHE, null); // { at, ok, limits?: [{ label, percent, resets_at }], error? }
let inflight = null;

async function credentials() {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5_000 });
      return stdout;
    } catch {}
  }
  return readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
}

async function token() {
  let o;
  try { o = JSON.parse(await credentials()).claudeAiOauth; } catch { throw new Error("no Claude Code login"); }
  if (!o?.accessToken) throw new Error("no Claude Code login");
  if (o.expiresAt && o.expiresAt < Date.now()) throw new Error("login expired");
  return o.accessToken;
}

const LABEL = { session: "Session 5h", weekly_all: "Week all" };
function limitsFrom(d) {
  if (Array.isArray(d.limits)) {
    return d.limits.map((l) => ({
      label: LABEL[l.kind] ?? `Week ${l.scope?.model?.display_name ?? l.kind}`,
      percent: Number(l.percent) || 0,
      resets_at: l.resets_at,
    }));
  }
  // Older shape: five_hour / seven_day / seven_day_<model>
  return Object.entries(d)
    .filter(([k, v]) => v && typeof v.utilization === "number" && (k === "five_hour" || k.startsWith("seven_day")))
    .map(([k, v]) => ({
      label: k === "five_hour" ? LABEL.session : k === "seven_day" ? LABEL.weekly_all : `Week ${k.slice(10)}`,
      percent: v.utilization, resets_at: v.resets_at,
    }));
}

/** Refreshes the plan limits if the cache is older than a minute. Never throws. */
export function refreshUsage() {
  if (inflight) return inflight;
  usage = readJson(CACHE, usage); // another overview process may have fetched it
  if (usage && Date.now() - usage.at < MIN_MS) return Promise.resolve();
  inflight = (async () => {
    let next;
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${await token()}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      next = { at: Date.now(), ok: true, limits: limitsFrom(await res.json()) };
    } catch (e) {
      // Keep the last good numbers, marked stale; retry after a minute.
      next = { ...(usage?.ok ? usage : {}), at: Date.now(), ok: false, error: String(e?.message ?? e).slice(0, 60) };
    }
    usage = next;
    try { writeFileSync(CACHE + ".tmp", JSON.stringify(usage)); renameSync(CACHE + ".tmp", CACHE); } catch {}
  })().finally(() => { inflight = null; });
  return inflight;
}

export const usageState = () => usage;

// ---- per-worker tokens ----

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const files = new Map(); // path -> { offset, ids: Set, total, out }

function scan(path) {
  let f = files.get(path);
  if (!f) files.set(path, (f = { offset: 0, ids: new Set(), total: 0, out: 0 }));
  let size;
  try { size = statSync(path).size; } catch { return f; }
  if (size < f.offset) Object.assign(f, { offset: 0, ids: new Set(), total: 0, out: 0 });
  if (size === f.offset) return f;
  const buf = Buffer.alloc(size - f.offset);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, buf.length, f.offset); } finally { closeSync(fd); }
  const end = buf.lastIndexOf(10); // only whole lines
  if (end < 0) return f;
  f.offset += end + 1;
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    let m;
    try { m = JSON.parse(line).message; } catch { continue; }
    const u = m?.usage;
    if (!u || !m.id || f.ids.has(m.id)) continue;
    f.ids.add(m.id);
    f.out += u.output_tokens ?? 0;
    f.total += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  return f;
}

/** { [ticket]: { total, out } } for live Claude Code sessions named "<ticket> …". */
export function workerTokens(tickets) {
  const want = new Set(tickets.filter(Boolean));
  const out = {};
  let names;
  try { names = readdirSync(SESSIONS_DIR).filter((n) => n.endsWith(".json")); } catch { return out; }
  for (const n of names) {
    const s = readJson(join(SESSIONS_DIR, n), null);
    const ticket = s?.name?.split(" ")[0];
    if (!s?.sessionId || !s.cwd || !want.has(ticket)) continue;
    const f = scan(join(PROJECTS_DIR, s.cwd.replace(/[/.]/g, "-"), `${s.sessionId}.jsonl`));
    const t = (out[ticket] ??= { total: 0, out: 0 });
    t.total += f.total; t.out += f.out;
  }
  return out;
}

export function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
