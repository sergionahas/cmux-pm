#!/usr/bin/env node
// Relays what worker sessions report to the PM session, so every result comes back to one chat.
// Every 10 s, for each worker spawn.sh registered in state/sessions.json: read its screen, find a final
// `STATUS: DONE|BLOCKED ...` line, and when it is new, log it and type one line into the PM:
//   [worker ABC-153] DONE https://github.com/...
// Only workspaces spawn.sh registered are tracked. Anything else cmux lists in the window (your own
// shells, other tools' workspaces) is ignored: never read, never added. Workers that disappear are
// moved to the closed list, like close.sh does. Closed workspaces are never read again.
// Runs in the background of the overview pane (cmux.sh). Log: state/watch.log.
import { say, screen, workspaces } from "./cmuxlib.mjs";
import { close, pm, sessions, upsert, event } from "./state.mjs";

const EVERY_MS = 10_000;

/** The last STATUS line on screen, with wrapped continuation lines joined. */
export function lastStatus(text) {
  const lines = (text ?? "").split("\n");
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[\s⏺●]*STATUS:\s*(DONE|BLOCKED)\b\s*(.*)$/);
    if (!m || m[2].startsWith("<")) continue; // `STATUS: DONE <PR url>` is the instruction, not a report
    let detail = m[2].trim();
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\s*[⏺❯─✻✽✶✳·]/.test(lines[j]); j++) {
      detail += " " + lines[j].trim();
    }
    found = { kind: m[1], detail: detail.trim() };
  }
  return found;
}

const busy = (text) => /esc to interrupt/.test(text ?? "");

async function tick() {
  const me = pm();
  if (!me) return;
  const list = await workspaces(me.window);
  if (!list) return;
  const known = sessions();
  const live = new Set();

  for (const { ref } of list) {
    if (ref === me.workspace) continue;
    live.add(ref);
    const s = known[ref];
    if (!s) continue; // not started by spawn.sh: not ours, never read or adopt it

    const text = await screen(ref);
    if (text === null || !sessions()[ref]) continue; // gone, or closed by close.sh while we read
    const status = lastStatus(text);
    const activity = busy(text) ? "busy" : "idle";
    if (status && (status.kind.toLowerCase() !== s.status || status.detail !== s.detail)) {
      upsert(ref, { status: status.kind.toLowerCase(), detail: status.detail, activity });
      event(`${status.kind} ${s.ticket}: ${status.detail}`);
      await say(me, `[worker ${s.ticket}] ${status.kind} ${status.detail}`);
    } else if (!status && s.status !== "working") {
      upsert(ref, { status: "working", detail: "", activity }); // got new input after reporting
    } else if (s.activity !== activity) {
      upsert(ref, { activity });
    }
  }

  // Workspaces that went away without close.sh: record them as closed too (close() re-reads state,
  // so one close.sh already handled is a no-op).
  for (const ref of Object.keys(known)) if (!live.has(ref)) close(ref);
}

if (process.argv[1]?.endsWith("watch.mjs")) {
  for (;;) {
    try { await tick(); } catch (e) { console.error(new Date().toISOString(), e); }
    await new Promise((r) => setTimeout(r, EVERY_MS));
  }
}
