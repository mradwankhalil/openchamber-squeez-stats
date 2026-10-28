/**
 * Squeez Stats — local service.
 *
 * Runs as the extension's local process (manifest `contributes.service`) on
 * 127.0.0.1, reachable only through the OpenChamber host proxy. It reads the
 * squeez state files and answers the panel's `serviceRequest` calls.
 *
 * Endpoints (bearer token required on every request, including `/health`).
 * `start` / `end` are ms epochs; the panel computes them in local time.
 *   GET /health                         → { ok: true }
 *   GET /status?start&end               → StatusPayload       (Work Status line)
 *   GET /overview?start&end             → OverviewPayload     (everything in a window)
 *   GET /sessions?start&end             → SessionsPayload     (sessions started in a window)
 *   GET /session?start                  → SessionDetailPayload (one session)
 *   GET /now                            → NowPayload          (the session squeez tracks now)
 *   GET /storage                        → StoragePayload      (files on disk, settings)
 *   GET /locations                      → LocationsPayload    (discovery and file checks)
 *
 * Every data route also takes:
 *   home, sessions, summaries, blobs, config   absolute paths chosen in the panel's
 *                                              settings; missing means "find it"
 *   limits                                     JSON object of list lengths (ListLimits)
 */

import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import {
    buildSessionDetail,
    buildSessions,
    buildWindowReport,
    handlerSummary,
    normalizeLimits,
    sessionStarts,
    trimContext,
} from "./report"
import type {
    ListLimits,
    LocationsPayload,
    Meta,
    NowPayload,
    OverviewPayload,
    SessionDetailPayload,
    SessionsPayload,
    StatusPayload,
    StoragePayload,
} from "./report"
import {
    HANDLER_TABLE_MAX,
    PATH_OVERRIDE_KEYS,
    SqueezStore,
    checkPaths,
    cleanOverrides,
    discoverHomes,
    pickHome,
    resolvePaths,
} from "./store"
import type { HomeCandidate, PathOverrides } from "./store"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || ""

if (!Number.isInteger(port) || port <= 0 || !token) {
    console.error("[squeez-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required")
    process.exit(1)
}

// ------------------------------------------------------------- locations

/** Discovery touches a handful of folders; cache it briefly. */
const DISCOVERY_TTL_MS = 30_000
let discovery: { at: number; candidates: HomeCandidate[] } | null = null

async function candidates(): Promise<HomeCandidate[]> {
    if (!discovery || Date.now() - discovery.at > DISCOVERY_TTL_MS) {
        discovery = { at: Date.now(), candidates: await discoverHomes() }
    }
    return discovery.candidates
}

/** One store per distinct set of locations, so each keeps its parse cache. */
const MAX_STORES = 6
const stores = new Map<string, SqueezStore>()

interface Context {
    store: SqueezStore
    pathSource: "settings" | "auto"
    limits: ListLimits
}

function overridesFrom(url: URL): PathOverrides {
    const raw: Record<string, string | null> = {}
    for (const key of PATH_OVERRIDE_KEYS) raw[key] = url.searchParams.get(key)
    return cleanOverrides(raw)
}

function limitsFrom(url: URL): ListLimits {
    const raw = url.searchParams.get("limits")
    if (!raw || raw.length > 2000) return normalizeLimits(null)
    try {
        return normalizeLimits(JSON.parse(raw))
    } catch {
        return normalizeLimits(null)
    }
}

async function contextFor(url: URL): Promise<Context> {
    const overrides = overridesFrom(url)
    const pathSource = overrides.home ? "settings" : "auto"
    const home = overrides.home ?? pickHome(await candidates())
    const paths = resolvePaths(home, overrides)
    const key = JSON.stringify(paths)
    let store = stores.get(key)
    if (!store) {
        store = new SqueezStore(paths)
        stores.set(key, store)
        while (stores.size > MAX_STORES) {
            const oldest = stores.keys().next().value
            if (oldest === undefined) break
            stores.delete(oldest)
        }
    } else {
        // most recently used last
        stores.delete(key)
        stores.set(key, store)
    }
    return { store, pathSource, limits: limitsFrom(url) }
}

// ------------------------------------------------------------- helpers

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
    })
    res.end(payload)
}

/** Non-negative integer ms from a query param, else the fallback. */
function msParam(url: URL, name: string, fallback: number): number {
    const raw = (url.searchParams.get(name) ?? "").trim()
    if (!/^\d{1,15}$/.test(raw)) return fallback
    return Number(raw)
}

async function meta(ctx: Context): Promise<Meta> {
    const { store } = ctx
    const available = await store.exists()
    const events = available ? await store.events() : []
    return {
        home: store.home,
        paths: store.paths,
        pathSource: ctx.pathSource,
        available,
        generatedAt: Date.now(),
        firstEvent: events[0]?.ts ?? null,
        lastEvent: events[events.length - 1]?.ts ?? null,
    }
}

async function starts(store: SqueezStore): Promise<number[]> {
    const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()])
    return sessionStarts(records, current)
}

// ------------------------------------------------------------- routes

const routes: Record<string, (url: URL, ctx: Context) => Promise<unknown>> = {
    "/status": async (url, ctx): Promise<StatusPayload> => {
        const now = Date.now()
        const report = buildWindowReport(await ctx.store.events(), [], msParam(url, "start", 0), msParam(url, "end", now + 1), ctx.limits)
        return { meta: await meta(ctx), shell: report.shell, tools: report.tools }
    },

    "/overview": async (url, ctx): Promise<OverviewPayload> => {
        const now = Date.now()
        const report = buildWindowReport(
            await ctx.store.events(),
            await starts(ctx.store),
            msParam(url, "start", 0),
            msParam(url, "end", now + 1),
            ctx.limits,
        )
        return { meta: await meta(ctx), report }
    },

    "/sessions": async (url, ctx): Promise<SessionsPayload> => {
        const now = Date.now()
        const { store } = ctx
        const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()])
        const result = buildSessions(
            await store.events(),
            records,
            current,
            msParam(url, "start", 0),
            msParam(url, "end", now + 1),
            now,
        )
        return { meta: await meta(ctx), ...result }
    },

    "/session": async (url, ctx): Promise<SessionDetailPayload> => {
        const { store } = ctx
        const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()])
        const detail = buildSessionDetail(await store.events(), records, current, msParam(url, "start", -1), Date.now(), ctx.limits)
        return { meta: await meta(ctx), ...detail }
    },

    "/now": async (_url, ctx): Promise<NowPayload> => {
        const { store } = ctx
        const [current, context, events] = await Promise.all([store.current(), store.context(), store.events()])
        const report = current ? buildWindowReport(events, await starts(store), current.start, Date.now() + 1, ctx.limits) : null
        return {
            meta: await meta(ctx),
            current,
            context: trimContext(context, ctx.limits),
            contextMatches: !!current && !!context && context.sessionFile === current.sessionFile,
            report,
        }
    },

    "/storage": async (_url, ctx): Promise<StoragePayload> => {
        const { store } = ctx
        const [logs, summaries, blobs, handlers, config] = await Promise.all([
            store.logInfo(),
            store.summaryRecords(),
            store.blobInfo(),
            store.handlerRows(),
            store.config(),
        ])
        return {
            meta: await meta(ctx),
            logs,
            summaries: summaries.info,
            blobs,
            handlers: handlerSummary(handlers, HANDLER_TABLE_MAX),
            config: Object.entries(config).map(([key, value]) => ({ key, value })),
        }
    },

    "/locations": async (url, ctx): Promise<LocationsPayload> => {
        if (url.searchParams.get("rescan") === "1") discovery = null
        return {
            paths: ctx.store.paths,
            pathSource: ctx.pathSource,
            checks: await checkPaths(ctx.store.paths),
            candidates: await candidates(),
        }
    },
}

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
        sendJson(res, 401, { error: "unauthorized" })
        return
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    try {
        if (req.method === "GET" && url.pathname === "/health") {
            sendJson(res, 200, { ok: true })
            return
        }
        const route = req.method === "GET" ? routes[url.pathname] : undefined
        if (!route) {
            sendJson(res, 404, { error: "not found" })
            return
        }
        sendJson(res, 200, await route(url, await contextFor(url)))
    } catch (error) {
        sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
        })
    }
})

server.listen(port, "127.0.0.1", () => {
    console.log(`[squeez-stats] listening on 127.0.0.1:${port}`)
})
