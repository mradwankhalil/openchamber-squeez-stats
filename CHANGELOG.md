# Changelog

OpenChamber offers **Update** for a git-installed copy when `version` in
`package.json` goes up. Each entry below is one such version.

## 0.5.1 — 2026-11-17

### Fixed

- **Stats came back up to a minute late after OpenChamber recovered.** When
  OpenChamber stalls for longer than the four quick retries (for example while
  it starts or restarts its backend, when other extensions fail at the same
  moment), the panel used to wait your full **Refresh every** interval before
  trying again. It now keeps trying every 15 seconds, or at your interval if
  that is shorter, for up to 10 minutes after the first failure, then returns
  to your interval. It still needs **Auto-refresh** on, still pauses while the
  panel is hidden or Settings is open, and still stops for problems only you
  can fix (service not approved, extension paused).
- The "not responding" banner now names the wait that is actually armed
  ("Next try in 15 seconds") instead of always naming your refresh interval.

### Not changed

- The long wait itself. Measured on a real squeez history and started exactly
  the way OpenChamber starts it, the service is ready in about a quarter of a
  second and answers its first request in under a second. The delay happens
  inside OpenChamber before a request reaches the service, so it affects every
  extension at once and has to be fixed there.

## 0.5.0 — 2026-11-17

Thanks to **[@milesbuckton](https://github.com/milesbuckton)**, who reported
the missing OpenCode folder in [#1](https://github.com/mradwankhalil/openchamber-squeez-stats/issues/1) and fixed it in
[#2](https://github.com/mradwankhalil/openchamber-squeez-stats/pull/2).

### Fixed

- **OpenCode-only setups now find their squeez data.** The squeez OpenCode
  plugin keeps its state in `~/.local/state/squeez/opencode`, or in
  `$XDG_STATE_HOME/squeez/opencode` when that variable is set. Discovery never
  looked there, so on a machine where squeez runs only through OpenCode the
  panel fell back to `~/.claude/squeez` and showed no event logs. Both folders
  are now checked. As before, the folder squeez wrote to most recently wins,
  and Claude Code's folder stays the fallback when none has logs.
- A startup test no longer depends on the exact date format of the installed
  ICU data, which made it fail on newer Node builds.

## 0.4.1 — 2026-11-17

The fix above, first published as a patch release. 0.5.0 has the same code and
adds the credit; releases that include a contributor's pull request get a new
minor version.

## 0.4.0 — 2026-11-17

The panel and the Work Status line now recover by themselves when the local
stats service is slow to start, crashes, or briefly stops answering. In 0.3.x,
the first failure stayed on screen until the next scheduled refresh, which is
a full minute with the default settings.

### Added

- **Automatic recovery after a failed refresh.** A temporary failure is
  retried up to four times, waiting 2, 4, 8 and 16 seconds between attempts.
  "Service still starting", "crashed", "no answer in time" and an HTTP 5xx all
  count as temporary. After that, the panel returns to your normal
  **Refresh every** interval. The waits add up to 30 seconds, but each attempt
  can itself take up to OpenChamber's 20-second request limit. A service that
  never answers can therefore keep the fast retries going for a little over
  two minutes before the normal interval takes over.
- **Your stats stay on screen while it reconnects.** A failed refresh no
  longer replaces the numbers you already had. The banner says
  "Reconnecting to the stats service", shows when the numbers on screen were
  fetched, and counts the attempts. The Work Status line keeps today's numbers
  and adds "Reconnecting · numbers from HH:MM:SS".
- **Connection history in Settings.** A new section, **Connection to the stats
  service**, lists the last few connection problems. Each entry says when the
  problem started, what kind of failure it was, what OpenChamber reported
  about the service at that moment, and whether and how quickly it recovered.
  The failure kinds are the service not starting, a request that got no
  answer, the service answering with an error, and not approved or paused.
  Only times, error codes and the service state are kept; see
  [Privacy and permissions](README.md#privacy-and-permissions).

### Fixed

- **A failed first refresh stayed on screen for a full minute.** When the
  service was still starting, or briefly failed, the panel showed the error
  and did not try again until the next scheduled refresh (60 seconds with the
  default settings). It now retries within seconds, as described above.
- **The Work Status line lost today's numbers on a failed refresh.** It
  replaced them with the error title. It now keeps the numbers and adds
  "Reconnecting · numbers from HH:MM:SS".
- **Overlapping requests.** Timer ticks, chat start/end, showing the panel and
  clicks could each send a request while another was still running. Now only
  one request runs at a time. A click or navigation during a slow request
  waits for it, then loads what you asked for.
- **Problems a retry cannot fix were retried every interval.** These are the
  local service not being approved, the extension being paused, and a request
  the service rejects. The panel now waits for you to press **Retry**, or for
  OpenChamber to reconnect the extension.
- **Last refreshed could show another view's time.** Switching to a view that
  had not loaded yet showed the time of a different view. It now shows the
  time of the stats actually on screen, or "not yet".
- With no stats loaded yet, an error no longer leaves "Preparing your stats"
  on screen underneath it.
- The smoke test starts its service without opening a console window on
  Windows.

### Changed

- **A hidden panel sends nothing on its own.** Showing it again refreshes once.
  This also covers a chat that started or ended while it was hidden, even
  with **Refresh automatically** off. The settings form is never refreshed
  under your typing.
- An answer for a view, period, location or setting you have already moved
  away from is discarded, never shown.

### Not changed

- The local service, what it reads and how it counts are unchanged.
- The panel does not restart the service itself. When the service has
  crashed, the next retry lets OpenChamber restart it, exactly as pressing
  **Retry** does.

## 0.3.3 — 2026-10-28

- Selecting a squeez folder with **Use this** or **Find automatically**
  refreshes the saved locations immediately.
- A draft location check that you have already replaced can no longer
  overwrite the newer result.

## 0.3.2 — 2026-10-28

- Cached stats are only reused for the exact view, period and file locations
  that produced them, so switching never shows another request's numbers.

## 0.3.1 — 2026-10-28

First tagged release: the rail panel (Overview, Sessions, Now, Storage,
Settings), the Work Status line, automatic squeez discovery, startup stages
and the last successful refresh time, plus the release script and CI checks.
