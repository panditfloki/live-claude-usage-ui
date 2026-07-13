# Changelog

All notable changes to **Mātrā** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html).

---

## [0.9.0] — 2026-07-14

**First public release.** Versions below this were pre-release iterations and were never
published; they are summarised at the end for context.

### Added
- **`Today` range tab.** Shows the calendar day so far — midnight → now.
  Deliberately **not** a rolling 24-hour window: the *Last 24 hours* KPI card already covers
  that, and two different numbers under one label is worse than neither.
- **Hourly chart for single-day ranges.** `Today`, a single day picked in `Custom`, or a day
  clicked in the heatmap now regroup the chart into hourly buckets. A single day drawn as one
  fat bar carries no information. Hover still gives the per-model token and cost split.
- Copyright footer — © dydxfx, MIT, repo link, and an explicit *not affiliated with Anthropic*.

### Fixed
- Verified hourly buckets sum **exactly** to the range total, so the regrouping cannot silently
  drop turns.

---

## Pre-release (0.1.0 – 0.8.0) — 2026-07-13/14

Built and iterated locally; never published. What landed, in order:

### The parser (`parser.js`)
- Reads `~/.claude/projects/**/*.jsonl` and derives cost, tokens, models, projects, sessions,
  streaks, and a 26-week activity heatmap. No network, no credentials.
- **Two bugs found the hard way — both would have under-reported real usage:**
  - **Subagent transcripts sit three directories deep** (`<project>/<session>/subagents/`).
    A one-level directory walk silently dropped every subagent turn — ~$37 and 171 turns,
    invisible.
  - **A streaming message's usage row is rewritten as it grows.** The same `message.id` recurs
    with an *increasing* `output_tokens` (one real case: `7 → 7 → 7 → 955`). Dedupe must keep
    the **highest-output** row per id, not the first, or output — the priciest token class — is
    badly undercounted.
- Cost is **equivalent API cost**, a burn proxy, not a bill. Labelled as such everywhere.

### Real plan quota (`quota.js`)
- `GET /api/oauth/usage` + `/api/oauth/profile` — session %, weekly %, per-model weekly %,
  reset times, plan tier, and the usage-credit object. Authenticated with the OAuth token from
  the OS credential store, read at request time, never logged or persisted.
- **The endpoint rate-limits hard** — it exists for on-demand `/usage`, not polling, and its
  `Retry-After` is `0` (useless). A 60s poll from two processes earned a 429. Now: 15-minute
  TTL, one shared on-disk cache across processes, and backoff.
- **Every failure is soft.** A 429 or a 404 serves the last good reading marked *"as of 4m ago"*
  rather than blanking the panel; with no prior reading the bars simply hide. The quota
  disappearing must never take the rest of the dashboard down with it.
- Figures the token cannot see (plan price, renewal, credit balance — there is **no billing
  scope**) live in a gitignored `plan.json` and always render on a dashed tile tagged
  **declared**, never as if they were live.

### Surfaces
- **VS Code / Cursor / Antigravity extension** — live quota in the status bar (amber past 80%),
  full dashboard in a webview panel.
- **Standalone web app** on `localhost:4317`, no IDE required.
- `media/dashboard.html` is **one file serving both hosts** — it detects which it is running in.
  The two had already drifted apart once; collapsing them made that impossible.
- Sticky header, so the range control stays reachable while you scroll the thing it controls.
- Date-range tabs (7d / 30d / All / Custom), stacked per-day token chart with per-model **cost**
  on hover, top deck with plan and price, and three fixed KPI cards (5-hour window, last 24h,
  all time) that do **not** move when the range changes.

[0.9.0]: https://github.com/panditfloki/live-claude-usage-ui/releases/tag/v0.9.0
