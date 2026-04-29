# Symphony Operator Console — Visual System

This document captures the visual system used by `src/server/render.ts`. It
exists so that future contributors can extend the dashboard without
recreating the rationale.

## Typography

System font stacks. No webfonts — the dashboard runs on loopback and must
work in air-gapped or fresh-machine setups without a network round-trip.

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI",
             system-ui, sans-serif;
--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Cascadia Code",
             "Roboto Mono", Menlo, Consolas, monospace;
```

This picks up SF Pro / SF Mono on macOS and Segoe UI Variable / Cascadia
Mono on Windows — both genuinely good faces, neither in the AI reflex set.
The fallback chain ensures Linux gets something reasonable.

### Type scale (fixed `rem`, not fluid — this is product UI not a landing page)

| Token | Size | Use |
|---|---|---|
| `--text-mini` | `0.6875rem` (11px) | column headers, metadata captions |
| `--text-xs`   | `0.75rem`   (12px) | table cells, pills |
| `--text-sm`   | `0.8125rem` (13px) | body, descriptions |
| `--text-md`   | `0.9375rem` (15px) | section titles |
| `--text-lg`   | `1.125rem`  (18px) | header metric values |
| `--text-xl`   | `1.5rem`    (24px) | page H1 |

Line-height: tight on tabular content (1.4), looser on prose (1.55), tightest
on monospace identifiers (1.45).

## Color

OKLCH throughout. Brand hue is **iron** (h≈240, very low chroma) — desaturated
steel-blue that tints all neutral surfaces without competing with the
semantic state hues. Pure black/white is never used.

### Dark theme (default)

```css
--bg:      oklch(0.14 0.008 240);
--panel:   oklch(0.18 0.008 240);
--surface: oklch(0.22 0.010 240);
--border:  oklch(0.28 0.012 240);
--rule:    oklch(0.24 0.010 240);
--text:    oklch(0.93 0.008 240);
--text-2:  oklch(0.70 0.012 240);
--text-3:  oklch(0.55 0.014 240);
--accent:  oklch(0.78 0.040 240);
```

### Semantic state hues (h fixed; L/C tuned per theme)

| Token | Hue | Meaning | Used for |
|---|---|---|---|
| `--ok`     | 150 | healthy, completed | `turn_completed`, `verify_passed`, running normally |
| `--err`    |  25 | broken, blocked    | `turn_failed`, `iris_blocked_handed_off`, `verify_terminal_failed` |
| `--warn`   |  75 | waiting, retrying  | `retry_scheduled`, `session_stalled_cancelled`, `verify_retry` |
| `--info`   | 250 | informational      | `agent_message`, `agent_tool_call`, `iris_call_started` |
| `--neutral`| 240 | unclassified       | everything else; pulls from neutral tokens |

In dark theme: pill backgrounds at `L≈0.28 C≈0.06`, text at `L≈0.85 C≈0.10`,
dots at `L≈0.70 C≈0.14`. In light theme: pill bg at `L≈0.94 C≈0.05`, text at
`L≈0.38 C≈0.13`, dots at `L≈0.55 C≈0.16`.

## Spacing

4pt scale, semantic names:

| Token | Px | Use |
|---|---|---|
| `--s-2xs` | 4 | within a row, between dot and text |
| `--s-xs`  | 8 | between cells, between pill and text |
| `--s-sm`  | 12 | row internal padding |
| `--s-md`  | 16 | section internal padding |
| `--s-lg`  | 24 | between sections |
| `--s-xl`  | 32 | page horizontal padding |
| `--s-2xl` | 48 | top-of-page from header |

`gap` everywhere. No margin collapse hacks.

## Component vocabulary

### Header strip

A single horizontal band across the top. Workflow path on the left in
monospace; metric blocks on the right. No card backgrounds — flat, separated
by vertical hairline rules. Each metric block has a tiny lowercase label
(`--text-mini`, `--text-3`) above a numeric value (`--text-lg`, `--text`).

```html
<header class="bar">
  <div class="bar-id">
    <span class="wordmark">symphony</span>
    <span class="bar-path">/path/to/WORKFLOW.md</span>
  </div>
  <div class="bar-stats">
    <div><span class="k">running</span><span class="v">3</span></div>
    <div><span class="k">retrying</span><span class="v">1</span></div>
    <div><span class="k">tokens · in</span><span class="v">12.4k</span></div>
    <div><span class="k">tokens · out</span><span class="v">3.1k</span></div>
    <div><span class="k">refreshed</span><span class="v t-mono">14:22:08</span></div>
  </div>
</header>
```

### Section header

Two-line layout: a tiny lowercase eyebrow label (`running sessions`) above
the count badge (`(3)`). No decorative iconography. Ends with a horizontal
hairline that touches the page edge.

### Sessions table row

```
●  identifier         state   session-id    turn  last-event · age   tokens     →
```

- `●` is the telltale dot in the state's color (`--ok`, `--warn`, etc.)
- `identifier` and `session-id` are monospace
- `state` is rendered as a small text-only pill (no dot — the row already has one)
- `last-event · age` shows "agent_message · 12s" with the bullet as separator
- The trailing `→` is a low-contrast arrow indicating the row is clickable

Row padding: `var(--s-sm) var(--s-md)`. Hover state lifts the surface to
`--panel` and adds a left-edge inner shadow that doesn't read as a colored
stripe (we do NOT use `border-left: 4px solid`). Cursor pointer.

### Retry queue row

Same vertical rhythm as the sessions row, but:
- The dot is always `--warn` (amber)
- The "last-event · age" column is replaced by "due in 12s" (live counter)
- The "tokens" column is replaced by the truncated error reason in `--text-3`

### Event feed item

Three-column layout. Left: timestamp in `--font-mono`, `--text-mini`,
`--text-3`. Middle: a one-word event type pill colored by category (info/ok/
warn/err/neutral). Right: `<identifier>` in monospace + a single-line
payload preview in `--text-2`, truncated to ~120 chars.

```
14:22:01.182  ▸ turn_completed   repo#42  usage.totalTokens=4221
14:21:58.044  ▸ agent_tool_call  repo#42  toolName=iris_run, callId=call_8
14:21:14.991  ▸ iris_blocked     repo#11  reason="captcha"  vncUrl="…"
```

The leading `▸` glyph is a tiny separator that appears once per item — it
costs nothing visually and gives the eye a vertical gutter to scan along.

### Timeline node (per-issue page)

Vertical timeline with monospace timestamp on the left, telltale dot in a
2px-wide guide rail, event label and payload on the right. Sessions are
visually grouped by inserting a thin horizontal divider with the
`session_id` written in the rule.

## State-pill taxonomy

The full mapping of `event.type` → semantic color, used by both the row dot
and the event-feed pill, lives in `eventCategory()` in `src/server/render.ts`.
Source of truth — keep that function and this doc in sync if event types
are added.

| Category | Member event types |
|---|---|
| **ok**       | `turn_completed`, `verify_passed`, `iris_call_completed`, `agent_session_started` |
| **err**      | `turn_failed`, `turn_cancelled`, `iris_blocked_handed_off`, `verify_terminal_failed`, `verify_blocked`, `iris_call_failed`, `dispatch_failed`, `session_consumer_error`, `session_stalled_cancelled` |
| **warn**     | `retry_scheduled`, `retry_fired`, `retry_abandoned`, `verify_retry`, `verify_no_url`, `iris_call_limit_exceeded`, `turn_input_required`, `status_drift_detected` |
| **info**     | `agent_message`, `agent_tool_call`, `iris_call_started`, `verify_iris_call_started`, `verify_iris_call_completed`, `verify_triggered`, `turn_started`, `turn_recording_started` |
| **neutral**  | `daemon_reload`, `workspace_prepared`, `status_transition_orchestrator`, `dispatch_aborted`, `session_released` |

## Motion

- Hover lift on table rows: `transition: background-color 80ms ease-out;`
- Nothing else. No page-load animation, no spinners, no skeleton loaders.
  The page either has data (instant render) or it doesn't (empty state with
  text saying so).

## Empty states

If there are no running sessions, the table is replaced with a single line
of `--text-2` text: `no sessions running — daemon is idle`. Same pattern for
retry queue and event feed. No illustrated empty states, no "Get started" CTAs.
