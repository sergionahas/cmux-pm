#!/usr/bin/env node
// Shared state for the PM workspace: who the workers are, what they last reported, and an event log.
//   node state.mjs add <workspace> <ticket> <title>     (spawn.sh)
//   node state.mjs event <text>                         (append a line to the log)
//   node state.mjs close <workspace>                    (close.sh: move the session to the closed list)
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ADMIN = dirname(fileURLToPath(import.meta.url));
export const STATE = join(ADMIN, "state");
const SESSIONS = join(STATE, "sessions.json");
const EVENTS = join(STATE, "events.log");
const CLOSED = join(STATE, "closed.json");
export const PM = join(STATE, "pm.json");
mkdirSync(STATE, { recursive: true });

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const writeJson = (p, v) => { writeFileSync(p + ".tmp", JSON.stringify(v, null, 2)); renameSync(p + ".tmp", p); };

export const sessions = () => readJson(SESSIONS, {});
export const saveSessions = (s) => writeJson(SESSIONS, s);
export const pm = () => readJson(PM, null);
export const savePm = (v) => writeJson(PM, v);

export function event(text) {
  appendFileSync(EVENTS, `${new Date().toISOString()} ${text.replace(/\s+/g, " ").trim()}\n`);
}
export function events(n = 12) {
  if (!existsSync(EVENTS)) return [];
  return readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean).slice(-n)
    .map((l) => ({ at: l.slice(0, l.indexOf(" ")), text: l.slice(l.indexOf(" ") + 1) }));
}

// Closed sessions: [{ ref, ticket, title, status, result, started, closed }], newest last. Kept in their own
// file, not under their workspace ref in sessions.json, because cmux reuses refs for new workspaces.
export const closedSessions = () => readJson(CLOSED, []);
const KEEP_MS = 7 * 86_400_000;

/** Moves an open session to the closed list, keeping its last result. Returns the record, or null if
 *  there was no open session for that workspace (already closed, or never tracked). */
export function close(ws) {
  const s = sessions();
  const cur = s[ws];
  if (!cur || cur.status === "closed") return null;
  const rec = {
    ref: ws, ticket: cur.ticket ?? ws, title: cur.title ?? "", status: cur.status,
    result: cur.detail || "", started: cur.started, closed: new Date().toISOString(),
  };
  delete s[ws];
  saveSessions(s);
  writeJson(CLOSED, [...closedSessions().filter((c) => Date.now() - Date.parse(c.closed) < KEEP_MS), rec]);
  event(`closed ${rec.ticket} (${ws})${rec.status === "done" ? "" : ` while ${rec.status}`}`);
  return rec;
}

/** Workspaces closed in the last `ms`: cmux can still list them for a moment after close. */
export const recentlyClosed = (ms = 60_000) =>
  new Set(closedSessions().filter((c) => Date.now() - Date.parse(c.closed) < ms).map((c) => c.ref));

export function upsert(ws, patch) {
  const s = sessions();
  s[ws] = { ...(s[ws] ?? { started: new Date().toISOString(), status: "working" }), ...patch, updated: new Date().toISOString() };
  saveSessions(s);
  return s[ws];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "add") {
    const [ws, ticket, title] = args;
    upsert(ws, { ticket, title, status: "working", started: new Date().toISOString(), detail: "" });
    event(`started ${ticket} · ${title} (${ws})`);
  } else if (cmd === "close") {
    const rec = close(args[0]);
    console.log(rec ? `closed ${rec.ticket} (${args[0]})` : `no open session for ${args[0]}`);
  } else if (cmd === "event") {
    event(args.join(" "));
  } else {
    console.error("usage: state.mjs add <ws> <ticket> <title> | close <ws> | event <text>");
    process.exit(2);
  }
}
