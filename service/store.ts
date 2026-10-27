/**
 * squeez on-disk state: readers and a change-aware cache.
 *
 * Everything squeez persists under its home (default `~/.claude/squeez`):
 *
 *  - `sessions/YYYY-MM-DD-HH.jsonl` event logs. One file per session-start
 *    hour (UTC), so sessions started in the same hour share a file. Events:
 *      bash          {cmd, in_tk, out_tk, files, errors, git, test_summary, ts}
 *                    one wrapped shell command, output size before/after
 *      tool          {tool, tokens_est, ts}  every tool result (shell included), size
 *                                            only: tokens_est is bytes / 4
 *      git_snapshot  {log, status, ts}       written at session start
 *    Concurrent writers sometimes put two events on one line (`}{`); those
 *    lines are split and recovered.
 *  - `sessions/current.json`  the session squeez is tracking right now. There
 *    is one for the whole machine: the agent that started most recently.
 *  - `sessions/context.json`  that session's working context. Counters reset
 *    at each session start; seen files, errors and the call log carry over.
 *  - `sessions/handler_stats.json`  cumulative per-first-word table, capped at
 *    64 names (squeez `MAX_HANDLERS`); once full, new names are dropped.
 *  - `memory/summaries.jsonl`  one record per finished session.
 *  - `blobs/<id>` + `<id>.idx`  stashed oversized outputs.
 *  - `config.ini`  settings.
 *
 * All files are untrusted JSON/INI: fields are validated, malformed lines are
 * counted, nothing throws.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

/** squeez `MAX_HANDLERS` (src/economy/handler_stats.rs). */
export const HANDLER_TABLE_MAX = 64

// ------------------------------------------------------------------ types

export interface ShellEvent {
    kind: "bash"
    /** ms epoch */
    ts: number
    cmd: string
    inTk: number
    outTk: number
    files: string[]
    errors: string[]
    git: string[]
    test: string
}

export interface ToolEvent {
    kind: "tool"
    ts: number
    tool: string
    tokens: number
}

export interface GitSnapshotEvent {
    kind: "git"
    ts: number
}

export type SqueezEvent = ShellEvent | ToolEvent | GitSnapshotEvent

export interface SummaryRecord {
    /** session start, ms epoch */
    start: number
    durationMin: number
    filesTouched: string[]
    filesTouchedCount: number
    filesCommittedCount: number
    errors: string[]
    gitEvents: string[]
    testSummary: string
    completed: string[]
    nextSteps: string[]
    /** squeez's own scores, basis points 0..10000 */
    score: {
        overall: number
        compression: number
        toolChoice: number
        reuse: number
        budget: number
    }
}

export interface CurrentSession {
    sessionFile: string
    /** ms epoch */
    start: number
    /** tokens of every tool result the agent received (shell after compression; others at bytes/4) */
    receivedTokens: number
    /** shell output tokens removed (sum of positive before-after) */
    savedTokens: number
    /** tool calls squeez tracked (every PostToolUse) */
    trackedCalls: number
    /** tokens squeez itself injected (banners, tags) */
    overheadTokens: number
}

export interface ContextState {
    sessionFile: string
    callCounter: number
    /** per-session counters (reset at session start) */
    tokensBash: number
    tokensRead: number
    tokensGrep: number
    tokensOther: number
    rereads: number
    exactDedupHits: number
    fuzzyDedupHits: number
    summarizeTriggers: number
    ultraCalls: number
    agentSpawns: number
    agentEstimatedTokens: number
    agentMeasuredTokens: number
    agentMeasuredCount: number
    /** last context-window reading taken from the harness transcript */
    ctxTokens: number
    ctxWindow: number
    cacheReadTokens: number
    callsThisMinute: number
    /** ms epoch, 0 when unknown */
    lastActivity: number
    /** carried across sessions */
    recentCalls: { n: number; label: string; bytes: number }[]
    seenFiles: number
    repeatedErrors: { text: string; count: number }[]
    fileEdits: { path: string; count: number }[]
    repeatedCommands: { name: string; count: number }[]
    nudges: string[]
}

export interface HandlerRow {
    name: string
    calls: number
    inTokens: number
    outTokens: number
}

export interface BlobInfo {
    id: string
    bytes: number
    /** ms epoch */
    modified: number
    preview: string
}

export interface BlobStoreInfo {
    count: number
    bytes: number
    indexBytes: number
    oldest: number | null
    newest: number | null
    largest: BlobInfo[]
}

export interface LogStoreInfo {
    files: number
    bytes: number
    events: number
    /** events recovered from lines holding two or more events */
    recoveredEvents: number
    unreadableLines: number
    firstEvent: number | null
    lastEvent: number | null
}

export interface SummaryStoreInfo {
    count: number
    bytes: number
    unreadableLines: number
    first: number | null
    last: number | null
}

// ------------------------------------------------------------- value guards

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
    return typeof value === "string" ? value : ""
}

function strArray(value: unknown, cap = Infinity): string[] {
    if (!Array.isArray(value)) return []
    const out: string[] = []
    for (const item of value) {
        if (typeof item === "string" && item.trim()) out.push(item)
        if (out.length >= cap) break
    }
    return out
}

function numArray(value: unknown): number[] {
    return Array.isArray(value) ? value.map(num) : []
}

// ---------------------------------------------------------------- parsing

/** Split a line holding several concatenated JSON objects (`{..}{..}`). */
export function splitObjects(line: string): string[] {
    const out: string[] = []
    let depth = 0
    let start = -1
    let inString = false
    let escaped = false
    for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (inString) {
            if (escaped) escaped = false
            else if (c === "\\") escaped = true
            else if (c === '"') inString = false
            continue
        }
        if (c === '"') inString = true
        else if (c === "{") {
            if (depth === 0) start = i
            depth++
        } else if (c === "}" && depth > 0) {
            depth--
            if (depth === 0 && start >= 0) {
                out.push(line.slice(start, i + 1))
                start = -1
            }
        }
    }
    return out
}

export function toEvent(raw: unknown): SqueezEvent | null {
    if (!isRecord(raw)) return null
    const ts = num(raw.ts) * 1000
    if (ts <= 0) return null
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
                test: str(raw.test_summary),
            }
        case "tool":
            return { kind: "tool", ts, tool: str(raw.tool) || "unknown", tokens: Math.max(0, num(raw.tokens_est)) }
        case "git_snapshot":
            return { kind: "git", ts }
        default:
            return null
    }
}

export interface ParsedLog {
    events: SqueezEvent[]
    recovered: number
    unreadable: number
}

/** Parse one event log; tolerant of merged and broken lines. */
export function parseLog(text: string): ParsedLog {
    const events: SqueezEvent[] = []
    let recovered = 0
    let unreadable = 0
    for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
            parsed = JSON.parse(trimmed)
        } catch {
            const parts = splitObjects(trimmed)
            let any = false
            for (const part of parts) {
                try {
                    const event = toEvent(JSON.parse(part))
                    if (event) {
                        events.push(event)
                        recovered++
                        any = true
                    }
                } catch {
                    // part of a broken line; counted below if nothing recovered
                }
            }
            if (!any) unreadable++
            continue
        }
        const event = toEvent(parsed)
        if (event) events.push(event)
    }
    return { events, recovered, unreadable }
}

function bp(value: unknown): number {
    return Math.min(10000, Math.max(0, num(value)))
}

export function toSummary(raw: unknown): SummaryRecord | null {
    if (!isRecord(raw)) return null
    const startSec = num(raw.valid_from) || num(raw.ts)
    if (startSec <= 0) return null
    const filesTouched = Array.isArray(raw.files_touched) ? raw.files_touched : []
    const filesCommitted = Array.isArray(raw.files_committed) ? raw.files_committed : []
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
            budget: bp(raw.budget_utilization_bp),
        },
    }
}

export function toCurrent(raw: unknown): CurrentSession | null {
    if (!isRecord(raw)) return null
    const start = num(raw.start_ts) * 1000
    if (start <= 0) return null
    return {
        sessionFile: str(raw.session_file),
        start,
        receivedTokens: num(raw.total_tokens),
        savedTokens: num(raw.tokens_saved),
        trackedCalls: num(raw.total_calls),
        overheadTokens: num(raw.overhead_tokens),
    }
}

/** Pair two parallel arrays into rows, keeping the shorter length. */
function zip<A, B>(a: A[], b: B[]): [A, B][] {
    const n = Math.min(a.length, b.length)
    const out: [A, B][] = []
    for (let i = 0; i < n; i++) out.push([a[i] as A, b[i] as B])
    return out
}

export function toContext(raw: unknown): ContextState | null {
    if (!isRecord(raw)) return null

    const callN = numArray(raw.call_log_n)
    const callCmd = strArrayKeepEmpty(raw.call_log_cmd)
    const callLen = numArray(raw.call_log_len)
    const recentCalls = zip(zip(callN, callCmd), callLen)
        .map(([[n, label], bytes]) => ({ n, label, bytes }))
        .reverse()

    // error_count_* keys errors by fingerprint; error_snippet_* maps fingerprint -> text.
    // Fingerprints are u64 and lose precision as JS numbers, but both arrays
    // lose it identically, so equality still pairs them.
    const snippetText = new Map<number, string>()
    for (const [fp, text] of zip(numArray(raw.error_snippet_fp), strArrayKeepEmpty(raw.error_snippet_text))) {
        if (text) snippetText.set(fp, text)
    }
    const repeatedErrors = zip(numArray(raw.error_count_fp), numArray(raw.error_count_n))
        .map(([fp, count]) => ({ text: snippetText.get(fp) ?? "", count }))
        .filter((e) => e.text && e.count > 0)
        .sort((a, b) => b.count - a.count)

    const fileEdits = zip(strArrayKeepEmpty(raw.file_mod_path), numArray(raw.file_mod_n))
        .map(([p, count]) => ({ path: p, count }))
        .filter((f) => f.path && f.count > 0)
        .sort((a, b) => b.count - a.count)

    const repeatedCommands = zip(strArrayKeepEmpty(raw.cmd_repeat_name), numArray(raw.cmd_repeat_n))
        .map(([name, count]) => ({ name, count }))
        .filter((c) => c.name && c.count > 0)
        .sort((a, b) => b.count - a.count)

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
        nudges: strArray(raw.nudged_keys, 20),
    }
}

function strArrayKeepEmpty(value: unknown): string[] {
    return Array.isArray(value) ? value.map(str) : []
}

export function toHandlerRows(raw: unknown): HandlerRow[] {
    if (!isRecord(raw)) return []
    const names = strArrayKeepEmpty(raw.names)
    const calls = numArray(raw.calls)
    const inTk = numArray(raw.in_tokens)
    const outTk = numArray(raw.out_tokens)
    const n = Math.min(names.length, calls.length, inTk.length, outTk.length)
    const rows: HandlerRow[] = []
    for (let i = 0; i < n; i++) {
        rows.push({ name: names[i] ?? "", calls: calls[i] ?? 0, inTokens: inTk[i] ?? 0, outTokens: outTk[i] ?? 0 })
    }
    return rows
}

/** `key = value` lines; `#` comments ignored. */
export function parseIni(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue
        const eq = trimmed.indexOf("=")
        if (eq <= 0) continue
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    return out
}

// -------------------------------------------------------------- home dir

export function resolveSqueezHome(): string {
    const override = process.env.SQUEEZ_STATS_HOME
    if (override && override.trim()) return path.resolve(override.trim())
    return path.join(os.homedir(), ".claude", "squeez")
}

const LOG_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/

// ------------------------------------------------------------------ store

interface Stamp {
    mtimeMs: number
    size: number
}

interface CachedLog extends Stamp, ParsedLog {}

/**
 * Reads squeez state with per-file caching keyed on (mtime, size), so a poll
 * re-parses only the log being appended to.
 */
export class SqueezStore {
    readonly home: string
    private readonly sessionsDir: string
    private logs = new Map<string, CachedLog>()
    private mergedEvents: SqueezEvent[] = []
    private mergedKey = ""
    private summaries: { stamp: Stamp; records: SummaryRecord[]; unreadable: number } | null = null
    private blobs: { key: string; info: BlobStoreInfo } | null = null

    constructor(home: string) {
        this.home = home
        this.sessionsDir = path.join(home, "sessions")
    }

    async exists(): Promise<boolean> {
        try {
            return (await fs.stat(this.sessionsDir)).isDirectory()
        } catch {
            return false
        }
    }

    private async stat(file: string): Promise<Stamp | null> {
        try {
            const st = await fs.stat(file)
            return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null
        } catch {
            return null
        }
    }

    private async readJson(file: string): Promise<unknown> {
        try {
            return JSON.parse(await fs.readFile(file, "utf8"))
        } catch {
            return null
        }
    }

    /** All events from every log, sorted by time. */
    async events(): Promise<SqueezEvent[]> {
        let names: string[]
        try {
            names = (await fs.readdir(this.sessionsDir)).filter((n) => LOG_NAME.test(n)).sort()
        } catch {
            names = []
        }
        const keyParts: string[] = []
        const live = new Set(names)
        for (const name of names) {
            const file = path.join(this.sessionsDir, name)
            const stamp = await this.stat(file)
            if (!stamp) continue
            const cached = this.logs.get(name)
            if (!cached || cached.mtimeMs !== stamp.mtimeMs || cached.size !== stamp.size) {
                let text = ""
                try {
                    text = await fs.readFile(file, "utf8")
                } catch {
                    continue
                }
                this.logs.set(name, { ...stamp, ...parseLog(text) })
            }
            keyParts.push(`${name}:${stamp.mtimeMs}:${stamp.size}`)
        }
        for (const name of [...this.logs.keys()]) if (!live.has(name)) this.logs.delete(name)

        const key = keyParts.join("|")
        if (key !== this.mergedKey) {
            const all: SqueezEvent[] = []
            for (const log of this.logs.values()) for (const e of log.events) all.push(e)
            all.sort((a, b) => a.ts - b.ts)
            this.mergedEvents = all
            this.mergedKey = key
        }
        return this.mergedEvents
    }

    async logInfo(): Promise<LogStoreInfo> {
        const events = await this.events()
        let bytes = 0
        let recovered = 0
        let unreadable = 0
        for (const log of this.logs.values()) {
            bytes += log.size
            recovered += log.recovered
            unreadable += log.unreadable
        }
        return {
            files: this.logs.size,
            bytes,
            events: events.length,
            recoveredEvents: recovered,
            unreadableLines: unreadable,
            firstEvent: events[0]?.ts ?? null,
            lastEvent: events[events.length - 1]?.ts ?? null,
        }
    }

    /** Finished-session records, sorted by start. */
    async summaryRecords(): Promise<{ records: SummaryRecord[]; info: SummaryStoreInfo }> {
        const file = path.join(this.home, "memory", "summaries.jsonl")
        const stamp = await this.stat(file)
        if (!stamp) {
            this.summaries = null
            return { records: [], info: { count: 0, bytes: 0, unreadableLines: 0, first: null, last: null } }
        }
        if (!this.summaries || this.summaries.stamp.mtimeMs !== stamp.mtimeMs || this.summaries.stamp.size !== stamp.size) {
            let text = ""
            try {
                text = await fs.readFile(file, "utf8")
            } catch {
                text = ""
            }
            const records: SummaryRecord[] = []
            let unreadable = 0
            for (const line of text.split("\n")) {
                if (!line.trim()) continue
                try {
                    const record = toSummary(JSON.parse(line))
                    if (record) records.push(record)
                    else unreadable++
                } catch {
                    unreadable++
                }
            }
            records.sort((a, b) => a.start - b.start)
            this.summaries = { stamp, records, unreadable }
        }
        const { records, unreadable } = this.summaries
        return {
            records,
            info: {
                count: records.length,
                bytes: stamp.size,
                unreadableLines: unreadable,
                first: records[0]?.start ?? null,
                last: records[records.length - 1]?.start ?? null,
            },
        }
    }

    async current(): Promise<CurrentSession | null> {
        return toCurrent(await this.readJson(path.join(this.sessionsDir, "current.json")))
    }

    async context(): Promise<ContextState | null> {
        return toContext(await this.readJson(path.join(this.sessionsDir, "context.json")))
    }

    async handlerRows(): Promise<HandlerRow[]> {
        return toHandlerRows(await this.readJson(path.join(this.sessionsDir, "handler_stats.json")))
    }

    async config(): Promise<Record<string, string>> {
        try {
            return parseIni(await fs.readFile(path.join(this.home, "config.ini"), "utf8"))
        } catch {
            return {}
        }
    }

    async blobInfo(): Promise<BlobStoreInfo | null> {
        const dir = path.join(this.home, "blobs")
        let names: string[]
        let dirStamp: number
        try {
            dirStamp = (await fs.stat(dir)).mtimeMs
            names = await fs.readdir(dir)
        } catch {
            return null
        }
        const key = `${dirStamp}:${names.length}`
        if (this.blobs?.key === key) return this.blobs.info

        const blobs: BlobInfo[] = []
        let indexBytes = 0
        for (const name of names) {
            try {
                const st = await fs.stat(path.join(dir, name))
                if (!st.isFile()) continue
                if (name.endsWith(".idx")) indexBytes += st.size
                else blobs.push({ id: name, bytes: st.size, modified: st.mtimeMs, preview: "" })
            } catch {
                // vanished between readdir and stat
            }
        }
        blobs.sort((a, b) => b.bytes - a.bytes)
        const largest = blobs.slice(0, 5)
        for (const blob of largest) {
            const idx = await this.readJson(path.join(dir, `${blob.id}.idx`))
            if (isRecord(idx)) blob.preview = str(idx.preview).slice(0, 160)
        }
        let oldest: number | null = null
        let newest: number | null = null
        let bytes = 0
        for (const b of blobs) {
            bytes += b.bytes
            if (oldest === null || b.modified < oldest) oldest = b.modified
            if (newest === null || b.modified > newest) newest = b.modified
        }
        const info: BlobStoreInfo = { count: blobs.length, bytes, indexBytes, oldest, newest, largest }
        this.blobs = { key, info }
        return info
    }
}
