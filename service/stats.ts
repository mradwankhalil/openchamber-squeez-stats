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
 * Persisted files are untrusted JSON: every field is validated and malformed
 * lines/files are skipped, never thrown.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

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

export interface StatsPayload {
    ok: true
    squeezHome: string
    generatedAt: number
    reason?: "storage-missing"
    live: LiveSession | null
    allTime: AllTime | null
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
    inTokens: number
    outTokens: number
    ts: number
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
    if (type === "bash") {
        return { inTokens: num(raw.in_tk), outTokens: num(raw.out_tk), ts: num(raw.ts) }
    }
    if (type === "tool") {
        const est = num(raw.tokens_est)
        return { inTokens: est, outTokens: est, ts: num(raw.ts) }
    }
    return null
}

function dayFromFileName(name: string): string | null {
    const match = /^(\d{4}-\d{2}-\d{2})-\d{2}\.jsonl$/.exec(name)
    return match ? match[1] : null
}

// ------------------------------------------------------------------ store

const MAX_SESSION_FILES = 400

export class StatsStore {
    readonly squeezHome: string

    constructor(squeezHome: string) {
        this.squeezHome = squeezHome
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

    async getStats(): Promise<StatsPayload> {
        const generatedAt = Date.now()

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

        // ---- all-time per-handler stats
        const handlers = await this.readHandlers()

        // ---- daily series + all-time event totals from the jsonl logs
        const jsonlFiles = sessionEntries
            .filter((entry) => dayFromFileName(entry) !== null)
            .sort()
            .slice(-MAX_SESSION_FILES)
        const dayMap = new Map<string, DayPoint>()
        let totalEvents = 0
        let eventsIn = 0
        let eventsOut = 0
        for (const file of jsonlFiles) {
            const day = dayFromFileName(file)
            if (!day) continue
            const events = await this.readSessionEvents(file)
            const point = dayMap.get(day) ?? {
                day,
                events: 0,
                inTokens: 0,
                outTokens: 0,
                savedTokens: 0,
            }
            for (const event of events) {
                point.events += 1
                point.inTokens += event.inTokens
                point.outTokens += event.outTokens
                totalEvents += 1
                eventsIn += event.inTokens
                eventsOut += event.outTokens
            }
            point.savedTokens = Math.max(0, point.inTokens - point.outTokens)
            dayMap.set(day, point)
        }
        const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day))

        // ---- all-time: prefer handler_stats totals, fall back to event sums
        let allTime: AllTime | null = null
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
                sessionFiles: jsonlFiles.length,
                events: totalEvents,
                handlers,
            }
        }

        const blobs = await this.readBlobs()

        return {
            ok: true,
            squeezHome: this.squeezHome,
            generatedAt,
            live,
            allTime,
            daily,
            blobs,
        }
    }
}
