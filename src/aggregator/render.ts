import { __internal, eventCategory, escapeHtml, formatPayload, formatTokens, isoTime, sessionCategory, truncateMid } from "../server/render.js";
import type { SymphonyEvent } from "../observability/event_log.js";
import type { DaemonStatus } from "./poller.js";

export interface AggregatorRenderInput {
  daemons: DaemonStatus[];
  now: Date;
  refreshIntervalSec: number;
  recentEventsLimit: number;
}

export function aggregateTotals(daemons: DaemonStatus[]): {
  running: number;
  retrying: number;
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
} {
  let running = 0;
  let retrying = 0;
  const tokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const d of daemons) {
    if (!d.state) continue;
    running += d.state.running ?? 0;
    retrying += d.state.retrying?.length ?? 0;
    tokens.inputTokens += d.state.codexTotals?.inputTokens ?? 0;
    tokens.outputTokens += d.state.codexTotals?.outputTokens ?? 0;
    tokens.totalTokens += d.state.codexTotals?.totalTokens ?? 0;
  }
  return { running, retrying, tokens };
}

export function mergedRecentEvents(daemons: DaemonStatus[], limit: number): Array<SymphonyEvent & { _daemon: string }> {
  const all: Array<SymphonyEvent & { _daemon: string }> = [];
  for (const d of daemons) {
    for (const e of d.state?.recentEvents ?? []) all.push({ ...e, _daemon: d.name });
  }
  all.sort((a, b) => b.ts.localeCompare(a.ts));
  return all.slice(0, limit);
}

export function renderAggregator(input: AggregatorRenderInput): string {
  const totals = aggregateTotals(input.daemons);
  const reachable = input.daemons.filter((d) => d.reachable).length;
  const recent = mergedRecentEvents(input.daemons, input.recentEventsLimit);

  const headerStrip = `<header class="bar">
  <div class="bar-id">
    <span class="wordmark">symphony</span>
    <span class="bar-path">aggregator · ${reachable} of ${input.daemons.length} daemons reachable</span>
  </div>
  <div class="bar-stats">
    <div><span class="k">running</span><span class="v">${totals.running}</span></div>
    <div><span class="k">retrying</span><span class="v">${totals.retrying}</span></div>
    <div><span class="k">tokens · in</span><span class="v">${formatTokens(totals.tokens.inputTokens)}</span></div>
    <div><span class="k">tokens · out</span><span class="v">${formatTokens(totals.tokens.outputTokens)}</span></div>
    <div><span class="k">refreshed</span><span class="v"><span class="t-mono">${escapeHtml(input.now.toLocaleTimeString("en-GB", { hour12: false }))}</span></span></div>
  </div>
</header>`;

  const daemonRows = input.daemons
    .map((d) => {
      const cat = d.reachable ? "ok" : "err";
      const lastSeen = d.lastSeenAt ?? "never";
      const stateStr = d.reachable
        ? `${d.state?.running ?? 0} running · ${d.state?.retrying?.length ?? 0} retrying`
        : escapeHtml(d.lastError ?? "unreachable");
      return `<tr>
        <td class="t-id"><span class="dot ${cat}"></span>${escapeHtml(d.name)}</td>
        <td class="t-mono"><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${escapeHtml(d.url)}</a></td>
        <td class="t-meta">${escapeHtml(stateStr)}</td>
        <td class="t-meta"><span data-rel-ts="${d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0}">${lastSeen === "never" ? "never" : ""}</span></td>
        <td class="t-meta">${d.state?.workflowPath ? escapeHtml(d.state.workflowPath) : "—"}</td>
      </tr>`;
    })
    .join("");

  const sessionsRows: string[] = [];
  for (const d of input.daemons) {
    if (!d.reachable || !d.state) continue;
    for (const session of d.state.runningSessions ?? []) {
      const cat = sessionCategory(session);
      const sessionLink = `${d.url}/issues/${encodeURIComponent(session.identifier)}`;
      sessionsRows.push(`<tr class="clickable" onclick="window.open('${sessionLink}','_blank','noopener')">
        <td class="t-id"><span class="dot ${cat}"></span>${escapeHtml(session.identifier)}</td>
        <td><span class="pill neutral">${escapeHtml(d.name)}</span></td>
        <td><span class="pill neutral">${escapeHtml(session.state)}</span></td>
        <td class="t-mono">${escapeHtml(truncateMid(session.sessionId ?? "—", 22))}</td>
        <td class="t-num">${session.attempt ?? "—"}</td>
        <td class="t-num">${session.turnCount}</td>
        <td class="t-meta">${escapeHtml(session.lastEventKind ?? "—")} · <span data-rel-ts="${session.lastEventAtMs}">just now</span></td>
        <td class="t-num">${formatTokens(session.tokens.totalTokens)}</td>
        <td class="t-arrow">↗</td>
      </tr>`);
    }
  }

  const retryingRows: string[] = [];
  for (const d of input.daemons) {
    if (!d.reachable || !d.state) continue;
    for (const r of d.state.retrying ?? []) {
      retryingRows.push(`<tr>
        <td class="t-id"><span class="dot warn"></span>${escapeHtml(r.identifier)}</td>
        <td><span class="pill neutral">${escapeHtml(d.name)}</span></td>
        <td class="t-num">${r.attempt}</td>
        <td class="t-meta"><span data-due-ts="${r.dueAtMs}">due now</span></td>
        <td class="t-meta">${escapeHtml(r.error ?? "—")}</td>
      </tr>`);
    }
  }

  const eventsRows = recent.map((e) => {
    const cat = eventCategory(e.type);
    const id = e.issueIdentifier ?? "—";
    return `<li>
      <span class="ts">${escapeHtml(isoTime(e.ts))}</span>
      <span class="marker">▸</span>
      <span><span class="pill ${cat}">${escapeHtml(e.type)}</span></span>
      <span><span class="pill neutral">${escapeHtml(e._daemon)}</span> <span class="id">${escapeHtml(id)}</span> <span class="pl">${escapeHtml(formatPayload(e.payload))}</span></span>
    </li>`;
  });

  const body = `
${headerStrip}

<section class="section">
  <div class="section-head">
    <span class="label">daemons <span class="count">(${input.daemons.length})</span></span>
    <span class="meta">${reachable} reachable · poll-based, no SSE</span>
  </div>
  <table class="rows">
    <thead><tr><th>name</th><th>url</th><th>state</th><th>last seen</th><th>workflow</th></tr></thead>
    <tbody>${daemonRows}</tbody>
  </table>
</section>

<section class="section">
  <div class="section-head">
    <span class="label">running sessions <span class="count">(${sessionsRows.length})</span></span>
    <span class="meta">across all reachable daemons · click row to open per-issue page on its daemon</span>
  </div>
  ${sessionsRows.length
    ? `<table class="rows">
        <thead><tr>
          <th>identifier</th><th>daemon</th><th>state</th><th>session</th>
          <th>attempt</th><th>turns</th><th>last event</th><th>tokens</th><th></th>
        </tr></thead>
        <tbody>${sessionsRows.join("")}</tbody>
      </table>`
    : `<p class="empty">no sessions running across the fleet</p>`}
</section>

<section class="section">
  <div class="section-head">
    <span class="label">retry queue <span class="count">(${retryingRows.length})</span></span>
    <span class="meta">across all reachable daemons</span>
  </div>
  ${retryingRows.length
    ? `<table class="rows">
        <thead><tr><th>identifier</th><th>daemon</th><th>attempt</th><th>due</th><th>error</th></tr></thead>
        <tbody>${retryingRows.join("")}</tbody>
      </table>`
    : `<p class="empty">no items in any daemon's retry queue</p>`}
</section>

<section class="section">
  <div class="section-head">
    <span class="label">recent events <span class="count">(${eventsRows.length})</span></span>
    <span class="meta">merged + ts-sorted from each daemon's recentEvents</span>
  </div>
  ${eventsRows.length
    ? `<ul class="events">${eventsRows.join("")}</ul>`
    : `<p class="empty">no events captured from any daemon</p>`}
</section>

<footer class="foot">
  <span>aggregator endpoints · GET /api/v1/state · poll cadence per --config</span>
  <span>refreshes every ${input.refreshIntervalSec}s</span>
</footer>
`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>symphony · aggregator</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta http-equiv="refresh" content="${input.refreshIntervalSec}" />
<style>${__internal.STYLES}</style>
</head>
<body>
${body}
<script>${__internal.RELATIVE_TIME_SCRIPT}</script>
</body>
</html>`;
}
