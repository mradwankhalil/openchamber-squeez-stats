/**
 * Smoke test for the built service.
 *
 * Starts `service/main.js` against a temporary squeez home that has every
 * file squeez writes, then checks auth and every endpoint.
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

// ---- fixture: two finished sessions and the current one, all within the last hour
const nowSec = Math.floor(Date.now() / 1000)
const s1 = nowSec - 3000 // finished session 1
const s2 = nowSec - 2400 // finished session 2 (no activity)
const s3 = nowSec - 1800 // current session

const home = await fs.mkdtemp(path.join(os.tmpdir(), "sq-stats-smoke-"))
const sessions = path.join(home, "sessions")
await fs.mkdir(sessions, { recursive: true })
await fs.mkdir(path.join(home, "memory"), { recursive: true })
await fs.mkdir(path.join(home, "blobs"), { recursive: true })

const bash = (ts, cmd, inTk, outTk, extra = {}) =>
    JSON.stringify({ type: "bash", cmd, in_tk: inTk, out_tk: outTk, files: [], errors: [], git: [], test_summary: "", forced: "", ts, ...extra })
const tool = (ts, name, tokens) => JSON.stringify({ type: "tool", tool: name, tokens_est: tokens, ts })

await fs.writeFile(
    path.join(sessions, "2026-10-15-00.jsonl"),
    [
        JSON.stringify({ type: "git_snapshot", log: "abc init", status: "", ts: s1 }),
        bash(s1 + 10, "cd repo && git log", 1000, 200, { errors: ["fatal: bad ref"], files: ["a.ts"], git: ["abc1234 init"] }),
        bash(s1 + 20, "node build.js", 300, 300, { test_summary: "12 passed" }),
        tool(s1 + 30, "mcp__openchamber__read", 400) + tool(s1 + 31, "Grep", 50), // two events on one line
        "{broken line",
        "",
    ].join("\n"),
)
await fs.writeFile(
    path.join(sessions, "2026-10-15-01.jsonl"),
    [bash(s3 + 10, "git status", 600, 100), tool(s3 + 20, "Read", 70), ""].join("\n"),
)
await fs.writeFile(
    path.join(sessions, "current.json"),
    JSON.stringify({ session_file: "2026-10-15-01.jsonl", total_tokens: 100, tokens_saved: 500, total_calls: 2, start_ts: s3, overhead_tokens: 40 }),
)
await fs.writeFile(
    path.join(sessions, "context.json"),
    JSON.stringify({
        session_file: "2026-10-15-01.jsonl",
        call_counter: 42,
        call_log_n: [41, 42],
        call_log_cmd: ["git status", "mcp__openchamber__read"],
        call_log_len: [300, 900],
        error_snippet_fp: [7],
        error_snippet_text: ["fatal: bad ref"],
        error_count_fp: [7],
        error_count_n: [3],
        file_mod_path: ["a.ts"],
        file_mod_n: [2],
        tokens_bash: 100,
        tokens_read: 70,
        tokens_grep: 0,
        tokens_other: 0,
        exact_dedup_hits: 1,
        real_ctx_tokens: 50000,
        real_ctx_window: 200000,
        real_cache_read_tokens: 40000,
        seen_files_path: ["a.ts", "b.ts"],
    }),
)
await fs.writeFile(
    path.join(sessions, "handler_stats.json"),
    JSON.stringify({ names: ["cd", "node"], calls: [1, 1], in_tokens: [1000, 300], out_tokens: [200, 300] }),
)
const summary = (start, durationMin, extra = {}) =>
    JSON.stringify({
        date: "2026-10-15",
        duration_min: durationMin,
        tokens_saved: 99999,
        files_touched: ["a.ts"],
        files_committed: [],
        test_summary: "",
        errors_resolved: [],
        git_events: [],
        ts: start,
        valid_from: start,
        valid_to: 0,
        investigated: [],
        learned: [],
        completed: [],
        next_steps: ["fatal: bad ref"],
        compression_ratio_bp: 6153,
        tool_choice_efficiency_bp: 10000,
        context_reuse_rate_bp: 0,
        budget_utilization_bp: 9000,
        efficiency_overall_bp: 6646,
        ...extra,
    })
await fs.writeFile(path.join(home, "memory", "summaries.jsonl"), [summary(s1, 10), summary(s2, 10), "not json", ""].join("\n"))
await fs.writeFile(path.join(home, "blobs", "b1"), "x".repeat(2048))
await fs.writeFile(path.join(home, "blobs", "b1.idx"), JSON.stringify({ terms: [], shingles: [], preview: "big output", byte_count: 2048 }))
await fs.writeFile(path.join(home, "config.ini"), "# squeez\nenabled = true\nmemory_retention_days = 30\n")

// ---- run the service
const port = await freePort()
const token = "smoke-token"

// an empty user profile, so discovery never finds this machine's real squeez
const fakeUser = await fs.mkdtemp(path.join(os.tmpdir(), "sq-stats-user-"))

function startService(squeezHome) {
    const child = spawn(process.execPath, [serviceEntry], {
        env: {
            ...process.env,
            HOME: fakeUser,
            USERPROFILE: fakeUser,
            SQUEEZ_DIR: "",
            OPENCHAMBER_SERVICE_PORT: String(port),
            OPENCHAMBER_SERVICE_TOKEN: token,
            SQUEEZ_STATS_HOME: squeezHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
        stderr += chunk
    })
    return { child, stderr: () => stderr }
}

const base = `http://127.0.0.1:${port}`
const headers = { authorization: `Bearer ${token}` }

async function waitUp(svc) {
    for (let i = 0; i < 50; i++) {
        try {
            await fetch(`${base}/health`)
            return
        } catch {
            await new Promise((r) => setTimeout(r, 100))
        }
    }
    throw new Error("service did not start:\n" + svc.stderr())
}

async function get(p) {
    const res = await fetch(`${base}${p}`, { headers })
    assert.equal(res.status, 200, `${p} -> ${res.status}`)
    return res.json()
}

let svc = startService(home)
try {
    await waitUp(svc)

    assert.equal((await fetch(`${base}/health`)).status, 401, "health without token must be 401")
    assert.deepEqual(await get("/health"), { ok: true })
    assert.equal((await fetch(`${base}/nope`, { headers })).status, 404)

    // /status: today's line
    const status = await get(`/status?start=${(nowSec - 3600) * 1000}`)
    assert.equal(status.meta.available, true)
    assert.deepEqual(status.shell, { commands: 3, inTokens: 1900, outTokens: 600, savedTokens: 1300, compressed: 2, unchanged: 1, grew: 0 })
    assert.deepEqual(status.tools, { calls: 3, tokens: 520 }, "merged line yields both tool events")

    // /overview
    const overview = await get("/overview?start=0")
    const r = overview.report
    assert.equal(r.granularity, "hour")
    assert.equal(r.sessionsStarted, 3)
    assert.deepEqual(r.topCommands.map((c) => [c.name, c.runs, c.savedTokens]), [["git", 2, 1300]])
    assert.deepEqual(r.weakCommands.map((c) => c.name), ["node"])
    assert.equal(r.errors[0].text, "fatal: bad ref")
    assert.equal(r.files[0].text, "a.ts")
    assert.equal(r.git[0].text, "abc1234 init")
    assert.equal(r.tests[0].text, "12 passed")
    assert.equal(r.toolsByName[0].name, "read")
    assert.ok(r.series.reduce((s, p) => s + p.savedTokens, 0) === 1300, "series adds up")

    // /sessions: s1 active, s2 empty, s3 current
    const list = await get("/sessions?start=0")
    assert.equal(list.total, 3)
    assert.equal(list.active, 2)
    assert.equal(list.empty, 1)
    assert.equal(list.rows[0].ongoing, true)
    assert.equal(list.rows[0].savedTokens, 500)
    assert.equal(list.rows[2].savedTokens, 800, "session 1 recounted from events, not its tokens_saved field")
    assert.equal(list.rows[2].summary.scoreOverall, 6646)

    // /session detail
    const detail = await get(`/session?start=${s1 * 1000}`)
    assert.equal(detail.summary.nextSteps[0], "fatal: bad ref")
    assert.equal(detail.report.shell.commands, 2)
    assert.equal(detail.report.tools.calls, 2)
    const gone = await get("/session?start=123")
    assert.equal(gone.row, null)

    // /now
    const now = await get("/now")
    assert.equal(now.current.savedTokens, 500)
    assert.equal(now.current.overheadTokens, 40)
    assert.equal(now.contextMatches, true)
    assert.equal(now.context.ctxTokens, 50000)
    assert.deepEqual(now.context.repeatedErrors, [{ text: "fatal: bad ref", count: 3 }])
    assert.equal(now.context.recentCalls[0].label, "mcp__openchamber__read")
    assert.equal(now.report.shell.savedTokens, 500)

    // /storage
    const storage = await get("/storage")
    assert.equal(storage.logs.files, 2)
    assert.equal(storage.logs.recoveredEvents, 2)
    assert.equal(storage.logs.unreadableLines, 1)
    assert.equal(storage.summaries.count, 2)
    assert.equal(storage.summaries.unreadableLines, 1)
    assert.equal(storage.blobs.count, 1)
    assert.equal(storage.blobs.bytes, 2048)
    assert.equal(storage.blobs.largest[0].preview, "big output")
    assert.equal(storage.handlers.used, 2)
    assert.equal(storage.handlers.max, 64)
    assert.deepEqual(storage.config.find((c) => c.key === "memory_retention_days"), { key: "memory_retention_days", value: "30" })

    // list lengths come from the query
    const limited = await get(`/overview?start=0&limits=${encodeURIComponent(JSON.stringify({ toolsByName: 1 }))}`)
    assert.equal(limited.report.toolsByName.length, 1)
    assert.ok(overview.report.toolsByName.length > 1)

    // /locations reports what is read and whether it exists
    const loc = await get("/locations")
    assert.equal(loc.pathSource, "auto")
    assert.equal(loc.paths.home, home)
    assert.deepEqual(
        loc.checks.map((c) => [c.id, c.exists]),
        [["home", true], ["sessions", true], ["summaries", true], ["blobs", true], ["config", true]],
    )
    assert.ok(loc.candidates.some((c) => c.path === home && c.source === "env"))
    assert.equal(overview.meta.paths.sessionsDir, sessions)

    // locations chosen in the panel's settings override discovery
    const moved = path.join(home, "moved-logs")
    await fs.mkdir(moved)
    await fs.copyFile(path.join(sessions, "2026-10-15-01.jsonl"), path.join(moved, "2026-10-15-01.jsonl"))
    const viaQuery = await get(`/status?start=0&sessions=${encodeURIComponent(moved)}`)
    assert.equal(viaQuery.meta.pathSource, "auto", "home still discovered")
    assert.equal(viaQuery.meta.paths.sessionsDir, moved)
    assert.equal(viaQuery.shell.commands, 1, "only the moved log is read")
    const chosen = await get(`/locations?home=${encodeURIComponent(path.join(home, "nope"))}`)
    assert.equal(chosen.pathSource, "settings")
    assert.equal(chosen.checks.find((c) => c.id === "sessions").exists, false)
    const relative = await get(`/locations?home=relative/dir`)
    assert.equal(relative.pathSource, "auto", "relative paths are ignored")

    // appending to the live log is picked up on the next request (cache invalidation)
    await fs.appendFile(path.join(sessions, "2026-10-15-01.jsonl"), bash(s3 + 30, "git diff", 100, 10) + "\n")
    const after = await get(`/status?start=${(nowSec - 3600) * 1000}`)
    assert.equal(after.shell.commands, 4)

    svc.child.kill("SIGTERM")

    // missing squeez home
    svc = startService(path.join(home, "nope"))
    await waitUp(svc)
    const missing = await get("/overview?start=0")
    assert.equal(missing.meta.available, false)
    assert.equal(missing.report.shell.commands, 0)

    console.log(
        "smoke ok: auth, 404, /status, /overview, /sessions, /session, /now, /storage, /locations, path overrides, list limits, merged-line recovery, cache refresh, missing home",
    )
} finally {
    svc.child.kill("SIGTERM")
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(fakeUser, { recursive: true, force: true })
}
