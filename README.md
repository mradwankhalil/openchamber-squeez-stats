# Squeez Stats for OpenChamber

An OpenChamber extension that shows what [squeez](https://github.com/claudioemmanuel/squeez)
has done, counted from the files squeez itself writes. Nothing is estimated
beyond squeez's own token estimates, and every section in the panel says in one
sentence what it counts.

- **Rail panel**: four views — Overview, Sessions, Now, Storage.
- **Work Status line**: today's numbers, e.g. `630.7K tokens cut today  −72%`
  / `from 862 shell commands · 335 tool outputs measured`.

## What squeez does, and what it records

squeez sits between the agent and its tools. For **shell commands** it rewrites
the output before the agent reads it (drops noise, caps long listings, stashes
huge outputs) and logs the size before and after. For **every other tool
result** (file reads, edits, searches, MCP tools, and the shell result again
after compression) it logs only the size. It never compresses those.

squeez keeps this under its home, `~/.claude/squeez`:

| File | What it holds | How the panel uses it |
|---|---|---|
| `sessions/YYYY-MM-DD-HH.jsonl` | Event log, one file per session-start hour (UTC). `bash` events: command, `in_tk`/`out_tk` (tokens before/after), files, errors, git lines, test summary. `tool` events: tool name, `tokens_est` (bytes ÷ 4). `git_snapshot` at session start. | **Source of every count.** Read once, cached per file, re-read only when a file changes. |
| `sessions/current.json` | The session squeez is tracking now: start, tool calls, tokens received, tokens saved, squeez's own overhead. | Now view. |
| `sessions/context.json` | That session's working context: counters (reset each session), last context-window reading, call log, recurring errors, edited files (kept across sessions). | Now view. |
| `memory/summaries.jsonl` | One record per finished session: duration, files, errors, git, next steps, squeez's efficiency score. Pruned after `memory_retention_days`. | Session start times and the per-session record. |
| `sessions/handler_stats.json` | Totals per first word of the command line, capped at 64 names. | Storage view only (see below). |
| `blobs/` | Stashed oversized outputs plus a search index. | Storage view. |
| `config.ini` | Settings. | Storage view. |

## What the numbers mean

- **Tokens cut / saved** — for each shell command, `max(0, before − after)`,
  summed. The same rule squeez uses for its own session counter.
- **Shorter %** — saved ÷ before.
- **Shortened / Unchanged / Got longer** — per shell command: output got
  smaller, stayed the same size, or grew (squeez added a note).
- **Tool outputs** — count and size of every tool result squeez tracked. Measured,
  not compressed.
- **Command names** — the program a command line actually runs:
  `cd repo && git log` → `git`, `FOO=1 timeout 30 node a.js` → `node`,
  `for f in *; do sed …; done` → `sed`, `n=$(grep …)` → `grep`.
- **A squeez session** runs from one agent start to the next start **anywhere on
  the machine**. Sub-agents and parallel chats each start one, so there are many
  short sessions, and a session is not the same thing as an OpenChamber chat.
  Events belong to the session whose window they fall in.

## The views

- **Overview** (Today / 7 days / 30 days / All): tokens cut, shortened vs
  unchanged, tool outputs, sessions started; an hour-by-hour or day-by-day chart
  (tokens saved, shell commands or tool outputs); time of day; where the
  savings come from; what squeez barely shortens; biggest single outputs; tool
  outputs by tool; errors, files, git lines and test summaries seen in shell
  output.
- **Sessions**: every session started in the range with its length, tokens cut,
  commands and tool calls (empty ones hidden by default). Opening one shows
  squeez's record of it (score breakdown, files, errors, next steps) and the full
  Overview breakdown for its window.
- **Now**: the session squeez is tracking right now. Tokens cut, everything the
  agent received, squeez's own overhead and the net; the context-window reading;
  output by kind; dedup, re-reads, summarising and sub-agents; the call log;
  recurring errors and most-edited files.
- **Storage**: log, record and blob sizes and date ranges; recovered and
  unreadable lines; the per-command table's fill; all settings.

## Things in squeez's data the panel deliberately does not trust

- **`tokens_saved` in session records** re-counts the whole hourly log at the
  end of each session, so sessions that share an hour count each other's work
  (summed, it reports more than 8× what the events show). The panel recounts from events.
  Reported upstream: [squeez#284](https://github.com/claudioemmanuel/squeez/issues/284).
- **`handler_stats.json`** stops adding names once it holds 64, and it keys on
  the first word (`cd`, `export`, `"C:/Program`). Once full it silently misses
  most commands, so it is shown only as a storage fact, never as a total.
  Reported upstream: [squeez#285](https://github.com/claudioemmanuel/squeez/issues/285).
- **Merged log lines**: concurrent writers sometimes put two events on one line
  (`}{`). The panel splits and recovers them, and reports how many.
- **Dollar figures** were removed: a saved token's value depends on the model
  and on how many later turns would have re-read it, and nothing on disk records
  either.

## Install

In OpenChamber, open **Settings → Extensions**, add this repo (or a local
folder path), and approve the dialog — it includes **Run a local service**,
which is what reads squeez's files. The squeez icon appears on the extensions
rail, and "Squeez" is available in the chat's Work Status section list.

To point at a different squeez home, set `SQUEEZ_STATS_HOME` for the service.

## Layout

```
service/store.ts    readers for every squeez file, change-aware cache, line recovery
service/report.ts   pure aggregations and the payload types the panel imports
service/main.ts     HTTP routes: /status /overview /sessions /session /now /storage
panel/main.ts       the four views and the Work Status line
panel/panel.css     styles (host theme tokens; nothing smaller than 0.9rem)
tests/              bun unit tests for parsing and aggregation
scripts/smoke.mjs   runs the built service against a fixture squeez home
```

## Develop

OpenChamber never compiles an extension: `panel/main.js` and
`service/main.js` are built and committed. Rebuild and commit them with every
change.

```
bun install
bun run build      # bundles panel/main.js and service/main.js
bun run typecheck
bun test           # unit tests
node scripts/smoke.mjs
```
