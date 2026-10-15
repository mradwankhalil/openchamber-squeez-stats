/**
 * Smoke test for the built service.
 *
 * Starts `service/main.js` against a temporary squeez home, then checks the
 * auth gate, `/health` and `/stats` aggregation.
 *
 * Run after `bun run build`:  node scripts/smoke.mjs
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import { createServer } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serviceEntry = path.join(root, "service", "main.js")

async function freePort() {
    const server = createServer()
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))
    return port
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), "sq-stats-smoke-"))
const sessions = path.join(home, "sessions")
await fs.mkdir(sessions, { recursive: true })
await fs.mkdir(path.join(home, "blobs"), { recursive: true })

await fs.writeFile(
    path.join(sessions, "current.json"),
    JSON.stringify({
        session_file: "2026-10-15-00.jsonl",
        total_tokens: 5000,
        tokens_saved: 3000,
        total_calls: 10,
        start_ts: Math.floor(Date.now() / 1000) - 600,
        overhead_tokens: 120,
    }),
)
await fs.writeFile(
    path.join(sessions, "handler_stats.json"),
    JSON.stringify({
        names: ["bash", "git"],
        calls: [100, 50],
        in_tokens: [100_000, 40_000],
        out_tokens: [25_000, 20_000],
    }),
)
await fs.writeFile(
    path.join(sessions, "2026-10-15-00.jsonl"),
    [
        JSON.stringify({ type: "bash", cmd: "ls", in_tk: 400, out_tk: 100, ts: 1792022407 }),
        JSON.stringify({ type: "bash", cmd: "git status", in_tk: 600, out_tk: 200, ts: 1792022500 }),
        JSON.stringify({ type: "tool", tool: "TodoWrite", tokens_est: 19, ts: 1792002902 }),
        "{broken line",
        "",
    ].join("\n"),
)
await fs.writeFile(path.join(home, "blobs", "blob-1.txt"), "x".repeat(2048))

const port = await freePort()
const token = "smoke-token"
const child = spawn(process.execPath, [serviceEntry], {
    env: {
        ...process.env,
        OPENCHAMBER_SERVICE_PORT: String(port),
        OPENCHAMBER_SERVICE_TOKEN: token,
        SQUEEZ_STATS_HOME: home,
        // keep pricing hermetic: no real db, no network cache reuse
        OPENCODE_DB_PATH: path.join(home, "does-not-exist.db"),
        STATS_PRICING_CACHE: path.join(home, "no-cache.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
})

let stderr = ""
child.stderr.on("data", (chunk) => {
    stderr += chunk
})

try {
    const base = `http://127.0.0.1:${port}`

    let up = false
    for (let i = 0; i < 50; i++) {
        try {
            await fetch(`${base}/health`)
            up = true
            break
        } catch {
            await new Promise((r) => setTimeout(r, 100))
        }
    }
    if (!up) throw new Error("service did not start:\n" + stderr)

    const unauthorized = await fetch(`${base}/health`)
    assert.equal(unauthorized.status, 401, "health without token must be 401")

    const headers = { authorization: `Bearer ${token}` }

    const health = await fetch(`${base}/health`, { headers })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    const stats = await fetch(`${base}/stats`, { headers })
    assert.equal(stats.status, 200)
    const body = await stats.json()
    assert.equal(body.ok, true)

    // live session
    assert.equal(body.live.sessionFile, "2026-10-15-00.jsonl")
    assert.equal(body.live.events, 3, "broken line must be skipped")
    assert.equal(body.live.inTokens, 1019)
    assert.equal(body.live.outTokens, 319)

    // all-time from handler_stats
    assert.equal(body.allTime.totalCalls, 150)
    assert.equal(body.allTime.inTokens, 140_000)
    assert.equal(body.allTime.outTokens, 45_000)
    assert.equal(body.allTime.savedTokens, 95_000)
    assert.equal(body.allTime.handlers[0].name, "bash")

    // daily series
    assert.equal(body.daily.length, 1)
    assert.equal(body.daily[0].day, "2026-10-15")
    assert.equal(body.daily[0].events, 3)
    assert.equal(body.daily[0].savedTokens, 700)
    assert.equal(body.scope.kind, "all")
    assert.equal(body.scoped, null, "unscoped has no scoped aggregate")
    assert.ok(Array.isArray(body.sessions) && body.sessions.length === 1)
    assert.equal(body.sessions[0].stem, "2026-10-15-00")
    assert.equal(body.sessions[0].savedTokens, 700)

    // ---- scope: single session log
    const sessStats = await fetch(`${base}/stats?session=2026-10-15-00`, { headers })
    const sessBody = await sessStats.json()
    assert.equal(sessBody.scope.kind, "session")
    assert.equal(sessBody.scoped.events, 3)
    assert.equal(sessBody.scoped.savedTokens, 700)
    assert.equal(sessBody.allTime, null, "scoped view replaces allTime")
    assert.ok(sessBody.scoped.handlers.some((h) => h.name === "git"), "bash cmd name aggregated")
    assert.ok(sessBody.scoped.handlers.some((h) => h.name === "TodoWrite"), "tool name aggregated")

    // ---- scope: day range covering the fixture day
    const rangeStats = await fetch(`${base}/stats?from=2026-10-15&to=2026-10-15`, { headers })
    const rangeBody = await rangeStats.json()
    assert.equal(rangeBody.scope.kind, "range")
    assert.equal(rangeBody.scoped.events, 2, "tool event is local Oct 14 21:35 - outside the Oct 15 day")
    assert.equal(rangeBody.scoped.savedTokens, 700)

    // ---- scope: range excluding everything
    const emptyStats = await fetch(`${base}/stats?from=2020-01-01&to=2020-01-01`, { headers })
    const emptyBody = await emptyStats.json()
    assert.equal(emptyBody.scoped.events, 0)
    assert.equal(emptyBody.daily.length, 0)

    // blobs
    assert.equal(body.blobs.count, 1)
    assert.equal(body.blobs.bytes, 2048)

    const missing = await fetch(`${base}/nope`, { headers })
    assert.equal(missing.status, 404)

    console.log("smoke ok: auth, /health, /stats, live+allTime+daily+blobs, scopes (all/session/range/empty), malformed-line skip")
} finally {
    child.kill("SIGTERM")
    await fs.rm(home, { recursive: true, force: true })
    if (child.exitCode !== null && child.exitCode !== 0 && stderr) {
        console.error(stderr)
    }
}
