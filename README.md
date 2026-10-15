# Squeez Stats for OpenChamber

An OpenChamber extension that shows what squeez is saving you: the live
session, scoped token savings (all time / single session log / day range)
with per-command rankings, the blob store footprint, and a daily savings
series — in the extensions rail panel and in the chat's Work Status panel.

```
Live session                          Aggregate  [All time | Today | 7d | 30d | session log…]
──────────────────────────            ──────────────────────────
Events tracked   194                  Tokens saved     ~24.2M
Tokens in|out    ~84K | ~52K          Est. value       $2.88 – $45.82
Saved            ~31.7K               Ratio            3.4:1
                                      [donut + top commands bar chart]
Blob store
──────────────────────────
Stashed outputs  1,774 · 12.8 MB      Tokens saved per day [column chart]
```

## What it reads

The squeez home directory (`~/.claude/squeez`):

- `sessions/current.json` — live session pointer and counters
- `sessions/handler_stats.json` — all-time per-command token arrays
- `sessions/*.jsonl` — per-event logs (bash/tool events with in/out tokens)
- `blobs/` — stashed oversized outputs

To point at a different home, set `SQUEEZ_STATS_HOME` for the service.

## Scope selector

The aggregate section header is a picker: **All time** (from
`handler_stats.json`), **Today**, **Last 7 days**, **Last 30 days**, or any
individual session log file. Scoped views are aggregated from the per-event
logs — per-command bars then show real command names (`git`, `python`, …)
instead of handler categories. Metrics, donut, bars and the daily series all
follow the selection.

## How dollar figures are computed

Saved tokens are priced at your models' real rates:

- **Model mix** — OpenCode's `opencode.db` (opened read-only) records every
  session's model and token usage; the mix for the selected window is weighted
  by input-side tokens (input + cache read), because squeezed-away tokens
  would have been prompt tokens.
- **Rates** — [models.dev](https://models.dev) `api.json`, cached on disk for
  24 h at `~/.config/openchamber/squeez-stats-pricing.json`.

The value is a range: the lower bound prices every saved token at cache-read
rates, the upper bound at full input rates. Hover the figure for the basis and
rate coverage. If the database is missing or no model matches a rate, dollar
rows are simply omitted. Set `OPENCODE_DB_PATH` to point at a specific
database file.

## Install

In OpenChamber, open **Settings → Extensions**, add this repo (or a local
folder path), and approve the dialog — it includes **Run a local service**,
which is what reads the stats. The squeez icon then appears on the extensions
rail; the "Squeez" section is available in the chat's Work Status panel
section list.

## Develop

OpenChamber never compiles an extension: `panel/main.js` and
`service/main.js` are built and committed. Rebuild and commit them with every
change.

```
bun install
bun run build      # bundles panel/main.js and service/main.js
bun run typecheck
node scripts/smoke.mjs
```
