# Squeez Stats for OpenChamber

<img src="icon.svg" alt="" width="72" align="right">

An [OpenChamber](https://github.com/openchamber/openchamber) extension that shows
what [squeez](https://github.com/claudioemmanuel/squeez) has done for your agents:
how many tokens it cut from shell output, where the savings come from, what it
barely shortens, every session it tracked, and what it keeps on disk.

Everything is counted from the files squeez itself writes. Nothing is sent
anywhere, nothing is estimated beyond squeez's own token counts, and every
section in the panel says in one sentence what it counts.

- **Rail panel** with four views: **Overview**, **Sessions**, **Now** and
  **Storage**, plus **Settings**.
- **Work Status line** in the chat: today's numbers, e.g.
  `630.7K tokens cut today  −72%` / `from 862 shell commands · 335 tool outputs measured`.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [First run: finding squeez's files](#first-run-finding-squeezs-files)
- [Settings](#settings)
- [The views](#the-views)
- [What squeez does, and what it records](#what-squeez-does-and-what-it-records)
- [What the numbers mean](#what-the-numbers-mean)
- [Things in squeez's data the panel deliberately does not trust](#things-in-squeezs-data-the-panel-deliberately-does-not-trust)
- [Privacy and permissions](#privacy-and-permissions)
- [Troubleshooting](#troubleshooting)
- [Develop](#develop)
- [Releases and update checks](#releases-and-update-checks)
- [License](#license)

## Requirements

- OpenChamber **2.0.4** or newer (desktop or web).
- squeez installed and used by at least one agent (Claude Code, OpenCode,
  Codex, Copilot, Gemini, pi, Hermes…). The panel only reads squeez's files; it
  works with any squeez version that writes the hourly event logs.
- Windows, macOS or Linux. The service runs on OpenChamber's own runtime, so a
  separate Node.js install is not needed.

## Install

1. In OpenChamber, open **Settings → Extensions → Add**.
2. Paste this repository's URL:

   ```
   https://github.com/mradwankhalil/openchamber-squeez-stats
   ```

   (or a local folder path, if you cloned it).
3. Approve the dialog. It asks for **Run a local service**: that small process
   is what reads squeez's files on your machine (see
   [Privacy and permissions](#privacy-and-permissions)).
4. The lightning icon appears on the extensions rail. "Squeez" is also
   available in the chat's **Work Status** section list.

To update, use **Update** on the extension in Settings → Extensions. The built
files are committed, so there is no build step on install.

On first open, the panel shows its startup stage immediately: connecting to
OpenChamber, loading saved settings, then preparing stats from local squeez
history. Starting the service and building its in-memory cache can take longer
than later refreshes. There is no guessed progress percentage. Below **Refresh**
and **Settings**, **Last refreshed** shows the local date and time of the last
successful stats response, including silent automatic refreshes. Failed
requests leave that timestamp unchanged.

## First run: finding squeez's files

You normally do nothing. The service looks in every place squeez keeps its
state, one per host it supports:

| Folder | Used when squeez was set up for |
|---|---|
| `~/.claude/squeez` | Claude Code (squeez's default store) |
| `~/.copilot/squeez` | GitHub Copilot CLI |
| `~/.codex/squeez` | Codex |
| `~/.gemini/squeez` | Gemini CLI |
| `~/.hermes/squeez` | Hermes |
| `~/.pi/squeez` | pi |
| `~/.config/opencode/squeez` | OpenCode |

`~` is your user folder (`C:\Users\<you>` on Windows). If the service's
environment sets `SQUEEZ_STATS_HOME` or `SQUEEZ_DIR`, that folder is tried
first. Among the folders that exist, the one squeez wrote to **most recently**
is used.

If nothing is found, or the wrong store is picked, the panel says so and offers
**Choose squeez's files…**, which opens **Settings → squeez's files**. There you
can:

- see every location the panel reads and whether it exists (**found**,
  **missing**, **not there**);
- see every place squeez can live, with how many event logs each has and when it
  was last written, and pick one with **Use this**;
- type any location yourself: the squeez folder, or each file and folder
  separately (event logs folder, session records file, stashed outputs folder,
  config file). Empty fields use the default inside the squeez folder. Paths must
  be absolute. **Check** tests what you typed without saving; **Save locations**
  keeps it; **Find automatically** goes back to discovery.

Only the event logs folder is required. The other files add detail (session
records, stashed outputs, squeez's settings) and their sections simply hide when
they are missing.

## Settings

Open them with **Settings** in the panel header. They are saved in the
extension's storage on the OpenChamber server, so the panel and the Work Status
line share them, and they survive restarts and updates.

| Setting | Default | What it does |
|---|---|---|
| Refresh automatically | on | Updates the numbers by themselves. Off: only the **Refresh** button and chat start/end update them. |
| Refresh every | 1 minute | 15 s, 30 s, 1, 2, 5, 10 or 30 minutes. Background refreshes are silent: no spinner, and the page only repaints when the numbers changed, so the scroll position stays put. |
| Default period | 30 days | The period Overview and Sessions open with (Today, 7 days, 30 days, All). |
| Show empty sessions | off | Lists sessions that started and ended without running anything. |
| List lengths | see below | How many rows each list shows, 3 to 50. |
| squeez's files | found automatically | See [First run](#first-run-finding-squeezs-files). |

List lengths, with their defaults:

| Overview and sessions | Rows | Now | Rows |
|---|---|---|---|
| Where the savings come from | 12 | Latest calls | 12 |
| What squeez barely shortens | 8 | Recurring errors | 8 |
| Biggest single outputs | 6 | Most-edited files | 10 |
| Tool outputs | 12 | Repeated commands | 8 |
| Errors in shell output | 8 | | |
| Files mentioned | 10 | | |
| Git activity | 10 | | |
| Test results | 8 | | |

**Reset all settings** returns to every default above.

## The views

- **Overview** (Today / 7 days / 30 days / All): tokens cut, commands shortened
  vs unchanged vs grown, tool outputs, sessions started; an hour-by-hour (up to
  two days) or day-by-day chart of tokens saved, shell commands or tool outputs;
  time of day; where the savings come from; what squeez barely shortens; biggest
  single outputs; tool outputs by tool; errors, files, git lines and test
  summaries seen in shell output.
- **Sessions**: every squeez session started in the period, with its length,
  tokens cut, commands and tool calls. Opening one shows squeez's own record of
  it (score breakdown, files, errors, next steps) and the full Overview breakdown
  for its time window.
- **Now**: the session squeez is tracking right now. Tokens cut, everything the
  agent received, squeez's own overhead and the net; the last context-window
  reading; output by kind; repeats caught, re-reads, summarising and sub-agents;
  the call log; recurring errors and most-edited files.
- **Storage**: every location read, log/record/blob sizes and date ranges,
  recovered and unreadable lines, how full squeez's per-command table is, and
  squeez's `config.ini`.

## What squeez does, and what it records

squeez sits between the agent and its tools. For **shell commands** it rewrites
the output before the agent reads it (drops noise, caps long listings, stashes
huge outputs) and logs the size before and after. For **every other tool
result** (file reads, edits, searches, MCP tools, and the shell result again
after compression) it logs only the size. It never compresses those.

Inside its folder squeez keeps:

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

- **Tokens cut / saved**: for each shell command, `max(0, before − after)`,
  summed. The same rule squeez uses for its own session counter.
- **Shorter %**: saved ÷ before.
- **Shortened / Unchanged / Got longer**: per shell command, the output got
  smaller, stayed the same size, or grew (squeez added a note).
- **Tool outputs**: count and size of every tool result squeez tracked.
  Measured, not compressed.
- **Command names**: the program a command line actually runs:
  `cd repo && git log` → `git`, `FOO=1 timeout 30 node a.js` → `node`,
  `for f in *; do sed …; done` → `sed`, `n=$(grep …)` → `grep`.
- **A squeez session** runs from one agent start to the next start **anywhere on
  the machine**. Sub-agents and parallel chats each start one, so there are many
  short sessions, and a session is not the same thing as an OpenChamber chat.
  Events belong to the session whose time window they fall in.
- **No dollar figures**: a saved token's value depends on the model and on how
  many later turns would have re-read it, and nothing on disk records either.

## Things in squeez's data the panel deliberately does not trust

- **`tokens_saved` in session records** re-counts the whole hourly log at the
  end of each session, so sessions that share an hour count each other's work
  (summed, it can report several times what the events show). The panel
  recounts from events. Reported upstream:
  [squeez#284](https://github.com/claudioemmanuel/squeez/issues/284).
- **`handler_stats.json`** stops adding names once it holds 64, and it keys on
  the first word (`cd`, `export`, `"C:/Program`). Once full it silently misses
  most commands, so it is shown only as a storage fact, never as a total.
  Reported upstream:
  [squeez#285](https://github.com/claudioemmanuel/squeez/issues/285).
- **Merged log lines**: concurrent writers sometimes put two events on one line
  (`}{`). The panel splits and recovers them, and reports how many.

## Privacy and permissions

- The only capability requested is **service**: OpenChamber starts
  `service/main.js` on `127.0.0.1` with a random port and token. Only this
  extension's panel can reach it, through OpenChamber.
- The service only **reads** files. It never writes to squeez's folder, runs
  commands or opens network connections.
- It reads the squeez locations described above, or the ones you enter in
  Settings. Entered paths must be absolute.
- Settings are stored in OpenChamber's extension storage and deleted when the
  extension is uninstalled.

## Troubleshooting

| You see | Do this |
|---|---|
| "Local service not approved" | Settings → Extensions → Squeez Stats → allow **Run a local service**, then Retry. |
| "squeez's event logs were not found" | Is squeez installed and has an agent run a command through it? Then press **Choose squeez's files…** and pick or enter the folder. |
| Numbers look like another machine's or another host's | Settings → squeez's files → the list of places shows every store; pick the right one with **Use this**. |
| "Stats service is not responding" | Retry. If it persists, restart OpenChamber. |
| Numbers do not change | Check **Refresh automatically** in Settings, or press **Refresh**. |
| A list is too short or too long | Settings → List lengths. |

## Develop

OpenChamber never compiles an extension: `panel/main.js` and `service/main.js`
are built and committed. Rebuild and commit them with every change.

```sh
bun install
bun run build      # bundles panel/main.js and service/main.js
bun run typecheck
bun test           # unit tests: parsing, aggregation, discovery, settings limits
node scripts/smoke.mjs   # runs the built service against a throwaway squeez folder
```

To try a change, add your clone's folder in Settings → Extensions; reopen the
panel after each build.

```
service/store.ts    readers for every squeez file, discovery, change-aware cache, line recovery
service/report.ts   pure aggregations, list limits, and the payload types the panel imports
service/main.ts     HTTP routes: /status /overview /sessions /session /now /storage /locations
panel/main.ts       the four views, Settings, and the Work Status line
panel/panel.css     styles (host theme tokens; nothing smaller than 0.9rem)
tests/              bun unit tests
scripts/smoke.mjs   end-to-end check of the built service
icon.svg            rail icon
```

Service routes all take optional `home`, `sessions`, `summaries`, `blobs` and
`config` (absolute paths) and `limits` (a JSON object of list lengths); see the
header of `service/main.ts`.

## Releases and update checks

Git-installed copies receive an **Update** offer in OpenChamber's
**Settings → Extensions** when the repository's `package.json` version is
higher than the installed version. Code changes alone do not trigger an offer.
Local-folder installs run directly from that folder and do not receive update
offers; install from the repository URL to follow published updates.

### Cut a release locally

Commit your source changes first, including rebuilt bundles. With a clean
working tree, normally on `main`, run:

```sh
bun run release patch --dry-run  # verify without creating a release
bun run release patch           # fixes: 0.3.0 → 0.3.1
# or: bun run release minor     # features: 0.3.0 → 0.4.0
```

The script runs `bun run verify` (build, typecheck, unit tests and the service
smoke test), bumps the version, commits `package.json` and the built bundles,
and creates an annotated `vX.Y.Z` tag. It also accepts `major` or an explicit
higher `x.y.z` version. **It never pushes.** If verification fails, no release
commit or tag is created; a build may leave regenerated bundles to inspect.

After reviewing the release, publish separately from `main`:

```sh
git push origin main --follow-tags
```

### CI safeguards

`.github/workflows/ci.yml` checks pushes and pull requests targeting `main`:

- Committed `panel/main.js` and `service/main.js` must match a fresh build.
- Typecheck, unit tests and the built-service smoke test must pass.
- Changes to shipped files or the runtime manifest/dependencies require a
  higher version. Documentation, tests and tooling alone need no bump.

Run the same verification locally with `bun run verify`. To compare versions
and shipped changes against a base commit, use
`bun run check:release origin/main`.

CI reports failures **after a push**; it does not reject the push or prevent
OpenChamber from reading that commit. To block unverified merges, configure a
GitHub branch protection rule or ruleset for `main` requiring pull requests
and the `verify` status check. This repository's workflow does not configure
those GitHub settings itself.

### What belongs in the repository

Keep runtime assets and built bundles, source, the lockfile, documentation,
license, tests, release tooling and CI. OpenChamber installs the committed
bundles without compiling them. `.gitignore` excludes dependencies, local
agent/index state, reports, editor files, logs, temporary output, environment
files and archives. It does not remove previously tracked files or rewrite
history; obsolete tracked files must be deleted in a normal commit.

## License

[MIT](LICENSE)
