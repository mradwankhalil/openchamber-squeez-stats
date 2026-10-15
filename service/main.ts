/**
 * Squeez Stats — local service.
 *
 * Runs as the extension's local process (manifest `contributes.service`) on
 * 127.0.0.1, reachable only through the OpenChamber host proxy. It reads the
 * squeez state files and answers the panel's `serviceRequest` calls.
 *
 * Endpoints (bearer token required on every request, including `/health`):
 *   GET /health                                    → { ok: true }
 *   GET /stats                                     → StatsPayload (all time)
 *   GET /stats?session=2026-10-15-00               → scoped to one session log
 *   GET /stats?from=YYYY-MM-DD&to=YYYY-MM-DD       → scoped to a day range
 */

import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { StatsStore, resolveSqueezHome } from "./stats"
import type { Scope } from "./stats"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || ""

if (!Number.isInteger(port) || port <= 0 || !token) {
    console.error("[squeez-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required")
    process.exit(1)
}

const store = new StatsStore(resolveSqueezHome())

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
    })
    res.end(payload)
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

        if (req.method === "GET" && url.pathname === "/stats") {
            const scope: Scope = {}
            const session = (url.searchParams.get("session") ?? "").trim()
            const from = (url.searchParams.get("from") ?? "").trim()
            const to = (url.searchParams.get("to") ?? "").trim()
            if (session && /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(session)) scope.session = session
            else {
                if (DAY_RE.test(from)) scope.from = from
                if (DAY_RE.test(to)) scope.to = to
            }
            sendJson(res, 200, await store.getStats(scope))
            return
        }

        sendJson(res, 404, { error: "not found" })
    } catch (error) {
        sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
        })
    }
})

server.listen(port, "127.0.0.1", () => {
    console.log(`[squeez-stats] listening on 127.0.0.1:${port} (home: ${store.squeezHome})`)
})
