# Squeez Stats for OpenChamber

An OpenChamber extension that shows what squeez is saving you: the live
session, all-time token savings with per-command rankings, the blob store
footprint, and a daily savings series — in the extensions rail panel and in
the chat's Work Status panel.

```
Live session                          All-time
──────────────────────────            ──────────────────────────
Events tracked   194                  Tokens saved     ~24.2M
Tokens in|out    ~84K | ~52K          Ratio            3.4:1
Saved            ~31.7K               Commands tracked 11,064
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
