#!/usr/bin/env node
// The overview: the left pane of the cmux PM workspace. Every worker session, what it last
// reported, the recent events, open PRs, and what was closed in the last 24 h.
// Redraws every 3 s. Read-only.
//   node overview.mjs          live
//   node overview.mjs --once   print once and exit
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "./config.mjs";
import { closedSessions, events, sessions } from "./state.mjs";
import { fmtTokens, refreshUsage, usageState, workerTokens } from "./usage.mjs";

const run = promisify(execFile);
const REPOS = config.repos;
const c = { dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", gray: "\x1b[90m", reset: "\x1b[0m" };
const paint = (k, s) => `${c[k]}${s}${c.reset}`;
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const clip = (s, n) => (visible(s).length <= n ? s : visible(s).slice(0, Math.max(0, n - 1)) + "…");
const pad = (s, n) => s + " ".repeat(Math.max(0, n - visible(s).length));
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "?";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

let prs = [], prsAt = 0;
async function refreshPrs() {
  if (Date.now() - prsAt < 60_000) return;
  prsAt = Date.now();
  const all = await Promise.all(REPOS.map(async (repo) => {
    try {
      const { stdout } = await run("gh", ["pr", "list", "-R", repo, "--json", "number,title,headRefName,updatedAt"], { timeout: 15_000 });
      return JSON.parse(stdout).map((p) => ({ ...p, repo: repo.split("/")[1] }));
    } catch { return []; }
  }));
  prs = all.flat();
}

/** "in 3h 40m" under a day, else "Mon 10:00" local. */
function resetsIn(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  if (m < 1440) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return new Date(Math.round(Date.parse(iso) / 60_000) * 60_000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** USAGE: one bar per plan limit, as /usage shows them. */
function usageSection(W) {
  const u = usageState();
  const head = paint("bold", "USAGE");
  if (!u?.limits?.length) return [`${head} ${paint("yellow", "usage unavailable")}${u?.error ? paint("dim", ` · ${u.error}`) : ""}`];
  const stale = u.ok ? "" : paint("yellow", ` · stale ${ago(new Date(u.at).toISOString())}${u.error ? `, ${u.error}` : ""}`);
  const out = [`${head} ${paint("dim", "Claude plan limits")}${stale}`];
  const barW = Math.max(10, Math.min(30, W - 40));
  for (const l of u.limits) {
    const p = Math.max(0, Math.min(100, l.percent));
    const fill = Math.round((p / 100) * barW);
    const color = p >= 90 ? "red" : p >= 70 ? "yellow" : "green";
    const bar = paint(color, "█".repeat(fill)) + paint("gray", "░".repeat(barW - fill));
    out.push(clip(`  ${pad(l.label, 12)} ${bar} ${pad(paint(color, `${Math.round(l.percent)}%`), 4)} ${paint("dim", `resets ${resetsIn(l.resets_at)}`)}`, W));
  }
  return out;
}

const ICON = { working: ["●", "blue"], done: ["✓", "green"], blocked: ["!", "red"], closed: ["·", "gray"] };

const DAY_MS = 86_400_000;

/** The DONE · last 24h section: sessions closed in the last day, newest first. */
function doneSection(W) {
  const rows = closedSessions().filter((c) => Date.now() - Date.parse(c.closed) < DAY_MS).reverse();
  const out = [`${paint("bold", "DONE")} ${paint("dim", `· last 24h · ${rows.length}`)}`];
  if (!rows.length) out.push(paint("dim", "  nothing closed yet"));
  for (const r of rows) {
    const [icon, color] = r.status === "done" ? ["✓", "green"] : ["·", "gray"];
    const result = r.status === "done" ? (r.result || "done") : `closed while ${r.status}${r.result ? `: ${r.result}` : ""}`;
    out.push(clip(`  ${paint(color, icon)} ${paint("dim", pad(ago(r.closed), 4))} ${pad(paint("bold", r.ticket), 9)} ${r.title}`, W));
    out.push(clip(`      ${paint(r.status === "done" ? "green" : "dim", result)}`, W));
  }
  return out;
}

/** Lines to draw. With `rows`, clipped to a screen that tall. */
function render(rows) {
  const W = Math.max(40, process.stdout.columns || 80);
  const out = [];
  out.push(`${paint("bold", config.workspaceName)} ${paint("dim", `· ${config.project} sessions · ` + new Date().toLocaleTimeString())}`);
  out.push(...usageSection(W), "");

  const all = Object.entries(sessions()).map(([ref, s]) => ({ ref, ...s }));
  const open = all.filter((s) => s.status !== "closed").sort((a, b) => (a.status === "blocked" ? -1 : 0) - (b.status === "blocked" ? -1 : 0) || Date.parse(b.updated) - Date.parse(a.updated));
  const counts = ["working", "blocked", "done"].map((k) => `${open.filter((s) => s.status === k).length} ${k}`).join(" · ");
  out.push(`${paint("bold", "SESSIONS")} ${paint("dim", counts)}`);
  if (!open.length) out.push(paint("dim", "  none. Ask the PM to start one."));
  let tok = {};
  try { tok = workerTokens(open.map((s) => s.ticket)); } catch {}
  for (const s of open) {
    const t = tok[s.ticket] ? paint("dim", ` · ${fmtTokens(tok[s.ticket].total)} tok, ${fmtTokens(tok[s.ticket].out)} out`) : "";
    const [icon, color] = ICON[s.status] ?? ["?", "yellow"];
    const act = s.status === "working" ? (s.activity === "idle" ? paint("yellow", " idle") : paint("dim", " busy")) : "";
    out.push(clip(`  ${paint(color, icon)} ${pad(paint("bold", s.ticket ?? s.ref), 9)} ${s.title ?? ""}${act} ${paint("dim", ago(s.started))}${t}`, W));
    if (s.detail) out.push(clip(`      ${paint(color, s.detail)}`, W));
  }

  out.push("", paint("bold", "RECENT"));
  const ev = events(8).reverse(); // 8, not 12: makes room for the USAGE bars
  if (!ev.length) out.push(paint("dim", "  nothing yet"));
  for (const e of ev) {
    const color = /^DONE/.test(e.text) ? "green" : /^BLOCKED/.test(e.text) ? "red" : "gray";
    out.push(clip(`  ${paint("dim", pad(ago(e.at), 4))} ${paint(color, e.text)}`, W));
  }

  out.push("", `${paint("bold", "OPEN PRs")} ${paint("dim", REPOS.map((r) => r.split("/")[1]).join(", ") || "no repos configured")}`);
  if (!prs.length) out.push(paint("dim", REPOS.length ? "  none" : "  add repos to pm.config.json"));
  for (const p of prs) out.push(clip(`  ${paint("dim", `${p.repo}#${p.number}`)} ${p.title} ${paint("dim", ago(p.updatedAt))}`, W));

  out.push("", ...doneSection(W));

  out.push("", paint("dim", "Results from workers are relayed to the PM on the right."));

  if (!rows || out.length <= rows) return out.join("\n");
  return [...out.slice(0, Math.max(0, rows - 1)), paint("dim", "  …")].join("\n");
}

const once = process.argv.includes("--once");
await Promise.all([refreshPrs(), refreshUsage()]);
if (once) { console.log(render()); process.exit(0); }
process.stdout.write("\x1b[?25l");
for (;;) {
  refreshPrs();
  refreshUsage();
  process.stdout.write("\x1b[H\x1b[2J" + render(Math.max(10, process.stdout.rows || 40)));
  await new Promise((r) => setTimeout(r, 3_000));
}
