#!/usr/bin/env node
// Relays what worker sessions report to the PM session, so every result comes back to one chat.
// Every 10 s, for each workspace in the PM's cmux window: read its screen, find a final
// `STATUS: DONE|BLOCKED ...` line, and when it is new, log it and type one line into the PM:
//   [worker ABC-153] DONE https://github.com/...
// Also notices workers that start (any new workspace) or disappear (moved to the closed list, like
// close.sh does). Closed workspaces are never read again.
// Runs in the background of the overview pane (cmux.sh). Log: state/watch.log.
import { cmux, say, screen, workspaces } from "./cmuxlib.mjs";
import { config } from "./config.mjs";
import { close, pm, recentlyClosed, sessions, upsert, event } from "./state.mjs";

const EVERY_MS = 10_000;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TICKET = config.ticketPrefix
  ? new RegExp(`\\b(${esc(config.ticketPrefix)}-\\d+)\\b`)
  : /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

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
  const gone = recentlyClosed(); // closed by close.sh; cmux may still list them for a moment
  const live = new Set();

  for (const { ref, name } of list) {
    if (ref === me.workspace) continue;
    live.add(ref);
    if (!known[ref] && gone.has(ref)) continue; // closed: don't read its screen or re-add it
    const ticket = name.match(TICKET)?.[1] ?? ref;
    const title = name.replace(/^[^\w]*/, "").replace(TICKET, "").replace(/^[\s·:-]+/, "").trim() || name;
    let s = known[ref];
    if (!s) {
      s = upsert(ref, { ticket, title, status: "working", detail: "", started: new Date().toISOString() });
      event(`seen ${ticket} · ${title} (${ref})`);
    }

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
