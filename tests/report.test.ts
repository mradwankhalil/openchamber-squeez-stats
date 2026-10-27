import { describe, expect, test } from "bun:test"
import { buildSessionDetail, buildSessions, buildWindowReport, commandName, sessionStarts, toolLabel } from "../service/report"
import { parseLog, splitObjects, toContext, toCurrent, toSummary } from "../service/store"
import type { SqueezEvent, SummaryRecord } from "../service/store"

const T0 = new Date(2026, 9, 20, 10, 0, 0).getTime() // local 2026-10-20 10:00

function bash(minute: number, cmd: string, inTk: number, outTk: number, extra: Partial<SqueezEvent> = {}): SqueezEvent {
    return { kind: "bash", ts: T0 + minute * 60_000, cmd, inTk, outTk, files: [], errors: [], git: [], test: "", ...extra } as SqueezEvent
}

function tool(minute: number, name: string, tokens: number): SqueezEvent {
    return { kind: "tool", ts: T0 + minute * 60_000, tool: name, tokens }
}

function summary(minute: number, durationMin: number): SummaryRecord {
    return toSummary({ ts: (T0 + minute * 60_000) / 1000, duration_min: durationMin, efficiency_overall_bp: 5000 })!
}

describe("commandName", () => {
    test.each([
        ["git log --oneline", "git"],
        ["cd /c/repo && git status", "git"],
        ["cd x; cd y && node a.js", "node"],
        ["FOO=1 BAR=2 timeout 30 python -m x", "python"],
        ["timeout -k 5 120s bun test", "bun"],
        ['"C:/Program Files/Git/bin/bash.exe" -lc "ls"', "bash"],
        ["echo '== a'; grep -n x f", "grep"],
        ["export A=1", "export"],
        ["L=/c/x; ls $L", "ls"],
        ["python - <<'PY'\nprint(1)\nPY", "python"],
        ['S="/c/a b/SKILL.md"\necho "=="; head -4 "$S"', "head"],
        ["cd /c/x && n=$(grep -n 'x' f | cut -d: -f1); sed -n \"$n,$p\" f", "grep"],
        ['for f in a b; do echo "--- $f"; sed -n 1p "$f"; done', "sed"],
        ["nice -n 10 make", "make"],
        ["command -v node", "node"],
        ["cd /c/x && /usr/bin/timeout 110 node probe.mjs > out 2>&1", "node"],
        ["", "(empty)"],
    ])("%s -> %s", (cmd, expected) => {
        expect(commandName(cmd)).toBe(expected)
    })
})

test("toolLabel splits MCP names", () => {
    expect(toolLabel("mcp__openchamber__context-mode_ctx_execute")).toEqual({ name: "context-mode_ctx_execute", server: "openchamber" })
    expect(toolLabel("Read")).toEqual({ name: "Read", server: "" })
})

describe("parseLog", () => {
    test("recovers two events merged onto one line", () => {
        const a = JSON.stringify({ type: "tool", tool: "Grep", tokens_est: 6, ts: 1787728133 })
        const b = JSON.stringify({ type: "tool", tool: "Grep", tokens_est: 1090, ts: 1787728133 })
        const parsed = parseLog(`${a}${b}\n${a}\n{broken\n\n`)
        expect(parsed.events.length).toBe(3)
        expect(parsed.recovered).toBe(2)
        expect(parsed.unreadable).toBe(1)
    })

    test("splitObjects ignores braces inside strings", () => {
        expect(splitObjects('{"a":"}{"}{"b":1}')).toEqual(['{"a":"}{"}', '{"b":1}'])
    })

    test("maps bash fields and converts ts to ms", () => {
        const line = JSON.stringify({ type: "bash", cmd: "ls", in_tk: 10, out_tk: 4, files: ["a"], errors: [], git: [], test_summary: "", forced: "", ts: 100 })
        const [e] = parseLog(line).events
        expect(e).toEqual({ kind: "bash", ts: 100_000, cmd: "ls", inTk: 10, outTk: 4, files: ["a"], errors: [], git: [], test: "" })
    })
})

describe("buildWindowReport", () => {
    const events: SqueezEvent[] = [
        bash(0, "cd r && git log", 1000, 200, { errors: ["fatal: x"], files: ["a.ts"] }),
        bash(1, "git diff", 500, 100, { errors: ["fatal: x"] }),
        bash(2, "node build.js", 300, 300),
        bash(3, "ls", 10, 30),
        tool(4, "mcp__oc__read", 700),
        tool(5, "Read", 50),
        bash(200, "git status", 999, 1), // outside the window below
    ]

    test("totals follow squeez's saved rule and classify each command", () => {
        const r = buildWindowReport(events, [T0], T0, T0 + 60 * 60_000)
        expect(r.shell).toEqual({ commands: 4, inTokens: 1810, outTokens: 630, savedTokens: 1200, compressed: 2, unchanged: 1, grew: 1 })
        expect(r.tools).toEqual({ calls: 2, tokens: 750 })
        expect(r.sessionsStarted).toBe(1)
    })

    test("ranks commands by real program name", () => {
        const r = buildWindowReport(events, [], T0, T0 + 60 * 60_000)
        expect(r.topCommands.map((c) => [c.name, c.runs, c.savedTokens])).toEqual([["git", 2, 1200]])
        expect(r.weakCommands.map((c) => c.name)).toEqual(["node", "ls"])
        expect(r.errors).toEqual([{ text: "fatal: x", count: 2, last: T0 + 60_000 }])
        expect(r.files.map((f) => f.text)).toEqual(["a.ts"])
        expect(r.toolsByName[0]).toEqual({ name: "read", server: "oc", calls: 1, tokens: 700 })
    })

    test("uses hourly buckets for short windows", () => {
        const r = buildWindowReport(events, [], T0, T0 + 2 * 3_600_000)
        expect(r.granularity).toBe("hour")
        expect(r.series[0]?.savedTokens).toBe(1200)
        expect(r.series[0]?.toolCalls).toBe(2)
    })

    test("uses daily buckets for long windows", () => {
        const r = buildWindowReport(events, [], T0 - 10 * 86_400_000, T0 + 86_400_000)
        expect(r.granularity).toBe("day")
        const day = r.series.find((p) => p.commands > 0)
        expect(day?.commands).toBe(5)
    })
})

describe("sessions", () => {
    const summaries = [summary(0, 3), summary(3, 50)]
    const current = toCurrent({ session_file: "x.jsonl", start_ts: (T0 + 100 * 60_000) / 1000, total_tokens: 1, tokens_saved: 998, total_calls: 3 })
    const events: SqueezEvent[] = [
        bash(1, "git log", 100, 10),
        tool(2, "Read", 40),
        bash(150, "git status", 999, 1),
    ]

    test("starts merge finished sessions and the current one", () => {
        expect(sessionStarts(summaries, current)).toEqual([T0, T0 + 3 * 60_000, T0 + 100 * 60_000])
    })

    test("each session owns events until the next start", () => {
        const now = T0 + 200 * 60_000
        const s = buildSessions(events, summaries, current, 0, now, now)
        expect(s.total).toBe(3)
        expect(s.active).toBe(2)
        expect(s.empty).toBe(1)
        const [newest, middle, oldest] = s.rows
        expect(newest?.ongoing).toBe(true)
        expect(newest?.savedTokens).toBe(998)
        expect(middle?.shellCommands).toBe(0)
        expect(oldest?.savedTokens).toBe(90)
        expect(oldest?.toolCalls).toBe(1)
        expect(oldest?.summary?.scoreOverall).toBe(5000)
    })

    test("detail returns the session's own report", () => {
        const d = buildSessionDetail(events, summaries, current, T0, T0 + 200 * 60_000)
        expect(d.report?.shell.savedTokens).toBe(90)
        expect(d.summary?.durationMin).toBe(3)
        expect(buildSessionDetail(events, summaries, current, 12345, 0).row).toBeNull()
    })
})

test("toContext pairs error fingerprints with their text", () => {
    const ctx = toContext({
        session_file: "a.jsonl",
        error_snippet_fp: [1, 2],
        error_snippet_text: ["boom", "bang"],
        error_count_fp: [2, 1, 3],
        error_count_n: [5, 1, 9],
        file_mod_path: ["a.ts", "b.ts"],
        file_mod_n: [1, 4],
        call_log_n: [1, 2],
        call_log_cmd: ["ls", "git"],
        call_log_len: [10, 20],
    })!
    expect(ctx.repeatedErrors).toEqual([
        { text: "bang", count: 5 },
        { text: "boom", count: 1 },
    ])
    expect(ctx.fileEdits[0]).toEqual({ path: "b.ts", count: 4 })
    expect(ctx.recentCalls[0]).toEqual({ n: 2, label: "git", bytes: 20 })
})
