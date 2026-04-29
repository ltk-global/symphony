import type { RunningSessionSnapshot } from "../orchestrator/index.js";
import type { SymphonyEvent } from "../observability/event_log.js";

export interface SnapshotShape {
  running: number;
  runningSessions: RunningSessionSnapshot[];
  retrying: Array<{ issueId: string; identifier: string; attempt: number; dueAtMs: number; error: string | null }>;
  codexTotals: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface IndexPageInput {
  snapshot: SnapshotShape;
  recentEvents: SymphonyEvent[];
  workflowPath: string;
  dataDir: string;
  now: Date;
  refreshIntervalSec: number;
}

export interface IssuePageInput {
  identifier: string;
  events: SymphonyEvent[];
  liveSession: RunningSessionSnapshot | null;
  retryEntry: { attempt: number; dueAtMs: number; error: string | null } | null;
  turnFiles: Array<{ name: string; relPath: string; sizeBytes: number; mtimeMs: number }>;
  workflowPath: string;
  dataDir: string;
  now: Date;
  refreshIntervalSec: number;
}

export interface TurnPageInput {
  identifier: string;
  fileName: string;
  content: string;
  byteLength: number;
}

const STYLES = `
:root {
  color-scheme: dark light;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace;
  --text-mini: 0.6875rem;
  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-md: 0.9375rem;
  --text-lg: 1.125rem;
  --text-xl: 1.5rem;
  --s-2xs: 4px;
  --s-xs: 8px;
  --s-sm: 12px;
  --s-md: 16px;
  --s-lg: 24px;
  --s-xl: 32px;
  --s-2xl: 48px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(0.14 0.008 240);
    --panel: oklch(0.18 0.008 240);
    --surface: oklch(0.22 0.010 240);
    --border: oklch(0.28 0.012 240);
    --rule: oklch(0.24 0.010 240);
    --text: oklch(0.93 0.008 240);
    --text-2: oklch(0.70 0.012 240);
    --text-3: oklch(0.55 0.014 240);
    --accent: oklch(0.78 0.040 240);
    --pill-bg-l: 0.28; --pill-bg-c: 0.06;
    --pill-fg-l: 0.85; --pill-fg-c: 0.10;
    --dot-l: 0.70; --dot-c: 0.14;
    --neutral-bg: oklch(0.24 0.008 240);
    --neutral-fg: oklch(0.72 0.010 240);
  }
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: oklch(0.985 0.004 240);
    --panel: oklch(0.965 0.005 240);
    --surface: oklch(0.945 0.006 240);
    --border: oklch(0.86 0.008 240);
    --rule: oklch(0.91 0.006 240);
    --text: oklch(0.20 0.012 240);
    --text-2: oklch(0.42 0.014 240);
    --text-3: oklch(0.55 0.016 240);
    --accent: oklch(0.45 0.080 240);
    --pill-bg-l: 0.94; --pill-bg-c: 0.05;
    --pill-fg-l: 0.38; --pill-fg-c: 0.13;
    --dot-l: 0.55; --dot-c: 0.16;
    --neutral-bg: oklch(0.93 0.006 240);
    --neutral-fg: oklch(0.40 0.010 240);
  }
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

body {
  min-height: 100vh;
  padding: var(--s-2xl) var(--s-xl) var(--s-2xl);
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }

.wordmark {
  font-family: var(--font-mono);
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}
.wordmark::before {
  content: "▾";
  display: inline-block;
  margin-right: 0.4em;
  color: var(--accent);
  transform: translateY(-0.05em);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-lg);
  padding-bottom: var(--s-md);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--s-2xl);
  flex-wrap: wrap;
}
.bar-id {
  display: flex;
  align-items: baseline;
  gap: var(--s-md);
  flex-wrap: wrap;
}
.bar-path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-3);
}
.bar-stats {
  display: flex;
  gap: var(--s-lg);
  align-items: stretch;
}
.bar-stats > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: var(--s-md);
  border-left: 1px solid var(--rule);
}
.bar-stats > div:first-child { border-left: none; padding-left: 0; }
.bar-stats .k {
  font-size: var(--text-mini);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.bar-stats .v {
  font-size: var(--text-lg);
  font-feature-settings: "tnum" 1;
}

.section { margin-bottom: var(--s-2xl); }
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-md);
  margin-bottom: var(--s-sm);
  padding-bottom: var(--s-xs);
  border-bottom: 1px solid var(--rule);
}
.section-head .label {
  font-size: var(--text-md);
  font-weight: 500;
}
.section-head .label .count {
  color: var(--text-3);
  font-weight: 400;
  font-feature-settings: "tnum" 1;
  margin-left: var(--s-2xs);
}
.section-head .meta {
  font-size: var(--text-mini);
  color: var(--text-3);
  text-transform: lowercase;
  letter-spacing: 0.04em;
}

table.rows {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-xs);
}
table.rows thead th {
  text-align: left;
  font-weight: 500;
  font-size: var(--text-mini);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
  padding: var(--s-xs) var(--s-md);
  border-bottom: 1px solid var(--rule);
}
table.rows tbody td {
  padding: var(--s-sm) var(--s-md);
  border-bottom: 1px solid var(--rule);
  vertical-align: top;
}
table.rows tbody tr {
  transition: background-color 80ms ease-out;
}
table.rows tbody tr:hover { background: var(--panel); }
table.rows tbody tr.clickable { cursor: pointer; }
table.rows tbody tr:last-child td { border-bottom: none; }
table.rows td.t-mono, table.rows td.t-id {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.45;
}
table.rows td.t-num {
  font-family: var(--font-mono);
  font-feature-settings: "tnum" 1;
  white-space: nowrap;
  color: var(--text-2);
}
table.rows td.t-meta {
  color: var(--text-2);
  white-space: nowrap;
}
table.rows td.t-arrow {
  text-align: right;
  color: var(--text-3);
  width: 1em;
}

.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: var(--s-xs);
  vertical-align: middle;
  transform: translateY(-1px);
  background: oklch(var(--dot-l) var(--dot-c) var(--dot-h, 240));
}
.dot.ok      { --dot-h: 150; }
.dot.err     { --dot-h: 25; }
.dot.warn    { --dot-h: 75; }
.dot.info    { --dot-h: 250; }
.dot.neutral { background: var(--neutral-fg); }

.pill {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: var(--text-mini);
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
  background: oklch(var(--pill-bg-l) var(--pill-bg-c) var(--pill-h, 240));
  color: oklch(var(--pill-fg-l) var(--pill-fg-c) var(--pill-h, 240));
  white-space: nowrap;
  font-feature-settings: "tnum" 1;
}
.pill.ok      { --pill-h: 150; }
.pill.err     { --pill-h: 25; }
.pill.warn    { --pill-h: 75; }
.pill.info    { --pill-h: 250; }
.pill.neutral { background: var(--neutral-bg); color: var(--neutral-fg); }

.empty {
  padding: var(--s-md) 0;
  font-size: var(--text-xs);
  color: var(--text-2);
  font-style: italic;
}

.events {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.55;
}
.events li {
  display: grid;
  grid-template-columns: 7em auto 12em 1fr;
  gap: var(--s-sm);
  padding: var(--s-2xs) 0;
  border-bottom: 1px solid transparent;
}
.events li + li { border-top: 1px solid var(--rule); }
.events .ts { color: var(--text-3); }
.events .marker { color: var(--text-3); }
.events .id { color: var(--text-2); }
.events .pl { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.timeline li {
  display: grid;
  grid-template-columns: 9em 1.5em 1fr;
  gap: var(--s-xs);
  padding: var(--s-2xs) 0;
}
.timeline .ts { color: var(--text-3); }
.timeline .rail { color: var(--text-3); text-align: center; }
.timeline .rail::before { content: "│"; }
.timeline .body { color: var(--text); }
.timeline .body .type { color: var(--text-2); }
.timeline .body .pl { color: var(--text-3); margin-left: var(--s-xs); }
.timeline .session-rule {
  display: grid;
  grid-template-columns: 9em 1.5em 1fr;
  gap: var(--s-xs);
  padding: var(--s-md) 0 var(--s-xs);
  font-size: var(--text-mini);
  color: var(--text-3);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  border-top: 1px solid var(--rule);
  margin-top: var(--s-xs);
}
.timeline .session-rule .label {
  grid-column: 3;
}

.issue-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s-md) var(--s-xl);
  margin-bottom: var(--s-md);
  padding-bottom: var(--s-md);
  border-bottom: 1px solid var(--border);
}
.issue-head h1 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 500;
  font-family: var(--font-mono);
  letter-spacing: -0.01em;
}
.issue-head .facts {
  display: flex;
  gap: var(--s-lg);
  flex-wrap: wrap;
}
.issue-head .facts > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.issue-head .facts .k {
  font-size: var(--text-mini);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.issue-head .facts .v {
  font-size: var(--text-sm);
  font-family: var(--font-mono);
}

.crumb {
  font-size: var(--text-xs);
  color: var(--text-3);
  margin-bottom: var(--s-sm);
}
.crumb a { color: var(--text-2); }

pre.raw {
  background: var(--panel);
  border: 1px solid var(--border);
  padding: var(--s-md);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
  overflow: auto;
  white-space: pre;
  color: var(--text);
}

footer.foot {
  margin-top: var(--s-2xl);
  padding-top: var(--s-md);
  border-top: 1px solid var(--rule);
  font-size: var(--text-mini);
  color: var(--text-3);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  display: flex;
  justify-content: space-between;
  gap: var(--s-md);
  flex-wrap: wrap;
}
`;

const RELATIVE_TIME_SCRIPT = `
(function() {
  function fmt(deltaMs) {
    if (deltaMs < 0) return Math.abs(Math.round(deltaMs / 1000)) + "s ahead";
    var s = Math.round(deltaMs / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.round(h / 24);
    return d + "d ago";
  }
  function fmtCountdown(deltaMs) {
    if (deltaMs <= 0) return "due now";
    var s = Math.round(deltaMs / 1000);
    if (s < 60) return "in " + s + "s";
    var m = Math.round(s / 60);
    if (m < 60) return "in " + m + "m";
    var h = Math.round(m / 60);
    return "in " + h + "h";
  }
  function update() {
    var now = Date.now();
    document.querySelectorAll("[data-rel-ts]").forEach(function(el) {
      var ts = parseInt(el.getAttribute("data-rel-ts"), 10);
      if (!isNaN(ts)) el.textContent = fmt(now - ts);
    });
    document.querySelectorAll("[data-due-ts]").forEach(function(el) {
      var ts = parseInt(el.getAttribute("data-due-ts"), 10);
      if (!isNaN(ts)) el.textContent = fmtCountdown(ts - now);
    });
  }
  update();
  setInterval(update, 1000);
})();
`;

export function eventCategory(type: string): "ok" | "err" | "warn" | "info" | "neutral" {
  if (
    type === "turn_completed" ||
    type === "verify_passed" ||
    type === "iris_call_completed" ||
    type === "agent_session_started"
  ) return "ok";
  if (
    type === "turn_failed" ||
    type === "turn_cancelled" ||
    type === "iris_blocked_handed_off" ||
    type === "verify_terminal_failed" ||
    type === "verify_blocked" ||
    type === "iris_call_failed" ||
    type === "dispatch_failed" ||
    type === "session_consumer_error" ||
    type === "session_stalled_cancelled"
  ) return "err";
  if (
    type === "retry_scheduled" ||
    type === "retry_fired" ||
    type === "retry_abandoned" ||
    type === "verify_retry" ||
    type === "verify_no_url" ||
    type === "iris_call_limit_exceeded" ||
    type === "turn_input_required" ||
    type === "status_drift_detected"
  ) return "warn";
  if (
    type === "agent_message" ||
    type === "agent_tool_call" ||
    type === "iris_call_started" ||
    type === "verify_iris_call_started" ||
    type === "verify_iris_call_completed" ||
    type === "verify_triggered" ||
    type === "turn_started" ||
    type === "turn_recording_started"
  ) return "info";
  return "neutral";
}

export function sessionCategory(snap: RunningSessionSnapshot): "ok" | "err" | "warn" | "info" | "neutral" {
  if (snap.lastEventKind === "turn_failed" || snap.lastEventKind === "turn_cancelled") return "err";
  if (snap.lastEventKind === "turn_input_required") return "warn";
  if (snap.lastEventKind === "turn_completed") return "ok";
  if (snap.lastEventKind === "agent_message" || snap.lastEventKind === "tool_call") return "info";
  return "neutral";
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function truncateMid(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatPayload(payload: Record<string, unknown> | undefined, maxLen = 140): string {
  if (!payload) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    let formatted: string;
    if (value === null || value === undefined) formatted = "null";
    else if (typeof value === "string") formatted = JSON.stringify(value);
    else if (typeof value === "number" || typeof value === "boolean") formatted = String(value);
    else formatted = JSON.stringify(value);
    parts.push(`${key}=${formatted}`);
  }
  const joined = parts.join("  ");
  return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
}

export function clockTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

export function isoTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function chrome(title: string, body: string, refreshSec: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta http-equiv="refresh" content="${refreshSec}" />
<style>${STYLES}</style>
</head>
<body>
${body}
<script>${RELATIVE_TIME_SCRIPT}</script>
</body>
</html>`;
}

function headerStrip(workflowPath: string, snapshot: SnapshotShape, now: Date): string {
  const stats = [
    { k: "running", v: String(snapshot.running) },
    { k: "retrying", v: String(snapshot.retrying.length) },
    { k: "tokens · in", v: formatTokens(snapshot.codexTotals.inputTokens) },
    { k: "tokens · out", v: formatTokens(snapshot.codexTotals.outputTokens) },
    { k: "refreshed", v: `<span class="t-mono">${escapeHtml(clockTime(now))}</span>` },
  ];
  return `<header class="bar">
  <div class="bar-id">
    <span class="wordmark">symphony</span>
    <span class="bar-path">${escapeHtml(workflowPath)}</span>
  </div>
  <div class="bar-stats">${stats.map((s) => `<div><span class="k">${escapeHtml(s.k)}</span><span class="v">${s.v}</span></div>`).join("")}</div>
</header>`;
}

function sessionRow(snap: RunningSessionSnapshot): string {
  const cat = sessionCategory(snap);
  const lastEvent = snap.lastEventKind ?? "—";
  const url = `/issues/${encodeURIComponent(snap.identifier)}`;
  return `<tr class="clickable" onclick="window.location='${url}'">
    <td class="t-id"><span class="dot ${cat}"></span>${escapeHtml(snap.identifier)}</td>
    <td><span class="pill neutral">${escapeHtml(snap.state)}</span></td>
    <td class="t-mono">${escapeHtml(truncateMid(snap.sessionId ?? "—", 24))}</td>
    <td class="t-num">${snap.attempt ?? "—"}</td>
    <td class="t-num">${snap.turnCount}</td>
    <td class="t-meta">${escapeHtml(lastEvent)} · <span data-rel-ts="${snap.lastEventAtMs}">just now</span></td>
    <td class="t-num">${formatTokens(snap.tokens.totalTokens)}</td>
    <td class="t-arrow">→</td>
  </tr>`;
}

function retryRow(entry: SnapshotShape["retrying"][number]): string {
  const error = entry.error ?? "no reason captured";
  return `<tr>
    <td class="t-id"><span class="dot warn"></span>${escapeHtml(entry.identifier)}</td>
    <td class="t-num">${entry.attempt}</td>
    <td class="t-meta"><span data-due-ts="${entry.dueAtMs}">due now</span></td>
    <td class="t-meta">${escapeHtml(error)}</td>
  </tr>`;
}

function eventRow(event: SymphonyEvent): string {
  const cat = eventCategory(event.type);
  const ts = isoTime(event.ts);
  const id = event.issueIdentifier ?? "—";
  const payload = formatPayload(event.payload);
  return `<li>
    <span class="ts">${escapeHtml(ts)}</span>
    <span class="marker">▸</span>
    <span><span class="pill ${cat}">${escapeHtml(event.type)}</span></span>
    <span><span class="id">${escapeHtml(id)}</span> <span class="pl">${escapeHtml(payload)}</span></span>
  </li>`;
}

export function renderIndex(input: IndexPageInput): string {
  const sessions = input.snapshot.runningSessions.length
    ? `<table class="rows">
        <thead><tr>
          <th>identifier</th><th>state</th><th>session</th><th>attempt</th>
          <th>turns</th><th>last event</th><th>tokens</th><th></th>
        </tr></thead>
        <tbody>${input.snapshot.runningSessions.map(sessionRow).join("")}</tbody>
      </table>`
    : `<p class="empty">no sessions running — daemon is idle</p>`;

  const retrying = input.snapshot.retrying.length
    ? `<table class="rows">
        <thead><tr>
          <th>identifier</th><th>attempt</th><th>due</th><th>last error</th>
        </tr></thead>
        <tbody>${input.snapshot.retrying.map(retryRow).join("")}</tbody>
      </table>`
    : `<p class="empty">no items in retry queue</p>`;

  const events = input.recentEvents.length
    ? `<ul class="events">${input.recentEvents.map(eventRow).join("")}</ul>`
    : `<p class="empty">no events yet — events.jsonl is empty or not yet flushed</p>`;

  const body = `
${headerStrip(input.workflowPath, input.snapshot, input.now)}

<section class="section">
  <div class="section-head">
    <span class="label">running sessions <span class="count">(${input.snapshot.runningSessions.length})</span></span>
    <span class="meta">live · refreshes every ${input.refreshIntervalSec}s</span>
  </div>
  ${sessions}
</section>

<section class="section">
  <div class="section-head">
    <span class="label">retry queue <span class="count">(${input.snapshot.retrying.length})</span></span>
    <span class="meta">backoff capped at agent.max_retry_backoff_ms</span>
  </div>
  ${retrying}
</section>

<section class="section">
  <div class="section-head">
    <span class="label">recent events <span class="count">(${input.recentEvents.length})</span></span>
    <span class="meta">tail of <span class="t-mono">${escapeHtml(input.dataDir)}/events.jsonl</span></span>
  </div>
  ${events}
</section>

<footer class="foot">
  <span>data dir · <span class="t-mono" style="font-family: var(--font-mono); text-transform: none; letter-spacing: 0;">${escapeHtml(input.dataDir)}</span></span>
  <span>endpoints · GET /api/v1/state · GET /api/v1/issues/&lt;id&gt; · POST /api/v1/refresh</span>
</footer>
`;
  return chrome("symphony · operator console", body, input.refreshIntervalSec);
}

export function renderIssue(input: IssuePageInput): string {
  const facts: Array<{ k: string; v: string }> = [
    { k: "state", v: input.liveSession?.state ?? lastKnownState(input.events) ?? "—" },
    { k: "session", v: input.liveSession?.sessionId ?? "not live" },
    { k: "attempt", v: String(input.liveSession?.attempt ?? input.retryEntry?.attempt ?? "—") },
    { k: "turns", v: String(input.liveSession?.turnCount ?? countTurns(input.events)) },
    { k: "tokens · total", v: formatTokens(input.liveSession?.tokens.totalTokens ?? sumTotalTokens(input.events)) },
    { k: "workspace", v: input.liveSession?.workspacePath ?? lastKnownWorkspace(input.events) ?? "—" },
  ];

  const timeline = input.events.length
    ? renderTimeline(input.events)
    : `<p class="empty">no events for this identifier — was the issue ever dispatched?</p>`;

  const turns = input.turnFiles.length
    ? `<ul class="events">${input.turnFiles
        .map((file) => {
          const url = `/issues/${encodeURIComponent(input.identifier)}/turns/${encodeURIComponent(file.name)}`;
          return `<li>
            <span class="ts">${escapeHtml(isoTime(new Date(file.mtimeMs)))}</span>
            <span class="marker">▸</span>
            <span><span class="pill info">turn</span></span>
            <span><a href="${url}" class="id">${escapeHtml(file.name)}</a> <span class="pl">${file.sizeBytes} bytes</span></span>
          </li>`;
        })
        .join("")}</ul>`
    : `<p class="empty">no raw turn captures on disk for this identifier</p>`;

  const body = `
<p class="crumb"><a href="/">/</a> · issues · ${escapeHtml(input.identifier)}</p>

<header class="issue-head">
  <h1>${escapeHtml(input.identifier)}</h1>
  <div class="facts">
    ${facts
      .map(
        (f) => `<div><span class="k">${escapeHtml(f.k)}</span><span class="v">${escapeHtml(f.v)}</span></div>`,
      )
      .join("")}
  </div>
</header>

<section class="section">
  <div class="section-head">
    <span class="label">timeline <span class="count">(${input.events.length})</span></span>
    <span class="meta">filtered from <span class="t-mono">${escapeHtml(input.dataDir)}/events.jsonl</span></span>
  </div>
  ${timeline}
</section>

<section class="section">
  <div class="section-head">
    <span class="label">raw turn captures <span class="count">(${input.turnFiles.length})</span></span>
    <span class="meta">stream-json from each agent process</span>
  </div>
  ${turns}
</section>

<footer class="foot">
  <span>refreshes every ${input.refreshIntervalSec}s</span>
  <span>workflow · <span class="t-mono" style="font-family: var(--font-mono); text-transform: none; letter-spacing: 0;">${escapeHtml(input.workflowPath)}</span></span>
</footer>
`;
  return chrome(`${input.identifier} · symphony`, body, input.refreshIntervalSec);
}

function renderTimeline(events: SymphonyEvent[]): string {
  const out: string[] = [`<ul class="timeline">`];
  let lastSession: string | null | undefined = undefined;
  for (const event of events) {
    if (event.sessionId !== lastSession) {
      lastSession = event.sessionId;
      out.push(
        `<li class="session-rule"><span class="label">session · ${escapeHtml(event.sessionId ?? "no session")}</span></li>`,
      );
    }
    const cat = eventCategory(event.type);
    out.push(`<li>
      <span class="ts">${escapeHtml(isoTime(event.ts))}</span>
      <span class="rail"></span>
      <span class="body">
        <span class="dot ${cat}"></span>
        <span class="type">${escapeHtml(event.type)}</span>
        <span class="pl">${escapeHtml(formatPayload(event.payload, 240))}</span>
      </span>
    </li>`);
  }
  out.push(`</ul>`);
  return out.join("");
}

export function renderTurn(input: TurnPageInput): string {
  const body = `
<p class="crumb"><a href="/">/</a> · <a href="/issues/${encodeURIComponent(input.identifier)}">${escapeHtml(input.identifier)}</a> · turns · ${escapeHtml(input.fileName)}</p>

<header class="issue-head">
  <h1>${escapeHtml(input.fileName)}</h1>
  <div class="facts">
    <div><span class="k">issue</span><span class="v">${escapeHtml(input.identifier)}</span></div>
    <div><span class="k">size</span><span class="v">${input.byteLength} bytes</span></div>
  </div>
</header>

<pre class="raw">${escapeHtml(input.content)}</pre>

<footer class="foot">
  <span>raw stream-json (claude_code) or JSON-RPC (codex)</span>
</footer>
`;
  return chrome(`${input.fileName} · symphony`, body, 0);
}

function lastKnownState(events: SymphonyEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "issue_dispatched" && typeof event.payload?.state === "string") return event.payload.state;
    if (event.type === "session_released" && typeof event.payload?.to === "string") return event.payload.to;
    if (event.type === "status_drift_detected" && typeof event.payload?.to === "string") return event.payload.to;
  }
  return null;
}

function lastKnownWorkspace(events: SymphonyEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "workspace_prepared" && typeof event.payload?.path === "string") return event.payload.path;
  }
  return null;
}

function countTurns(events: SymphonyEvent[]): number {
  return events.filter((event) => event.type === "turn_started").length;
}

function sumTotalTokens(events: SymphonyEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === "turn_completed" && event.payload && typeof event.payload === "object") {
      const usage = (event.payload as Record<string, unknown>).usage;
      if (usage && typeof usage === "object" && typeof (usage as Record<string, unknown>).totalTokens === "number") {
        total += (usage as Record<string, number>).totalTokens;
      }
    }
  }
  return total;
}

export const __internal = { STYLES, RELATIVE_TIME_SCRIPT };
