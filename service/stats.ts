/**
 * squeez stats aggregation.
 *
 * Reads the files squeez persists under its home (`~/.claude/squeez`):
 *  - `sessions/current.json`        — live session pointer + counters
 *  - `sessions/handler_stats.json`  — all-time per-command parallel arrays
 *  - `sessions/*.jsonl`             — per-event log (bash/tool events with
 *                                     in/out token estimates)
 *  - `blobs/`                       — stashed oversized outputs
 *
 * The aggregate section supports a scope: all time (handler_stats), a single
 * session log file, or a local day range (event-level filtering). Dollar
 * figures come from service/pricing.ts (models.dev rates weighted by the
 * user's real model mix).
 *
 * Persisted files are untrusted JSON: every field is validated and malformed
 * lines/files are skipped, never thrown.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { PricingEngine } from "./pricing"
import type { PricingResult } from "./pricing"

// ------------------------------------------------------------------ types

export interface HandlerStat {
    name: string
    calls: number
    inTokens: number
    outTokens: number
    savedTokens: number
}

export interface LiveSession {
    sessionFile: string
    startedAt: number
    totalTokens: number
    tokensSaved: number
    totalCalls: number
    overheadTokens: number
    events: number
    inTokens: number
    outTokens: number
}

export interface AllTime {
    totalCalls: number
    inTokens: number
    outTokens: number
    savedTokens: number
    sessionFiles: number
    events: number
    handlers: HandlerStat[]
}

/** Event-window aggregate for a scoped view (session file or day range). */
export interface ScopedTotals {
    sessionFiles: number
    events: number
    inTokens: number
    outTokens: number
    savedTokens: number
    handlers: HandlerStat[]
}

export interface SessionSummary {
    /** file stem, e.g. "2026-10-15-00" */
    stem: string
    /** ms epoch of the hour the file covers */
    startedAt: number
    events: number
    savedTokens: number
}

export interface DayPoint {
    /** YYYY-MM-DD (from the session file name) */
    day: string
    events: number
    inTokens: number
    outTokens: number
    savedTokens: number
}

export interface BlobStore {
    count: number
    bytes: number
}

/** Scope selector for the aggregate section. */
export interface Scope {
    /** single session log file stem, e.g. "2026-10-15-00" */
    session?: string
    /** YYYY-MM-DD, inclusive, local time */
    from?: string
    /** YYYY-MM-DD, inclusive, local time */
    to?: string
}

export interface ScopeEcho {
    kind: "all" | "session" | "range"
    label: string
}

export interface StatsPayload {
    ok: true
    squeezHome: string
    generatedAt: number
    reason?: "storage-missing"
    live: LiveSession | null
    /** handler_stats aggregate — present when no scope is selected */
    allTime: AllTime | null
    /** event-window aggregate — present when a scope is selected */
    scoped: ScopedTotals | null
    scope: ScopeEcho
    /** Pricing for the scoped (or all-time) savings; null when not computable. */
    pricing: PricingResult | null
    /** Every known session log, newest first — feeds the scope picker. */
    sessions: SessionSummary[]
    daily: DayPoint[]
    blobs: BlobStore | null
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

// --------------------------------------------------------------- home dir

export function resolveSqueezHome(): string {
    const override = process.env.SQUEEZ_STATS_HOME
    if (override && override.trim()) return override.trim()
    return path.join(os.homedir(), ".claude", "squeez")
}

// ------------------------------------------------------------- event parse

interface SqueezEvent {
    kind: "bash" | "tool"
    /** handler name: first command token for bash, tool name for tool */
    name: string
    inTokens: number
    outTokens: number
    /** ms epoch (squeez persists seconds; converted on parse) */
    ts: number
}

/** First command token, path stripped, capped — e.g. "git status ..." → "git". */
function bashCommandName(cmd: string): string {
    const first = cmd.trim().split(/\s+/)[0] ?? ""
    const base = first.split(/[\\/]/).pop() ?? first
    return base.length > 24 ? `${base.slice(0, 24)}…` : base || "bash"
}

function parseEvent(line: string): SqueezEvent | null {
    let raw: unknown
    try {
        raw = JSON.parse(line)
    } catch {
        return null
    }
    if (!isRecord(raw)) return null
    const type = str(raw.type)
    const ts = num(raw.ts) * 1000
    if (type === "bash") {
        return {
            kind: "bash",
            name: bashCommandName(str(raw.cmd)),
            inTokens: num(raw.in_tk),
            outTokens: num(raw.out_tk),
            ts,
        }
    }
    if (type === "tool") {
        const est = num(raw.tokens_est)
        return { kind: "tool", name: str(raw.tool) || "tool", inTokens: est, outTokens: est, ts }
    }
    return null
}

const FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/

function dayFromFileName(name: string): string | null {
    const match = FILE_NAME_RE.exec(name)
    return match ? match[1] : null
}

/** ms epoch of the local hour a session file covers; null if name invalid. */
function hourFromFileName(name: string): number | null {
    const match = FILE_NAME_RE.exec(name)
    if (!match) return null
    const [y, m, d] = match[1].split("-").map(Number)
    const ms = new Date(y, m - 1, d, Number(match[2])).getTime()
    return Number.isFinite(ms) ? ms : null
}

/** Start-of-day ms for a YYYY-MM-DD string in local time; null if invalid. */
function dayStartMs(day: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!match) return null
    const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
    return Number.isFinite(ms) ? ms : null
}

// ------------------------------------------------------------------ store

const MAX_SESSION_FILES = 400

interface SessionFileData {
    name: string
    stem: string
    day: string
    hourStart: number
    events: SqueezEvent[]
}

export class StatsStore {
    readonly squeezHome: string
    private readonly pricing: PricingEngine

    constructor(squeezHome: string, pricing?: PricingEngine) {
        this.squeezHome = squeezHome
        this.pricing = pricing ?? new PricingEngine()
    }

    private get sessionsDir(): string {
        return path.join(this.squeezHome, "sessions")
    }

    private async readJson(file: string): Promise<unknown | null> {
        try {
            return JSON.parse(await fs.readFile(file, "utf8"))
        } catch {
            return null
        }
    }

    private async readHandlers(): Promise<HandlerStat[]> {
        const raw = await this.readJson(path.join(this.sessionsDir, "handler_stats.json"))
        if (!isRecord(raw)) return []
        const names = Array.isArray(raw.names) ? raw.names : []
        const calls = Array.isArray(raw.calls) ? raw.calls : []
        const inTokens = Array.isArray(raw.in_tokens) ? raw.in_tokens : []
        const outTokens = Array.isArray(raw.out_tokens) ? raw.out_tokens : []
        const handlers: HandlerStat[] = []
        for (let i = 0; i < names.length; i++) {
            const name = names[i]
            if (typeof name !== "string" || !name) continue
            const inT = num(inTokens[i])
            const outT = num(outTokens[i])
            handlers.push({
                name,
                calls: num(calls[i]),
                inTokens: inT,
                outTokens: outT,
                savedTokens: Math.max(0, inT - outT),
            })
        }
        handlers.sort((a, b) => b.savedTokens - a.savedTokens)
        return handlers
    }

    private async readSessionEvents(file: string): Promise<SqueezEvent[]> {
        let text: string
        try {
            text = await fs.readFile(path.join(this.sessionsDir, file), "utf8")
        } catch {
            return []
        }
        const events: SqueezEvent[] = []
        for (const line of text.split("\n")) {
            if (!line.trim()) continue
            const event = parseEvent(line)
            if (event) events.push(event)
        }
        return events
    }

    private async readBlobs(): Promise<BlobStore | null> {
        const blobsDir = path.join(this.squeezHome, "blobs")
        let entries
        try {
            entries = await fs.readdir(blobsDir, { withFileTypes: true })
        } catch {
            return null
        }
        let count = 0
        let bytes = 0
        for (const entry of entries) {
            if (!entry.isFile()) continue
            try {
                const stat = await fs.stat(path.join(blobsDir, entry.name))
                bytes += stat.size
                count += 1
            } catch {
                // vanished — skip
            }
        }
        return { count, bytes }
    }

    /** Aggregate a set of events into scoped totals with per-handler stats. */
    private aggregateEvents(files: SessionFileData[], events: SqueezEvent[]): ScopedTotals {
        const handlerMap = new Map<string, HandlerStat>()
        let inTokens = 0
        let outTokens = 0
        let savedTokens = 0
        for (const event of events) {
            inTokens += event.inTokens
            outTokens += event.outTokens
            const saved = Math.max(0, event.inTokens - event.outTokens)
            savedTokens += saved
            const existing = handlerMap.get(event.name)
            if (existing) {
                existing.calls += 1
                existing.inTokens += event.inTokens
                existing.outTokens += event.outTokens
                existing.savedTokens += saved
            } else {
                handlerMap.set(event.name, {
                    name: event.name,
                    calls: 1,
                    inTokens: event.inTokens,
                    outTokens: event.outTokens,
                    savedTokens: saved,
                })
            }
        }
        const handlers = [...handlerMap.values()].sort((a, b) => b.savedTokens - a.savedTokens)
        return {
            sessionFiles: files.length,
            events: events.length,
            inTokens,
            outTokens,
            savedTokens,
            handlers,
        }
    }

    async getStats(scope: Scope = {}): Promise<StatsPayload> {
        const generatedAt = Date.now()
        const emptyScope: ScopeEcho = { kind: "all", label: "All time" }

        let sessionEntries: string[]
        try {
            sessionEntries = await fs.readdir(this.sessionsDir)
        } catch {
            return {
                ok: true,
                squeezHome: this.squeezHome,
                generatedAt,
                reason: "storage-missing",
                live: null,
                allTime: null,
                scoped: null,
                scope: emptyScope,
                pricing: null,
                sessions: [],
                daily: [],
                blobs: null,
            }
        }

        // ---- live session (via current.json pointer)
        let live: LiveSession | null = null
        const currentRaw = await this.readJson(path.join(this.sessionsDir, "current.json"))
        if (isRecord(currentRaw)) {
            const sessionFile = str(currentRaw.session_file)
            const events = sessionFile ? await this.readSessionEvents(sessionFile) : []
            let inTokens = 0
            let outTokens = 0
            for (const event of events) {
                inTokens += event.inTokens
                outTokens += event.outTokens
            }
            live = {
                sessionFile,
                startedAt: num(currentRaw.start_ts) * 1000,
                totalTokens: num(currentRaw.total_tokens),
                tokensSaved: num(currentRaw.tokens_saved),
                totalCalls: num(currentRaw.total_calls),
                overheadTokens: num(currentRaw.overhead_tokens),
                events: events.length,
                inTokens,
                outTokens,
            }
        }

        // ---- load every session log once
        const jsonlNames = sessionEntries
            .filter((entry) => dayFromFileName(entry) !== null)
            .sort()
            .slice(-MAX_SESSION_FILES)
        const files: SessionFileData[] = []
        for (const name of jsonlNames) {
            const day = dayFromFileName(name)
            const hourStart = hourFromFileName(name)
            if (!day || hourStart === null) continue
            files.push({
                name,
                stem: name.replace(/\.jsonl$/, ""),
                day,
                hourStart,
                events: await this.readSessionEvents(name),
            })
        }

        // ---- scope resolution
        let selectedFiles = files
        let scopedEvents: SqueezEvent[] | null = null
        let scopeEcho: ScopeEcho = emptyScope
        let windowStart = 0
        let windowEnd = generatedAt

        if (scope.session) {
            selectedFiles = files.filter((f) => f.stem === scope.session)
            const file = selectedFiles[0]
            scopeEcho = {
                kind: "session",
                label: file ? `Session log ${file.stem}` : `Session ${scope.session} (not found)`,
            }
            if (file) {
                windowStart = file.hourStart
                windowEnd = file.hourStart + 3_599_999
                scopedEvents = file.events
            } else {
                scopedEvents = []
            }
        } else if (scope.from || scope.to) {
            const fromMs = scope.from ? dayStartMs(scope.from) : null
            const toMs = scope.to ? dayStartMs(scope.to) : null
            const startMs = fromMs ?? 0
            const endMs = toMs !== null ? toMs + 86_399_999 : generatedAt
            selectedFiles = files.filter(
                (f) => f.hourStart + 3_600_000 > startMs && f.hourStart <= endMs,
            )
            scopedEvents = []
            for (const file of selectedFiles) {
                for (const event of file.events) {
                    if (event.ts >= startMs && event.ts <= endMs) scopedEvents.push(event)
                }
            }
            scopeEcho = {
                kind: "range",
                label:
                    scope.from && scope.to
                        ? `${scope.from} → ${scope.to}`
                        : scope.from
                          ? `Since ${scope.from}`
                          : `Until ${scope.to}`,
            }
            windowStart = startMs
            windowEnd = endMs
        } else {
            const starts = files.map((f) => f.hourStart)
            windowStart = starts.length > 0 ? Math.min(...starts) : 0
        }

        // ---- picker list (newest first), computed over all files
        const sessions: SessionSummary[] = files
            .map((f) => ({
                stem: f.stem,
                startedAt: f.hourStart,
                events: f.events.length,
                savedTokens: f.events.reduce(
                    (sum, e) => sum + Math.max(0, e.inTokens - e.outTokens),
                    0,
                ),
            }))
            .sort((a, b) => b.startedAt - a.startedAt)

        // ---- aggregates
        const handlers = await this.readHandlers()
        let allTime: AllTime | null = null
        let scoped: ScopedTotals | null = null

        if (scopedEvents !== null) {
            scoped = this.aggregateEvents(selectedFiles, scopedEvents)
        } else {
            // all time: prefer handler_stats totals, fall back to event sums
            let totalEvents = 0
            let eventsIn = 0
            let eventsOut = 0
            for (const file of files) {
                for (const event of file.events) {
                    totalEvents += 1
                    eventsIn += event.inTokens
                    eventsOut += event.outTokens
                }
            }
            const handlerCalls = handlers.reduce((sum, h) => sum + h.calls, 0)
            const handlerIn = handlers.reduce((sum, h) => sum + h.inTokens, 0)
            const handlerOut = handlers.reduce((sum, h) => sum + h.outTokens, 0)
            if (handlers.length > 0 || totalEvents > 0) {
                const inTokens = handlerIn > 0 ? handlerIn : eventsIn
                const outTokens = handlerOut > 0 ? handlerOut : eventsOut
                allTime = {
                    totalCalls: handlerCalls > 0 ? handlerCalls : totalEvents,
                    inTokens,
                    outTokens,
                    savedTokens: Math.max(0, inTokens - outTokens),
                    sessionFiles: files.length,
                    events: totalEvents,
                    handlers,
                }
            }
        }

        // ---- pricing for the aggregate in view
        const savedForPricing = scoped ? scoped.savedTokens : (allTime?.savedTokens ?? 0)
        const pricing = await this.pricing.price(windowStart, windowEnd, savedForPricing)

        // ---- daily series over the selected files
        const dayMap = new Map<string, DayPoint>()
        for (const file of selectedFiles) {
            const events =
                scope.from || scope.to
                    ? file.events.filter((e) => e.ts >= windowStart && e.ts <= windowEnd)
                    : file.events
            const point = dayMap.get(file.day) ?? {
                day: file.day,
                events: 0,
                inTokens: 0,
                outTokens: 0,
                savedTokens: 0,
            }
            for (const event of events) {
                point.events += 1
                point.inTokens += event.inTokens
                point.outTokens += event.outTokens
            }
            point.savedTokens = Math.max(0, point.inTokens - point.outTokens)
            dayMap.set(file.day, point)
        }
        const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day))

        const blobs = await this.readBlobs()

        return {
            ok: true,
            squeezHome: this.squeezHome,
            generatedAt,
            live,
            allTime,
            scoped,
            scope: scopeEcho,
            pricing,
            sessions,
            daily,
            blobs,
        }
    }
}
