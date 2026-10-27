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
 */

import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import {
    buildSessionDetail,
    buildSessions,
    buildWindowReport,
    handlerSummary,
    sessionStarts,
    trimContext,
} from "./report"
import type {
    Meta,
    NowPayload,
    OverviewPayload,
    SessionDetailPayload,
    SessionsPayload,
    StatusPayload,
    StoragePayload,
} from "./report"
import { HANDLER_TABLE_MAX, SqueezStore, resolveSqueezHome } from "./store"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || ""

if (!Number.isInteger(port) || port <= 0 || !token) {
    console.error("[squeez-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required")
    process.exit(1)
}

const store = new SqueezStore(resolveSqueezHome())

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

async function meta(): Promise<Meta> {
    const available = await store.exists()
    const events = available ? await store.events() : []
    return {
        home: store.home,
        available,
        generatedAt: Date.now(),
        firstEvent: events[0]?.ts ?? null,
        lastEvent: events[events.length - 1]?.ts ?? null,
    }
}

async function starts(): Promise<number[]> {
    const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()])
    return sessionStarts(records, current)
}

const routes: Record<string, (url: URL) => Promise<unknown>> = {
    "/status": async (url): Promise<StatusPayload> => {
        const now = Date.now()
        const report = buildWindowReport(await store.events(), [], msParam(url, "start", 0), msParam(url, "end", now + 1))
        return { meta: await meta(), shell: report.shell, tools: report.tools }
    },

    "/overview": async (url): Promise<OverviewPayload> => {
        const now = Date.now()
        const report = buildWindowReport(
            await store.events(),
            await starts(),
            msParam(url, "start", 0),
            msParam(url, "end", now + 1),
        )
        return { meta: await meta(), report }
    },

    "/sessions": async (url): Promise<SessionsPayload> => {
        const now = Date.now()
        const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()])
        const result = buildSessions(
            await store.events(),
            records,
            current,
            msParam(url, "start", 0),
            msParam(url, "end", now + 1),
            now,
        )
        return { meta: await meta(), ...result }
    },

    "/session": async (url): Promise<SessionDetailPayload> => {
        const [{ records }, current] = await Promise.all([store.summaryRecords(), store.current()])
        const detail = buildSessionDetail(await store.events(), records, current, msParam(url, "start", -1), Date.now())
        return { meta: await meta(), ...detail }
    },

    "/now": async (): Promise<NowPayload> => {
        const [current, context, events] = await Promise.all([store.current(), store.context(), store.events()])
        const report = current ? buildWindowReport(events, await starts(), current.start, Date.now() + 1) : null
        return {
            meta: await meta(),
            current,
            context: trimContext(context),
            contextMatches: !!current && !!context && context.sessionFile === current.sessionFile,
            report,
        }
    },

    "/storage": async (): Promise<StoragePayload> => {
        const [logs, summaries, blobs, handlers, config] = await Promise.all([
            store.logInfo(),
            store.summaryRecords(),
            store.blobInfo(),
            store.handlerRows(),
            store.config(),
        ])
        return {
            meta: await meta(),
            logs,
            summaries: summaries.info,
            blobs,
            handlers: handlerSummary(handlers, HANDLER_TABLE_MAX),
            config: Object.entries(config).map(([key, value]) => ({ key, value })),
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
        sendJson(res, 200, await route(url))
    } catch (error) {
        sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
        })
    }
})

server.listen(port, "127.0.0.1", () => {
    console.log(`[squeez-stats] listening on 127.0.0.1:${port} (home: ${store.home})`)
})
