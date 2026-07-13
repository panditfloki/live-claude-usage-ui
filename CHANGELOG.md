# Changelog

All notable changes to **Mātrā** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] — 2026-07-14

### Added
- **Compact view — the one-pager.** Everything on a single screen, no scrolling. It answers one
  question — *am I OK right now, and what is it costing me?* — and nothing else earns its pixels:
  the three quota bars with their pace markers, four cost numbers (today · 5-hour · 24h · all
  time), today's model mix, and a 14-day trend.
- **`Compact ⇄ Long` toggle** in the header; your choice is remembered. The IDE panel opens
  **compact** (glancing is the common case), the browser opens **long** (that's where you dig).
- **Plan chip with a popover** — the plan is static and secondary, which is exactly what earns it
  a click instead of a card. `Max (5x) · $100/mo · renews Aug 12`, click for subscription status,
  billing, credits and auto-reload.
  **Only one disclosure on the page, deliberately.** A one-pager's whole value is that it demands
  zero interaction; hide the model and project breakdowns behind dropdowns and you have built a
  worse Long view. Today's model mix is therefore shown inline as a single bar — no click, and no
  need to silently guess a date range the compact view doesn't have.

### Fixed (in local review, before this ever shipped — the review caught them)
- **Duplicate copyright block in compact.** The long view's footer is a *sibling* of the long
  grid, not a child — hiding the grid never hid it. Hidden explicitly.
- **Trend chart collapsing to flat lines.** The bars sat in a `1fr` grid row, and a flexible row
  is a row that can be starved to zero the moment anything overflows. The bar area now has a
  real height, and no compact row is flexible.
- **Narrow layouts** (IDE side-panel, phone): under 700px the header stacks, the plan chip goes
  full-width, each quota label gets its own line, and the KPIs go 2×2; under 430px it tightens
  again. On a phone the page scrolls naturally — one *page*, not one *screenful*; unreadable
  text is worse than a scrollbar.

### Notes
- The plan **tier** (5x / 20x) is detected live from the API. Only the **price** is declared —
  Max 5x is $100/mo, Max 20x is $200/mo — and it renders with a dotted underline rather than the
  loud dashed-tile treatment, which would be far too noisy on a one-pager.
- Compact degrades rather than clips: under 720px tall it drops the trend chart, and under 620px
  it allows scrolling — losing data off the bottom of the screen would be worse than a scrollbar.

---

## [1.0.0] — 2026-07-14

**First stable release.** Everything below has been in daily use and the numbers have been
cross-checked against two independent implementations; the shape is settled enough to call it 1.0.

### Changed
- This dashboard is now explicitly the **long view** — the full, scrolling analysis surface.
  A **compact one-pager** (everything on a single screen, no scrolling) is planned as a second
  view over the same data. `parser.js` and `quota.js` stay UI-agnostic precisely so a second
  front-end costs nothing.

### The 1.0 surface, in one place
- **Real plan quota** — session / weekly / per-model, with reset countdowns and a **pace
  indicator** showing where you'd end up at the current burn rate.
- **Date ranges** — Today / 7d / 30d / All / Custom, re-cutting the *whole* page; a single-day
  range charts by the hour.
- **Cost** — three fixed KPI cards (5-hour window · last 24h · all time), per-day stacked token
  chart with per-model cost on hover, per-project burn, token mix and cache hit rate.
- **Activity** — 26-week heatmap, streaks, peak hour.
- Two surfaces, one codebase: a VS Code / Cursor / Antigravity extension, and a standalone web app.

---

## [0.10.0] — 2026-07-14

### Added
- **Pace indicator on every quota bar.** The bar tells you how much you've used; it cannot tell
  you whether you're on track to run out. A ghost marker (▾) now shows where you'd *end up* at
  the current burn rate, with a verdict line beneath: `13% used · 14% of the week gone · on pace
  for 93% by Mon 3:29 AM`. Colour follows the **projection**, not the current bar — 13% used
  looks comfortable until you notice only 14% of the week has passed.
  If you're on track to cap out early, it says *when*.
  Assumes a constant burn rate and real usage is bursty, so it is labelled a **pace indicator,
  not a forecast**, and it suppresses itself early in a window rather than printing a wild number.

### Changed
- **Readable reset times.** `145h 42m` → `6d · Mon 3:29 AM`. Two most significant units, plus the
  absolute clock time — a duration tells you the runway, a clock time tells you when to come back.
  Applies to the dashboard and the status-bar tooltip.

### Fixed
- Window length (5h session / 7d weekly) is **derived on read, never cached**. A cache written by
  an older build was serving limits without it, which silently suppressed the pace indicator —
  the same class of bug as the `plan.json` cache staleness fixed earlier.

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

[1.1.0]: https://github.com/panditfloki/live-claude-usage-ui/releases/tag/v1.1.0
[1.0.0]: https://github.com/panditfloki/live-claude-usage-ui/releases/tag/v1.0.0
[0.10.0]: https://github.com/panditfloki/live-claude-usage-ui/releases/tag/v0.10.0
[0.9.0]: https://github.com/panditfloki/live-claude-usage-ui/releases/tag/v0.9.0
