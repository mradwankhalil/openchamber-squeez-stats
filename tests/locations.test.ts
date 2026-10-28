import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { DEFAULT_LIMITS, LIMIT_MAX, buildWindowReport, normalizeLimits, trimContext } from "../service/report"
import { checkPaths, cleanOverrides, discoverHomes, pickHome, resolvePaths } from "../service/store"
import type { SqueezEvent } from "../service/store"

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sq-stats-loc-"))
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

async function store(dir: string, logs: string[], mtimeSec?: number): Promise<void> {
    const sessions = path.join(dir, "sessions")
    await fs.mkdir(sessions, { recursive: true })
    for (const name of logs) {
        const file = path.join(sessions, name)
        await fs.writeFile(file, "")
        if (mtimeSec !== undefined) await fs.utimes(file, mtimeSec, mtimeSec)
    }
}

describe("discovery", () => {
    test("prefers the store written most recently", async () => {
        const user = path.join(tmp, "user1")
        await store(path.join(user, ".claude", "squeez"), ["2026-10-01-10.jsonl"], 1_700_000_000)
        await store(path.join(user, ".copilot", "squeez"), ["2026-10-02-10.jsonl"], 1_800_000_000)
        const found = await discoverHomes({}, user)
        expect(found.map((c) => path.relative(user, c.path).split(path.sep)[0])).toEqual([
            ".claude",
            ".copilot",
            ".codex",
            ".gemini",
            ".hermes",
            ".pi",
            ".config",
        ])
        expect(found[0]?.hasSessions).toBe(true)
        expect(found[2]?.hasSessions).toBe(false)
        expect(pickHome(found, user)).toBe(path.join(user, ".copilot", "squeez"))
    })

    test("an environment override that exists wins", async () => {
        const user = path.join(tmp, "user2")
        const custom = path.join(tmp, "custom-store")
        await store(path.join(user, ".claude", "squeez"), ["2026-10-01-10.jsonl"])
        await store(custom, [])
        const found = await discoverHomes({ SQUEEZ_DIR: custom }, user)
        expect(found[0]).toMatchObject({ path: custom, source: "env", hasSessions: true, logFiles: 0 })
        expect(pickHome(found, user)).toBe(custom)
    })

    test("nothing installed falls back to Claude Code's default location", async () => {
        const user = path.join(tmp, "user3")
        const found = await discoverHomes({ SQUEEZ_STATS_HOME: path.join(tmp, "missing") }, user)
        expect(found.every((c) => !c.hasSessions)).toBe(true)
        expect(pickHome(found, user)).toBe(path.join(user, ".claude", "squeez"))
    })
})

describe("locations", () => {
    test("each override wins on its own; the rest derive from the folder", () => {
        const home = path.join(tmp, "h")
        const logs = path.join(tmp, "elsewhere", "logs")
        const p = resolvePaths(home, { sessions: logs })
        expect(p).toEqual({
            home,
            sessionsDir: logs,
            summariesFile: path.join(home, "memory", "summaries.jsonl"),
            blobsDir: path.join(home, "blobs"),
            configFile: path.join(home, "config.ini"),
        })
        expect(resolvePaths(home, { home: logs }).configFile).toBe(path.join(logs, "config.ini"))
    })

    test("relative and blank paths are ignored", () => {
        const abs = path.join(tmp, "abs")
        expect(cleanOverrides({ home: "relative/dir", sessions: "  ", config: abs, blobs: null })).toEqual({ config: abs })
    })

    test("checks say which locations exist", async () => {
        const home = path.join(tmp, "checked")
        await store(home, [])
        await fs.writeFile(path.join(home, "config.ini"), "x = 1\n")
        const checks = await checkPaths(resolvePaths(home))
        expect(Object.fromEntries(checks.map((c) => [c.id, c.exists]))).toEqual({
            home: true,
            sessions: true,
            summaries: false,
            blobs: false,
            config: true,
        })
        expect(checks.filter((c) => c.required).map((c) => c.id)).toEqual(["sessions"])
    })
})

describe("list limits", () => {
    test("untrusted input is clamped and unknown keys dropped", () => {
        const l = normalizeLimits({ topCommands: 3, errors: 999, files: -4, git: "7", bogus: 5, tests: "x" })
        expect(l.topCommands).toBe(3)
        expect(l.errors).toBe(LIMIT_MAX)
        expect(l.files).toBe(1)
        expect(l.git).toBe(7)
        expect(l.tests).toBe(DEFAULT_LIMITS.tests)
        expect("bogus" in l).toBe(false)
        expect(normalizeLimits("nope")).toEqual(DEFAULT_LIMITS)
    })

    test("reports return as many rows as asked", () => {
        const t0 = Date.now() - 3_600_000
        const events: SqueezEvent[] = Array.from({ length: 30 }, (_, i) => ({
            kind: "bash",
            ts: t0 + i * 1000,
            cmd: `prog${i} --flag`,
            inTk: 1000 + i,
            outTk: 10,
            files: [`f${i}.ts`],
            errors: [`error ${i}`],
            git: [],
            test: "",
        })) as SqueezEvent[]
        const small = buildWindowReport(events, [], 0, Date.now(), normalizeLimits({ topCommands: 2, largestOutputs: 3, files: 4, errors: 5 }))
        expect(small.topCommands).toHaveLength(2)
        expect(small.largestOutputs).toHaveLength(3)
        expect(small.largestOutputs[0]?.inTokens).toBe(1029)
        expect(small.files).toHaveLength(4)
        expect(small.errors).toHaveLength(5)
        const big = buildWindowReport(events, [], 0, Date.now(), normalizeLimits({ topCommands: 25, largestOutputs: 20 }))
        expect(big.topCommands).toHaveLength(25)
        expect(big.largestOutputs).toHaveLength(20)
        expect(buildWindowReport(events, [], 0, Date.now()).topCommands).toHaveLength(DEFAULT_LIMITS.topCommands)
    })

    test("context lists follow the limits", () => {
        const ctx = trimContext(
            {
                recentCalls: Array.from({ length: 20 }, (_, n) => ({ n, label: "x", bytes: 1 })),
                repeatedErrors: [],
                fileEdits: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}`, count: 1 })),
                repeatedCommands: [],
            } as never,
            normalizeLimits({ recentCalls: 4, fileEdits: 15 }),
        )
        expect(ctx?.recentCalls).toHaveLength(4)
        expect(ctx?.fileEdits).toHaveLength(15)
    })
})
