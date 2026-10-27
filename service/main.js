// service/main.ts
import http from "node:http";

// service/report.ts
var PRELUDE = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "set",
  "unset",
  "source",
  ".",
  "shopt",
  "trap",
  "true",
  ":",
  "local",
  "declare",
  "for",
  "while",
  "until",
  "if",
  "case",
  "do",
  "then",
  "else",
  "elif",
  "done",
  "fi",
  "esac",
  "[",
  "[[",
  "exit"
]);
var WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "exec", "nice", "stdbuf", "&"]);
var BODY_KEYWORD = /^\s*(?:do|then|else|elif)\s+/;
var SUBSTITUTION = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*[A-Za-z_]\w*=(?:\$\(|`)\s*([\s\S]*)$/;
function tokenize(segment) {
  return segment.match(/(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g) ?? [];
}
function bare(word) {
  const unquoted = word.replace(/^["']|["']$/g, "");
  const base = unquoted.split(/[\\/]/).pop() ?? unquoted;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}
function programOf(segment) {
  const body = segment.replace(BODY_KEYWORD, "");
  const sub = SUBSTITUTION.exec(body);
  if (sub)
    return programOf(sub[1] ?? "");
  const tokens = tokenize(body.trim().replace(/^[({]+\s*/, ""));
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(bare(t))) {
      i++;
      while (i < tokens.length && /^(-\S*|\d+)$/.test(tokens[i] ?? ""))
        i++;
      continue;
    }
    if (bare(t) === "timeout") {
      i++;
      while (i < tokens.length && /^(-\S+|\d+[smhd]?)$/.test(tokens[i] ?? ""))
        i++;
      continue;
    }
    break;
  }
  const raw = tokens[i];
  return raw ? bare(raw) : "";
}
function commandName(cmd) {
  const segments = cmd.split(/\r?\n|&&|\|\||;|\|/);
  let fallback = "";
  for (const segment of segments) {
    const name = programOf(segment);
    if (!name)
      continue;
    if (!fallback)
      fallback = name;
    if (PRELUDE.has(name))
      continue;
    if (name === "echo" && segments.length > 1)
      continue;
    return name;
  }
  return fallback || "(empty)";
}
function toolLabel(tool) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  if (m)
    return { name: m[2] ?? tool, server: m[1] ?? "" };
  return { name: tool, server: "" };
}
function lowerBound(events, ts) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if ((events[mid]?.ts ?? 0) < ts)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}
function slice(events, start, end) {
  return events.slice(lowerBound(events, start), lowerBound(events, end));
}
function localDayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function nextLocalDay(ms) {
  const d = new Date(ms);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function localHourStart(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function dayLabel(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hourLabel(ms) {
  return `${pad(new Date(ms).getHours())}:00`;
}
var MAX_DAY_BUCKETS = 400;
var HOUR_SPAN_LIMIT = 48 * 3600000;
function emptyTotals() {
  return { commands: 0, inTokens: 0, outTokens: 0, savedTokens: 0, compressed: 0, unchanged: 0, grew: 0 };
}
function addShell(totals, e) {
  totals.commands++;
  totals.inTokens += e.inTk;
  totals.outTokens += e.outTk;
  if (e.inTk > e.outTk) {
    totals.savedTokens += e.inTk - e.outTk;
    totals.compressed++;
  } else if (e.inTk === e.outTk)
    totals.unchanged++;
  else
    totals.grew++;
}
function bump(map, text, ts) {
  const key = text.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!key)
    return;
  const row = map.get(key);
  if (row) {
    row.count++;
    if (ts > row.last)
      row.last = ts;
  } else
    map.set(key, { text: key, count: 1, last: ts });
}
function buildWindowReport(allEvents, sessionStarts, start, end) {
  const events = slice(allEvents, start, end);
  const firstEvent = events[0]?.ts ?? null;
  const lastEvent = events[events.length - 1]?.ts ?? null;
  const shell = emptyTotals();
  const tools = { calls: 0, tokens: 0 };
  const commands = new Map;
  const toolMap = new Map;
  const errors = new Map;
  const files = new Map;
  const git = new Map;
  const tests = [];
  const largest = [];
  const hourOfDay = Array.from({ length: 24 }, (_, hour) => ({ hour, commands: 0, toolCalls: 0 }));
  const stop = Math.min(end, Date.now());
  const from = start > 0 ? start : firstEvent ?? stop;
  const granularity = stop - from <= HOUR_SPAN_LIMIT ? "hour" : "day";
  const series = [];
  if (firstEvent !== null) {
    let cursor = granularity === "hour" ? localHourStart(from) : localDayStart(Math.max(from, firstEvent));
    while (cursor < stop && series.length < (granularity === "hour" ? 49 : MAX_DAY_BUCKETS)) {
      series.push({
        start: cursor,
        label: granularity === "hour" ? hourLabel(cursor) : dayLabel(cursor),
        commands: 0,
        savedTokens: 0,
        inTokens: 0,
        outTokens: 0,
        toolCalls: 0,
        toolTokens: 0
      });
      cursor = granularity === "hour" ? cursor + 3600000 : nextLocalDay(cursor);
    }
  }
  let bucket = 0;
  const pointFor = (ts) => {
    while (bucket + 1 < series.length && (series[bucket + 1]?.start ?? Infinity) <= ts)
      bucket++;
    const p = series[bucket];
    return p && p.start <= ts ? p : null;
  };
  for (const e of events) {
    if (e.kind === "bash") {
      addShell(shell, e);
      const name = commandName(e.cmd);
      const row = commands.get(name) ?? { name, runs: 0, inTokens: 0, outTokens: 0, savedTokens: 0, compressedRuns: 0 };
      row.runs++;
      row.inTokens += e.inTk;
      row.outTokens += e.outTk;
      if (e.inTk > e.outTk) {
        row.savedTokens += e.inTk - e.outTk;
        row.compressedRuns++;
      }
      commands.set(name, row);
      for (const err of e.errors)
        bump(errors, err, e.ts);
      for (const f of e.files)
        bump(files, f, e.ts);
      for (const g of e.git)
        bump(git, g, e.ts);
      if (e.test.trim())
        tests.push({ text: e.test.trim().slice(0, 200), ts: e.ts });
      if (e.inTk > 0) {
        largest.push({ cmd: e.cmd.slice(0, 240), inTokens: e.inTk, outTokens: e.outTk, ts: e.ts });
        if (largest.length > 40) {
          largest.sort((a, b) => b.inTokens - a.inTokens);
          largest.length = 10;
        }
      }
      hourOfDay[new Date(e.ts).getHours()].commands++;
      const p = pointFor(e.ts);
      if (p) {
        p.commands++;
        p.inTokens += e.inTk;
        p.outTokens += e.outTk;
        if (e.inTk > e.outTk)
          p.savedTokens += e.inTk - e.outTk;
      }
    } else if (e.kind === "tool") {
      tools.calls++;
      tools.tokens += e.tokens;
      addTool(toolMap, e);
      hourOfDay[new Date(e.ts).getHours()].toolCalls++;
      const p = pointFor(e.ts);
      if (p) {
        p.toolCalls++;
        p.toolTokens += e.tokens;
      }
    }
  }
  const rows = [...commands.values()];
  largest.sort((a, b) => b.inTokens - a.inTokens);
  return {
    start,
    end,
    firstEvent,
    lastEvent,
    shell,
    tools,
    sessionsStarted: sessionStarts.filter((s) => s >= start && s < end).length,
    granularity,
    series,
    hourOfDay,
    topCommands: rows.filter((r) => r.savedTokens > 0).sort((a, b) => b.savedTokens - a.savedTokens).slice(0, 12),
    weakCommands: rows.filter((r) => r.outTokens > 0 && r.savedTokens < r.inTokens * 0.1).sort((a, b) => b.outTokens - a.outTokens).slice(0, 8),
    largestOutputs: largest.slice(0, 6),
    toolsByName: [...toolMap.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
    errors: topCounts(errors, 8),
    files: topCounts(files, 10),
    git: [...git.values()].sort((a, b) => b.last - a.last).slice(0, 10),
    tests: tests.slice(-8).reverse()
  };
}
function addTool(map, e) {
  const row = map.get(e.tool);
  if (row) {
    row.calls++;
    row.tokens += e.tokens;
  } else {
    const { name, server } = toolLabel(e.tool);
    map.set(e.tool, { name, server, calls: 1, tokens: e.tokens });
  }
}
function topCounts(map, n) {
  return [...map.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, n);
}
function sessionStarts(summaries, current) {
  const set = new Set;
  for (const s of summaries)
    set.add(s.start);
  if (current)
    set.add(current.start);
  return [...set].sort((a, b) => a - b);
}
var MAX_SESSION_ROWS = 300;
function buildSessions(allEvents, summaries, current, start, end, now) {
  const starts = sessionStarts(summaries, current);
  const byStart = new Map;
  for (const s of summaries)
    byStart.set(s.start, s);
  const rows = [];
  let active = 0;
  let empty = 0;
  for (let i = 0;i < starts.length; i++) {
    const s = starts[i] ?? 0;
    if (s < start || s >= end)
      continue;
    const row = sessionRow(allEvents, starts, i, byStart, current, now);
    if (row.shellCommands + row.toolCalls > 0)
      active++;
    else
      empty++;
    rows.push(row);
  }
  rows.reverse();
  const total = rows.length;
  return { total, active, empty, rows: rows.slice(0, MAX_SESSION_ROWS), truncated: total > MAX_SESSION_ROWS };
}
function sessionRow(allEvents, starts, i, byStart, current, now) {
  const s = starts[i] ?? 0;
  const next = starts[i + 1];
  const ongoing = next === undefined && current !== null && current.start === s;
  const end = next ?? (ongoing ? now : s + (byStart.get(s)?.durationMin ?? 0) * 60000);
  const totals = emptyTotals();
  let toolCalls = 0;
  let toolTokens = 0;
  for (const e of slice(allEvents, s, Math.max(end, s + 1))) {
    if (e.kind === "bash")
      addShell(totals, e);
    else if (e.kind === "tool") {
      toolCalls++;
      toolTokens += e.tokens;
    }
  }
  const summary = byStart.get(s);
  return {
    start: s,
    end,
    ongoing,
    shellCommands: totals.commands,
    inTokens: totals.inTokens,
    outTokens: totals.outTokens,
    savedTokens: totals.savedTokens,
    toolCalls,
    toolTokens,
    summary: summary ? {
      filesTouched: summary.filesTouchedCount,
      errors: summary.errors.length,
      gitEvents: summary.gitEvents.length,
      scoreOverall: summary.score.overall
    } : null
  };
}
function buildSessionDetail(allEvents, summaries, current, sessionStart, now) {
  const starts = sessionStarts(summaries, current);
  const i = starts.indexOf(sessionStart);
  if (i < 0)
    return { row: null, summary: null, report: null };
  const byStart = new Map;
  for (const s of summaries)
    byStart.set(s.start, s);
  const row = sessionRow(allEvents, starts, i, byStart, current, now);
  return {
    row,
    summary: byStart.get(sessionStart) ?? null,
    report: buildWindowReport(allEvents, starts, row.start, Math.max(row.end, row.start + 1))
  };
}
function handlerSummary(rows, max) {
  let calls = 0;
  let inTokens = 0;
  let outTokens = 0;
  for (const r of rows) {
    calls += r.calls;
    inTokens += r.inTokens;
    outTokens += r.outTokens;
  }
  return {
    used: rows.length,
    max,
    rows: [...rows].sort((a, b) => b.inTokens - b.outTokens - (a.inTokens - a.outTokens)).slice(0, 12),
    calls,
    inTokens,
    outTokens
  };
}
function trimContext(ctx) {
  if (!ctx)
    return null;
  return {
    ...ctx,
    recentCalls: ctx.recentCalls.slice(0, 12),
    repeatedErrors: ctx.repeatedErrors.slice(0, 8),
    fileEdits: ctx.fileEdits.slice(0, 10),
    repeatedCommands: ctx.repeatedCommands.slice(0, 8)
  };
}

// service/store.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
var HANDLER_TABLE_MAX = 64;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function str(value) {
  return typeof value === "string" ? value : "";
}
function strArray(value, cap = Infinity) {
  if (!Array.isArray(value))
    return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim())
      out.push(item);
    if (out.length >= cap)
      break;
  }
  return out;
}
function numArray(value) {
  return Array.isArray(value) ? value.map(num) : [];
}
function splitObjects(line) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0;i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (escaped)
        escaped = false;
      else if (c === "\\")
        escaped = true;
      else if (c === '"')
        inString = false;
      continue;
    }
    if (c === '"')
      inString = true;
    else if (c === "{") {
      if (depth === 0)
        start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(line.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}
function toEvent(raw) {
  if (!isRecord(raw))
    return null;
  const ts = num(raw.ts) * 1000;
  if (ts <= 0)
    return null;
  switch (str(raw.type)) {
    case "bash":
      return {
        kind: "bash",
        ts,
        cmd: str(raw.cmd),
        inTk: Math.max(0, num(raw.in_tk)),
        outTk: Math.max(0, num(raw.out_tk)),
        files: strArray(raw.files, 50),
        errors: strArray(raw.errors, 20),
        git: strArray(raw.git, 20),
        test: str(raw.test_summary)
      };
    case "tool":
      return { kind: "tool", ts, tool: str(raw.tool) || "unknown", tokens: Math.max(0, num(raw.tokens_est)) };
    case "git_snapshot":
      return { kind: "git", ts };
    default:
      return null;
  }
}
function parseLog(text) {
  const events = [];
  let recovered = 0;
  let unreadable = 0;
  for (const line of text.split(`
`)) {
    const trimmed = line.trim();
    if (!trimmed)
      continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const parts = splitObjects(trimmed);
      let any = false;
      for (const part of parts) {
        try {
          const event2 = toEvent(JSON.parse(part));
          if (event2) {
            events.push(event2);
            recovered++;
            any = true;
          }
        } catch {}
      }
      if (!any)
        unreadable++;
      continue;
    }
    const event = toEvent(parsed);
    if (event)
      events.push(event);
  }
  return { events, recovered, unreadable };
}
function bp(value) {
  return Math.min(1e4, Math.max(0, num(value)));
}
function toSummary(raw) {
  if (!isRecord(raw))
    return null;
  const startSec = num(raw.valid_from) || num(raw.ts);
  if (startSec <= 0)
    return null;
  const filesTouched = Array.isArray(raw.files_touched) ? raw.files_touched : [];
  const filesCommitted = Array.isArray(raw.files_committed) ? raw.files_committed : [];
  return {
    start: startSec * 1000,
    durationMin: num(raw.duration_min),
    filesTouched: strArray(filesTouched, 30),
    filesTouchedCount: filesTouched.length,
    filesCommittedCount: filesCommitted.length,
    errors: strArray(raw.errors_resolved, 10),
    gitEvents: strArray(raw.git_events, 10),
    testSummary: str(raw.test_summary),
    completed: strArray(raw.completed, 5),
    nextSteps: strArray(raw.next_steps, 5),
    score: {
      overall: bp(raw.efficiency_overall_bp),
      compression: bp(raw.compression_ratio_bp),
      toolChoice: bp(raw.tool_choice_efficiency_bp),
      reuse: bp(raw.context_reuse_rate_bp),
      budget: bp(raw.budget_utilization_bp)
    }
  };
}
function toCurrent(raw) {
  if (!isRecord(raw))
    return null;
  const start = num(raw.start_ts) * 1000;
  if (start <= 0)
    return null;
  return {
    sessionFile: str(raw.session_file),
    start,
    receivedTokens: num(raw.total_tokens),
    savedTokens: num(raw.tokens_saved),
    trackedCalls: num(raw.total_calls),
    overheadTokens: num(raw.overhead_tokens)
  };
}
function zip(a, b) {
  const n = Math.min(a.length, b.length);
  const out = [];
  for (let i = 0;i < n; i++)
    out.push([a[i], b[i]]);
  return out;
}
function toContext(raw) {
  if (!isRecord(raw))
    return null;
  const callN = numArray(raw.call_log_n);
  const callCmd = strArrayKeepEmpty(raw.call_log_cmd);
  const callLen = numArray(raw.call_log_len);
  const recentCalls = zip(zip(callN, callCmd), callLen).map(([[n, label], bytes]) => ({ n, label, bytes })).reverse();
  const snippetText = new Map;
  for (const [fp, text] of zip(numArray(raw.error_snippet_fp), strArrayKeepEmpty(raw.error_snippet_text))) {
    if (text)
      snippetText.set(fp, text);
  }
  const repeatedErrors = zip(numArray(raw.error_count_fp), numArray(raw.error_count_n)).map(([fp, count]) => ({ text: snippetText.get(fp) ?? "", count })).filter((e) => e.text && e.count > 0).sort((a, b) => b.count - a.count);
  const fileEdits = zip(strArrayKeepEmpty(raw.file_mod_path), numArray(raw.file_mod_n)).map(([p, count]) => ({ path: p, count })).filter((f) => f.path && f.count > 0).sort((a, b) => b.count - a.count);
  const repeatedCommands = zip(strArrayKeepEmpty(raw.cmd_repeat_name), numArray(raw.cmd_repeat_n)).map(([name, count]) => ({ name, count })).filter((c) => c.name && c.count > 0).sort((a, b) => b.count - a.count);
  return {
    sessionFile: str(raw.session_file),
    callCounter: num(raw.call_counter),
    tokensBash: num(raw.tokens_bash),
    tokensRead: num(raw.tokens_read),
    tokensGrep: num(raw.tokens_grep),
    tokensOther: num(raw.tokens_other),
    rereads: num(raw.reread_count),
    exactDedupHits: num(raw.exact_dedup_hits),
    fuzzyDedupHits: num(raw.fuzzy_dedup_hits),
    summarizeTriggers: num(raw.summarize_triggers),
    ultraCalls: num(raw.intensity_ultra_calls),
    agentSpawns: num(raw.agent_spawns),
    agentEstimatedTokens: num(raw.agent_estimated_tokens),
    agentMeasuredTokens: num(raw.agent_measured_tokens),
    agentMeasuredCount: num(raw.agent_measured_count),
    ctxTokens: num(raw.real_ctx_tokens),
    ctxWindow: num(raw.real_ctx_window),
    cacheReadTokens: num(raw.real_cache_read_tokens),
    callsThisMinute: num(raw.calls_this_minute),
    lastActivity: num(raw.last_activity_ts) * 1000,
    recentCalls,
    seenFiles: Array.isArray(raw.seen_files_path) ? raw.seen_files_path.length : 0,
    repeatedErrors,
    fileEdits,
    repeatedCommands,
    nudges: strArray(raw.nudged_keys, 20)
  };
}
function strArrayKeepEmpty(value) {
  return Array.isArray(value) ? value.map(str) : [];
}
function toHandlerRows(raw) {
  if (!isRecord(raw))
    return [];
  const names = strArrayKeepEmpty(raw.names);
  const calls = numArray(raw.calls);
  const inTk = numArray(raw.in_tokens);
  const outTk = numArray(raw.out_tokens);
  const n = Math.min(names.length, calls.length, inTk.length, outTk.length);
  const rows = [];
  for (let i = 0;i < n; i++) {
    rows.push({ name: names[i] ?? "", calls: calls[i] ?? 0, inTokens: inTk[i] ?? 0, outTokens: outTk[i] ?? 0 });
  }
  return rows;
}
function parseIni(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0)
      continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}
function resolveSqueezHome() {
  const override = process.env.SQUEEZ_STATS_HOME;
  if (override && override.trim())
    return path.resolve(override.trim());
  return path.join(os.homedir(), ".claude", "squeez");
}
var LOG_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/;

class SqueezStore {
  home;
  sessionsDir;
  logs = new Map;
  mergedEvents = [];
  mergedKey = "";
  summaries = null;
  blobs = null;
  constructor(home) {
    this.home = home;
    this.sessionsDir = path.join(home, "sessions");
  }
  async exists() {
    try {
      return (await fs.stat(this.sessionsDir)).isDirectory();
    } catch {
      return false;
    }
  }
  async stat(file) {
    try {
      const st = await fs.stat(file);
      return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
    } catch {
      return null;
    }
  }
  async readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }
  async events() {
    let names;
    try {
      names = (await fs.readdir(this.sessionsDir)).filter((n) => LOG_NAME.test(n)).sort();
    } catch {
      names = [];
    }
    const keyParts = [];
    const live = new Set(names);
    for (const name of names) {
      const file = path.join(this.sessionsDir, name);
      const stamp = await this.stat(file);
      if (!stamp)
        continue;
      const cached = this.logs.get(name);
      if (!cached || cached.mtimeMs !== stamp.mtimeMs || cached.size !== stamp.size) {
        let text = "";
        try {
          text = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        this.logs.set(name, { ...stamp, ...parseLog(text) });
      }
      keyParts.push(`${name}:${stamp.mtimeMs}:${stamp.size}`);
    }
    for (const name of [...this.logs.keys()])
      if (!live.has(name))
        this.logs.delete(name);
    const key = keyParts.join("|");
    if (key !== this.mergedKey) {
      const all = [];
      for (const log of this.logs.values())
        for (const e of log.events)
          all.push(e);
      all.sort((a, b) => a.ts - b.ts);
      this.mergedEvents = all;
      this.mergedKey = key;
    }
    return this.mergedEvents;
  }
  async logInfo() {
    const events = await this.events();
    let bytes = 0;
    let recovered = 0;
    let unreadable = 0;
    for (const log of this.logs.values()) {
      bytes += log.size;
      recovered += log.recovered;
      unreadable += log.unreadable;
    }
    return {
      files: this.logs.size,
      bytes,
      events: events.length,
      recoveredEvents: recovered,
      unreadableLines: unreadable,
      firstEvent: events[0]?.ts ?? null,
      lastEvent: events[events.length - 1]?.ts ?? null
    };
  }
  async summaryRecords() {
    const file = path.join(this.home, "memory", "summaries.jsonl");
    const stamp = await this.stat(file);
    if (!stamp) {
      this.summaries = null;
      return { records: [], info: { count: 0, bytes: 0, unreadableLines: 0, first: null, last: null } };
    }
    if (!this.summaries || this.summaries.stamp.mtimeMs !== stamp.mtimeMs || this.summaries.stamp.size !== stamp.size) {
      let text = "";
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        text = "";
      }
      const records2 = [];
      let unreadable2 = 0;
      for (const line of text.split(`
`)) {
        if (!line.trim())
          continue;
        try {
          const record = toSummary(JSON.parse(line));
          if (record)
            records2.push(record);
          else
            unreadable2++;
        } catch {
          unreadable2++;
        }
      }
      records2.sort((a, b) => a.start - b.start);
      this.summaries = { stamp, records: records2, unreadable: unreadable2 };
    }
    const { records, unreadable } = this.summaries;
    return {
      records,
      info: {
        count: records.length,
        bytes: stamp.size,
        unreadableLines: unreadable,
        first: records[0]?.start ?? null,
        last: records[records.length - 1]?.start ?? null
      }
    };
  }
  async current() {
    return toCurrent(await this.readJson(path.join(this.sessionsDir, "current.json")));
  }
  async context() {
    return toContext(await this.readJson(path.join(this.sessionsDir, "context.json")));
  }
  async handlerRows() {
    return toHandlerRows(await this.readJson(path.join(this.sessionsDir, "handler_stats.json")));
  }
  async config() {
    try {
      return parseIni(await fs.readFile(path.join(this.home, "config.ini"), "utf8"));
    } catch {
      return {};
    }
  }
  async blobInfo() {
    const dir = path.join(this.home, "blobs");
    let names;
    let dirStamp;
    try {
      dirStamp = (await fs.stat(dir)).mtimeMs;
      names = await fs.readdir(dir);
    } catch {
      return null;
    }
    const key = `${dirStamp}:${names.length}`;
    if (this.blobs?.key === key)
      return this.blobs.info;
    const blobs = [];
    let indexBytes = 0;
    for (const name of names) {
      try {
        const st = await fs.stat(path.join(dir, name));
        if (!st.isFile())
          continue;
        if (name.endsWith(".idx"))
          indexBytes += st.size;
        else
          blobs.push({ id: name, bytes: st.size, modified: st.mtimeMs, preview: "" });
      } catch {}
    }
    blobs.sort((a, b) => b.bytes - a.bytes);
    const largest = blobs.slice(0, 5);
    for (const blob of largest) {
      const idx = await this.readJson(path.join(dir, `${blob.id}.idx`));
      if (isRecord(idx))
        blob.preview = str(idx.preview).slice(0, 160);
    }
    let oldest = null;
    let newest = null;
    let bytes = 0;
    for (const b of blobs) {
      bytes += b.bytes;
      if (oldest === null || b.modified < oldest)
        oldest = b.modified;
      if (newest === null || b.modified > newest)
        newest = b.modified;
    }
    const info = { count: blobs.length, bytes, indexBytes, oldest, newest, largest };
    this.blobs = { key, info };
    return info;
  }
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("[squeez-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var store = new SqueezStore(resolveSqueezHome());
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function msParam(url, name, fallback) {
  const raw = (url.searchParams.get(name) ?? "").trim();
  if (!/^\d{1,15}$/.test(raw))
    return fallback;
  return Number(raw);
}
async function meta() {
  const available = await store.exists();
  const events = available ? await store.events() : [];
  return {
    home: store.home,
    available,
    generatedAt: Date.now(),
    firstEvent: events[0]?.ts ?? null,
    lastEvent: events[events.length - 1]?.ts ?? null
  };
}
async function starts() {
  const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()]);
  return sessionStarts(records, current);
}
var routes = {
  "/status": async (url) => {
    const now = Date.now();
    const report = buildWindowReport(await store.events(), [], msParam(url, "start", 0), msParam(url, "end", now + 1));
    return { meta: await meta(), shell: report.shell, tools: report.tools };
  },
  "/overview": async (url) => {
    const now = Date.now();
    const report = buildWindowReport(await store.events(), await starts(), msParam(url, "start", 0), msParam(url, "end", now + 1));
    return { meta: await meta(), report };
  },
  "/sessions": async (url) => {
    const now = Date.now();
    const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()]);
    const result = buildSessions(await store.events(), records, current, msParam(url, "start", 0), msParam(url, "end", now + 1), now);
    return { meta: await meta(), ...result };
  },
  "/session": async (url) => {
    const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()]);
    const detail = buildSessionDetail(await store.events(), records, current, msParam(url, "start", -1), Date.now());
    return { meta: await meta(), ...detail };
  },
  "/now": async () => {
    const [current, context, events] = await Promise.all([store.current(), store.context(), store.events()]);
    const report = current ? buildWindowReport(events, await starts(), current.start, Date.now() + 1) : null;
    return {
      meta: await meta(),
      current,
      context: trimContext(context),
      contextMatches: !!current && !!context && context.sessionFile === current.sessionFile,
      report
    };
  },
  "/storage": async () => {
    const [logs, summaries, blobs, handlers, config] = await Promise.all([
      store.logInfo(),
      store.summaryRecords(),
      store.blobInfo(),
      store.handlerRows(),
      store.config()
    ]);
    return {
      meta: await meta(),
      logs,
      summaries: summaries.info,
      blobs,
      handlers: handlerSummary(handlers, HANDLER_TABLE_MAX),
      config: Object.entries(config).map(([key, value]) => ({ key, value }))
    };
  }
};
var server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const route = req.method === "GET" ? routes[url.pathname] : undefined;
    if (!route) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 200, await route(url));
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[squeez-stats] listening on 127.0.0.1:${port} (home: ${store.home})`);
});
