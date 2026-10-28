/**
 * Aggregations over squeez state. Pure functions: events and records in,
 * view payloads out. The panel imports only the types from this file.
 *
 * What the numbers mean (see README "What the numbers mean"):
 *  - "before" / "after" are squeez's own token estimates of a wrapped shell
 *    command's output before and after compression (`in_tk` / `out_tk`).
 *  - "saved" sums max(0, before - after) per command, the same rule squeez
 *    uses for its session counter.
 *  - Tool events carry an output size only; squeez does not compress them.
 *  - A squeez session runs from one agent start to the next start anywhere on
 *    the machine, so events are attributed to sessions by time window.
 */

import type {
    BlobStoreInfo,
    ContextState,
    CurrentSession,
    HandlerRow,
    HomeCandidate,
    LocationCheck,
    LogStoreInfo,
    ShellEvent,
    SqueezEvent,
    SqueezPaths,
    SummaryRecord,
    SummaryStoreInfo,
    ToolEvent,
} from "./store"

// ------------------------------------------------------------------ types

export interface Meta {
    home: string
    /** every location read, after discovery and the user's overrides */
    paths: SqueezPaths
    /** "settings" when the user chose the squeez folder, else "auto" */
    pathSource: "settings" | "auto"
    available: boolean
    generatedAt: number
    firstEvent: number | null
    lastEvent: number | null
}

/** `/locations`: what discovery found and whether each file exists. */
export interface LocationsPayload {
    paths: SqueezPaths
    pathSource: "settings" | "auto"
    checks: LocationCheck[]
    candidates: HomeCandidate[]
}

export interface ShellTotals {
    commands: number
    inTokens: number
    outTokens: number
    savedTokens: number
    /** output got shorter */
    compressed: number
    /** output passed through unchanged */
    unchanged: number
    /** output got longer (squeez added a header or note) */
    grew: number
}

export interface ToolTotals {
    calls: number
    tokens: number
}

export interface CommandRow {
    name: string
    runs: number
    inTokens: number
    outTokens: number
    savedTokens: number
    compressedRuns: number
}

export interface ToolRow {
    name: string
    /** MCP server for `mcp__server__tool` names, else "" */
    server: string
    calls: number
    tokens: number
}

export interface CountRow {
    text: string
    count: number
    last: number
}

export interface OutputRow {
    cmd: string
    inTokens: number
    outTokens: number
    ts: number
}

export interface SeriesPoint {
    /** bucket start, ms epoch (local midnight or local hour) */
    start: number
    label: string
    commands: number
    savedTokens: number
    inTokens: number
    outTokens: number
    toolCalls: number
    toolTokens: number
}

export interface HourOfDay {
    hour: number
    commands: number
    toolCalls: number
}

export interface WindowReport {
    start: number
    end: number
    firstEvent: number | null
    lastEvent: number | null
    shell: ShellTotals
    tools: ToolTotals
    sessionsStarted: number
    granularity: "hour" | "day"
    series: SeriesPoint[]
    hourOfDay: HourOfDay[]
    topCommands: CommandRow[]
    weakCommands: CommandRow[]
    largestOutputs: OutputRow[]
    toolsByName: ToolRow[]
    errors: CountRow[]
    files: CountRow[]
    git: CountRow[]
    tests: { text: string; ts: number }[]
}

export interface OverviewPayload {
    meta: Meta
    report: WindowReport
}

export interface SessionRow {
    start: number
    end: number
    ongoing: boolean
    shellCommands: number
    inTokens: number
    outTokens: number
    savedTokens: number
    toolCalls: number
    toolTokens: number
    /** squeez's finished-session record, when one exists */
    summary: {
        filesTouched: number
        errors: number
        gitEvents: number
        scoreOverall: number
    } | null
}

export interface SessionsPayload {
    meta: Meta
    total: number
    active: number
    /** started and ended with no shell or tool activity */
    empty: number
    rows: SessionRow[]
    truncated: boolean
}

export interface SessionDetailPayload {
    meta: Meta
    row: SessionRow | null
    summary: SummaryRecord | null
    report: WindowReport | null
}

export interface NowPayload {
    meta: Meta
    current: CurrentSession | null
    context: ContextState | null
    /** context.json belongs to the same session as current.json */
    contextMatches: boolean
    report: WindowReport | null
}

export interface StoragePayload {
    meta: Meta
    logs: LogStoreInfo
    summaries: SummaryStoreInfo
    blobs: BlobStoreInfo | null
    handlers: {
        used: number
        max: number
        rows: HandlerRow[]
        calls: number
        inTokens: number
        outTokens: number
    }
    config: { key: string; value: string }[]
}

export interface StatusPayload {
    meta: Meta
    shell: ShellTotals
    tools: ToolTotals
}

// ----------------------------------------------------------- command names

/** Words that set up a command line rather than being the command. */
const PRELUDE = new Set([
    "cd", "pushd", "popd", "export", "set", "unset", "source", ".", "shopt", "trap", "true", ":", "local", "declare",
    "for", "while", "until", "if", "case", "do", "then", "else", "elif", "done", "fi", "esac", "[", "[[", "exit",
])
/** Wrappers whose first real argument is the command. */
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "exec", "nice", "stdbuf", "&"])
/** Keywords that open a loop or branch body: `do sed ...` runs sed. */
const BODY_KEYWORD = /^\s*(?:do|then|else|elif)\s+/
/** `VAR=$(cmd ...` or `VAR=`cmd ...`: the command is inside the substitution. */
const SUBSTITUTION = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*[A-Za-z_]\w*=(?:\$\(|`)\s*([\s\S]*)$/

/** Shell words, keeping quoted runs together (`S="a b"` is one word). */
function tokenize(segment: string): string[] {
    return segment.match(/(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g) ?? []
}

/** `"/usr/bin/Timeout.exe"` -> `timeout` */
function bare(word: string): string {
    const unquoted = word.replace(/^["']|["']$/g, "")
    const base = unquoted.split(/[\\/]/).pop() ?? unquoted
    return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase()
}

function programOf(segment: string): string {
    const body = segment.replace(BODY_KEYWORD, "")
    const sub = SUBSTITUTION.exec(body)
    if (sub) return programOf(sub[1] ?? "")
    const tokens = tokenize(body.trim().replace(/^[({]+\s*/, ""))
    let i = 0
    while (i < tokens.length) {
        const t = tokens[i] ?? ""
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
            i++
            continue
        }
        if (WRAPPERS.has(bare(t))) {
            i++
            while (i < tokens.length && /^(-\S*|\d+)$/.test(tokens[i] ?? "")) i++
            continue
        }
        if (bare(t) === "timeout") {
            i++
            while (i < tokens.length && /^(-\S+|\d+[smhd]?)$/.test(tokens[i] ?? "")) i++
            continue
        }
        break
    }
    const raw = tokens[i]
    return raw ? bare(raw) : ""
}

/**
 * The program a command line actually runs: `cd x && git log` -> `git`,
 * `FOO=1 timeout 30 node a.js` -> `node`, `"C:/Program Files/Git/bin/bash.exe" -lc` -> `bash`,
 * `for f in *; do sed -n 1p $f; done` -> `sed`. Later lines count too, so a
 * script that opens with assignments is named after its first real command.
 */
export function commandName(cmd: string): string {
    const segments = cmd.split(/\r?\n|&&|\|\||;|\|/)
    let fallback = ""
    for (const segment of segments) {
        const name = programOf(segment)
        if (!name) continue
        if (!fallback) fallback = name
        if (PRELUDE.has(name)) continue
        if (name === "echo" && segments.length > 1) continue
        return name
    }
    return fallback || "(empty)"
}

/** `mcp__openchamber__context-mode_ctx_execute` -> name `context-mode_ctx_execute`, server `openchamber`. */
export function toolLabel(tool: string): { name: string; server: string } {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool)
    if (m) return { name: m[2] ?? tool, server: m[1] ?? "" }
    return { name: tool, server: "" }
}

// ---------------------------------------------------------------- windows

/** First index with events[i].ts >= ts. */
export function lowerBound(events: SqueezEvent[], ts: number): number {
    let lo = 0
    let hi = events.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((events[mid]?.ts ?? 0) < ts) lo = mid + 1
        else hi = mid
    }
    return lo
}

/** Events with start <= ts < end. */
export function slice(events: SqueezEvent[], start: number, end: number): SqueezEvent[] {
    return events.slice(lowerBound(events, start), lowerBound(events, end))
}

function localDayStart(ms: number): number {
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}

function nextLocalDay(ms: number): number {
    const d = new Date(ms)
    d.setDate(d.getDate() + 1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}

function localHourStart(ms: number): number {
    const d = new Date(ms)
    d.setMinutes(0, 0, 0)
    return d.getTime()
}

function pad(n: number): string {
    return String(n).padStart(2, "0")
}

function dayLabel(ms: number): string {
    const d = new Date(ms)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function hourLabel(ms: number): string {
    return `${pad(new Date(ms).getHours())}:00`
}

/** How many rows each list returns. The panel's settings choose these. */
export interface ListLimits {
    topCommands: number
    weakCommands: number
    largestOutputs: number
    toolsByName: number
    errors: number
    files: number
    git: number
    tests: number
    recentCalls: number
    repeatedErrors: number
    fileEdits: number
    repeatedCommands: number
}

export const DEFAULT_LIMITS: ListLimits = {
    topCommands: 12,
    weakCommands: 8,
    largestOutputs: 6,
    toolsByName: 12,
    errors: 8,
    files: 10,
    git: 10,
    tests: 8,
    recentCalls: 12,
    repeatedErrors: 8,
    fileEdits: 10,
    repeatedCommands: 8,
}

export const LIMIT_MIN = 1
export const LIMIT_MAX = 50

/** Untrusted input to limits: known keys, whole numbers, clamped; the rest default. */
export function normalizeLimits(raw: unknown): ListLimits {
    const out: ListLimits = { ...DEFAULT_LIMITS }
    if (!raw || typeof raw !== "object") return out
    const src = raw as Record<string, unknown>
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ListLimits)[]) {
        const v = Number(src[key])
        if (Number.isFinite(v)) out[key] = Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.round(v)))
    }
    return out
}

const MAX_DAY_BUCKETS = 400
const HOUR_SPAN_LIMIT = 48 * 3_600_000

function emptyTotals(): ShellTotals {
    return { commands: 0, inTokens: 0, outTokens: 0, savedTokens: 0, compressed: 0, unchanged: 0, grew: 0 }
}

export function addShell(totals: ShellTotals, e: ShellEvent): void {
    totals.commands++
    totals.inTokens += e.inTk
    totals.outTokens += e.outTk
    if (e.inTk > e.outTk) {
        totals.savedTokens += e.inTk - e.outTk
        totals.compressed++
    } else if (e.inTk === e.outTk) totals.unchanged++
    else totals.grew++
}

function bump(map: Map<string, CountRow>, text: string, ts: number): void {
    const key = text.trim().replace(/\s+/g, " ").slice(0, 200)
    if (!key) return
    const row = map.get(key)
    if (row) {
        row.count++
        if (ts > row.last) row.last = ts
    } else map.set(key, { text: key, count: 1, last: ts })
}

/**
 * Everything the event logs say about [start, end).
 * `sessionStarts` are squeez session start times (ms), for the count.
 */
export function buildWindowReport(
    allEvents: SqueezEvent[],
    sessionStarts: number[],
    start: number,
    end: number,
    limits: ListLimits = DEFAULT_LIMITS,
): WindowReport {
    const events = slice(allEvents, start, end)
    const keepLargest = Math.max(10, limits.largestOutputs)
    const firstEvent = events[0]?.ts ?? null
    const lastEvent = events[events.length - 1]?.ts ?? null

    const shell = emptyTotals()
    const tools: ToolTotals = { calls: 0, tokens: 0 }
    const commands = new Map<string, CommandRow>()
    const toolMap = new Map<string, ToolRow>()
    const errors = new Map<string, CountRow>()
    const files = new Map<string, CountRow>()
    const git = new Map<string, CountRow>()
    const tests: { text: string; ts: number }[] = []
    const largest: OutputRow[] = []
    const hourOfDay: HourOfDay[] = Array.from({ length: 24 }, (_, hour) => ({ hour, commands: 0, toolCalls: 0 }))

    // series buckets: hours for windows up to two days, else local days
    const stop = Math.min(end, Date.now())
    const from = start > 0 ? start : (firstEvent ?? stop)
    const granularity: "hour" | "day" = stop - from <= HOUR_SPAN_LIMIT ? "hour" : "day"
    const series: SeriesPoint[] = []
    if (firstEvent !== null) {
        let cursor = granularity === "hour" ? localHourStart(from) : localDayStart(Math.max(from, firstEvent))
        while (cursor < stop && series.length < (granularity === "hour" ? 49 : MAX_DAY_BUCKETS)) {
            series.push({
                start: cursor,
                label: granularity === "hour" ? hourLabel(cursor) : dayLabel(cursor),
                commands: 0,
                savedTokens: 0,
                inTokens: 0,
                outTokens: 0,
                toolCalls: 0,
                toolTokens: 0,
            })
            cursor = granularity === "hour" ? cursor + 3_600_000 : nextLocalDay(cursor)
        }
    }
    let bucket = 0
    const pointFor = (ts: number): SeriesPoint | null => {
        while (bucket + 1 < series.length && (series[bucket + 1]?.start ?? Infinity) <= ts) bucket++
        const p = series[bucket]
        return p && p.start <= ts ? p : null
    }

    for (const e of events) {
        if (e.kind === "bash") {
            addShell(shell, e)
            const name = commandName(e.cmd)
            const row = commands.get(name) ?? { name, runs: 0, inTokens: 0, outTokens: 0, savedTokens: 0, compressedRuns: 0 }
            row.runs++
            row.inTokens += e.inTk
            row.outTokens += e.outTk
            if (e.inTk > e.outTk) {
                row.savedTokens += e.inTk - e.outTk
                row.compressedRuns++
            }
            commands.set(name, row)
            for (const err of e.errors) bump(errors, err, e.ts)
            for (const f of e.files) bump(files, f, e.ts)
            for (const g of e.git) bump(git, g, e.ts)
            if (e.test.trim()) tests.push({ text: e.test.trim().slice(0, 200), ts: e.ts })
            if (e.inTk > 0) {
                largest.push({ cmd: e.cmd.slice(0, 240), inTokens: e.inTk, outTokens: e.outTk, ts: e.ts })
                if (largest.length > keepLargest * 4) {
                    largest.sort((a, b) => b.inTokens - a.inTokens)
                    largest.length = keepLargest
                }
            }
            hourOfDay[new Date(e.ts).getHours()]!.commands++
            const p = pointFor(e.ts)
            if (p) {
                p.commands++
                p.inTokens += e.inTk
                p.outTokens += e.outTk
                if (e.inTk > e.outTk) p.savedTokens += e.inTk - e.outTk
            }
        } else if (e.kind === "tool") {
            tools.calls++
            tools.tokens += e.tokens
            addTool(toolMap, e)
            hourOfDay[new Date(e.ts).getHours()]!.toolCalls++
            const p = pointFor(e.ts)
            if (p) {
                p.toolCalls++
                p.toolTokens += e.tokens
            }
        }
    }

    const rows = [...commands.values()]
    largest.sort((a, b) => b.inTokens - a.inTokens)

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
        topCommands: rows
            .filter((r) => r.savedTokens > 0)
            .sort((a, b) => b.savedTokens - a.savedTokens)
            .slice(0, limits.topCommands),
        weakCommands: rows
            .filter((r) => r.outTokens > 0 && r.savedTokens < r.inTokens * 0.1)
            .sort((a, b) => b.outTokens - a.outTokens)
            .slice(0, limits.weakCommands),
        largestOutputs: largest.slice(0, limits.largestOutputs),
        toolsByName: [...toolMap.values()].sort((a, b) => b.tokens - a.tokens).slice(0, limits.toolsByName),
        errors: topCounts(errors, limits.errors),
        files: topCounts(files, limits.files),
        git: [...git.values()].sort((a, b) => b.last - a.last).slice(0, limits.git),
        tests: tests.slice(-limits.tests).reverse(),
    }
}

function addTool(map: Map<string, ToolRow>, e: ToolEvent): void {
    const row = map.get(e.tool)
    if (row) {
        row.calls++
        row.tokens += e.tokens
    } else {
        const { name, server } = toolLabel(e.tool)
        map.set(e.tool, { name, server, calls: 1, tokens: e.tokens })
    }
}

function topCounts(map: Map<string, CountRow>, n: number): CountRow[] {
    return [...map.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, n)
}

// --------------------------------------------------------------- sessions

/** Sorted, de-duplicated session start times: finished sessions + the current one. */
export function sessionStarts(summaries: SummaryRecord[], current: CurrentSession | null): number[] {
    const set = new Set<number>()
    for (const s of summaries) set.add(s.start)
    if (current) set.add(current.start)
    return [...set].sort((a, b) => a - b)
}

const MAX_SESSION_ROWS = 300

/**
 * Sessions that started inside [start, end), newest first. Each session owns
 * the events from its start to the next start.
 */
export function buildSessions(
    allEvents: SqueezEvent[],
    summaries: SummaryRecord[],
    current: CurrentSession | null,
    start: number,
    end: number,
    now: number,
): { total: number; active: number; empty: number; rows: SessionRow[]; truncated: boolean } {
    const starts = sessionStarts(summaries, current)
    const byStart = new Map<number, SummaryRecord>()
    for (const s of summaries) byStart.set(s.start, s)

    const rows: SessionRow[] = []
    let active = 0
    let empty = 0
    for (let i = 0; i < starts.length; i++) {
        const s = starts[i] ?? 0
        if (s < start || s >= end) continue
        const row = sessionRow(allEvents, starts, i, byStart, current, now)
        if (row.shellCommands + row.toolCalls > 0) active++
        else empty++
        rows.push(row)
    }
    rows.reverse()
    const total = rows.length
    return { total, active, empty, rows: rows.slice(0, MAX_SESSION_ROWS), truncated: total > MAX_SESSION_ROWS }
}

function sessionRow(
    allEvents: SqueezEvent[],
    starts: number[],
    i: number,
    byStart: Map<number, SummaryRecord>,
    current: CurrentSession | null,
    now: number,
): SessionRow {
    const s = starts[i] ?? 0
    const next = starts[i + 1]
    const ongoing = next === undefined && current !== null && current.start === s
    const end = next ?? (ongoing ? now : s + (byStart.get(s)?.durationMin ?? 0) * 60_000)
    const totals = emptyTotals()
    let toolCalls = 0
    let toolTokens = 0
    for (const e of slice(allEvents, s, Math.max(end, s + 1))) {
        if (e.kind === "bash") addShell(totals, e)
        else if (e.kind === "tool") {
            toolCalls++
            toolTokens += e.tokens
        }
    }
    const summary = byStart.get(s)
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
        summary: summary
            ? {
                  filesTouched: summary.filesTouchedCount,
                  errors: summary.errors.length,
                  gitEvents: summary.gitEvents.length,
                  scoreOverall: summary.score.overall,
              }
            : null,
    }
}

/** One session by its start time. */
export function buildSessionDetail(
    allEvents: SqueezEvent[],
    summaries: SummaryRecord[],
    current: CurrentSession | null,
    sessionStart: number,
    now: number,
    limits: ListLimits = DEFAULT_LIMITS,
): { row: SessionRow | null; summary: SummaryRecord | null; report: WindowReport | null } {
    const starts = sessionStarts(summaries, current)
    const i = starts.indexOf(sessionStart)
    if (i < 0) return { row: null, summary: null, report: null }
    const byStart = new Map<number, SummaryRecord>()
    for (const s of summaries) byStart.set(s.start, s)
    const row = sessionRow(allEvents, starts, i, byStart, current, now)
    return {
        row,
        summary: byStart.get(sessionStart) ?? null,
        report: buildWindowReport(allEvents, starts, row.start, Math.max(row.end, row.start + 1), limits),
    }
}

// ---------------------------------------------------------------- storage

export function handlerSummary(rows: HandlerRow[], max: number): StoragePayload["handlers"] {
    let calls = 0
    let inTokens = 0
    let outTokens = 0
    for (const r of rows) {
        calls += r.calls
        inTokens += r.inTokens
        outTokens += r.outTokens
    }
    return {
        used: rows.length,
        max,
        rows: [...rows].sort((a, b) => b.inTokens - b.outTokens - (a.inTokens - a.outTokens)).slice(0, 12),
        calls,
        inTokens,
        outTokens,
    }
}

/** Trim the context lists to what the panel shows. */
export function trimContext(ctx: ContextState | null, limits: ListLimits = DEFAULT_LIMITS): ContextState | null {
    if (!ctx) return null
    return {
        ...ctx,
        recentCalls: ctx.recentCalls.slice(0, limits.recentCalls),
        repeatedErrors: ctx.repeatedErrors.slice(0, limits.repeatedErrors),
        fileEdits: ctx.fileEdits.slice(0, limits.fileEdits),
        repeatedCommands: ctx.repeatedCommands.slice(0, limits.repeatedCommands),
    }
}
