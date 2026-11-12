import { expect, test } from "bun:test"
import { RECOVERY_DELAYS_MS, createRefreshScheduler, diagnoseFailure, isPermanentFailure } from "../panel/recovery"
import type { RefreshRequest, RunOutcome } from "../panel/recovery"

/** Deterministic clock: timers only fire when the test advances time. */
function harness(options: { autoRefresh?: boolean; intervalMs?: number } = {}) {
    let now = 0
    let nextId = 1
    const timers = new Map<number, { at: number; fn: () => void }>()
    const outcomes: (RunOutcome | (() => Promise<RunOutcome>))[] = []
    const runs: (RefreshRequest & { at: number; visible: boolean; settingsView: boolean })[] = []
    let inFlight = 0
    let maxInFlight = 0
    const env = {
        autoRefresh: options.autoRefresh ?? true,
        intervalMs: options.intervalMs ?? 60_000,
        visible: true,
        settingsView: false,
    }
    const scheduler = createRefreshScheduler({
        run: async (request) => {
            runs.push({ ...request, at: now, visible: env.visible, settingsView: env.settingsView })
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            try {
                const next = outcomes.shift() ?? { kind: "ok" }
                return typeof next === "function" ? await next() : next
            } finally {
                inFlight--
            }
        },
        autoRefresh: () => env.autoRefresh,
        intervalMs: () => env.intervalMs,
        isVisible: () => env.visible,
        canRunAutomatically: () => env.visible && !env.settingsView,
        setTimer: (fn, ms) => {
            const id = nextId++
            timers.set(id, { at: now + ms, fn })
            return id
        },
        clearTimer: (id) => { timers.delete(id as number) },
        now: () => now,
    })
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
    /** a request that takes `ms` of fake time */
    const sleep = (ms: number) => new Promise<void>((resolve) => { timers.set(nextId++, { at: now + ms, fn: resolve }) })
    /** the next request stays open until the returned function settles it */
    const hold = () => {
        let release!: (o: RunOutcome) => void
        outcomes.push(() => new Promise<RunOutcome>((resolve) => { release = resolve }))
        return (o: RunOutcome) => release(o)
    }
    return {
        sleep, hold,
        scheduler, runs, env, timers, outcomes,
        get maxInFlight() { return maxInFlight },
        get now() { return now },
        /** Advance the clock, firing due timers in order. */
        async advance(ms: number) {
            const end = now + ms
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
                if (!due) break
                timers.delete(due[0])
                now = due[1].at
                due[1].fn()
                await flush()
            }
            now = end
            await flush()
        },
        pendingDelays: () => [...timers.values()].map((t) => t.at - now),
        flush,
    }
}

const transient = (code = "HOST_TIMEOUT"): RunOutcome => ({ kind: "failed", code })

test("first request fails, then recovers well before the 60 s interval", async () => {
    const h = harness()
    h.outcomes.push(transient("SERVICE_FAILED"))
    await h.scheduler.trigger("startup")
    expect(h.scheduler.state().phase).toBe("recovering")
    expect(h.pendingDelays()).toEqual([RECOVERY_DELAYS_MS[0]])
    await h.advance(RECOVERY_DELAYS_MS[0])
    expect(h.runs).toHaveLength(2)
    expect(h.runs[1]!.at).toBeLessThan(60_000)
    expect(h.scheduler.state().phase).toBe("healthy")
})

test("retries back off and are bounded; persistent failure falls back to the saved cadence", async () => {
    const h = harness()
    for (let i = 0; i < 20; i++) h.outcomes.push(transient())
    await h.scheduler.trigger("startup")
    const gaps: number[] = []
    for (let i = 0; i < RECOVERY_DELAYS_MS.length; i++) {
        gaps.push(h.pendingDelays()[0]!)
        await h.advance(h.pendingDelays()[0]!)
    }
    expect(gaps).toEqual([...RECOVERY_DELAYS_MS])
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!)
    expect(h.runs).toHaveLength(1 + RECOVERY_DELAYS_MS.length)
    expect(h.scheduler.state().phase).toBe("failing")
    // no more fast retries: the next one waits the user's normal interval
    expect(h.pendingDelays()).toEqual([60_000])
    await h.advance(59_999)
    expect(h.runs).toHaveLength(1 + RECOVERY_DELAYS_MS.length)
    await h.advance(1)
    expect(h.runs).toHaveLength(2 + RECOVERY_DELAYS_MS.length)
    expect(h.pendingDelays()).toEqual([60_000])
})

test("recovery is bounded by attempts: four retries, 30 s of backoff in total", () => {
    expect(RECOVERY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(30_000)
    expect(RECOVERY_DELAYS_MS.length).toBe(4)
})

test("backoff is not a wall-clock budget: slow failures stretch recovery past 30 s, still four retries", async () => {
    const h = harness()
    const slowFailure = () => h.sleep(20_000).then(() => transient())
    for (let i = 0; i < 6; i++) h.outcomes.push(slowFailure)
    void h.scheduler.trigger("startup")
    await h.flush()
    await h.advance(5 * 20_000 + 30_000 - 1)
    expect(h.runs).toHaveLength(1 + RECOVERY_DELAYS_MS.length)
    expect(h.scheduler.state().phase).toBe("recovering")
    await h.advance(1)
    // 5 attempts of 20 s each plus 30 s of backoff: 130 s before the normal cadence takes over
    expect(h.now).toBe(130_000)
    expect(h.scheduler.state().phase).toBe("failing")
    expect(h.runs.map((r) => r.at)).toEqual([0, 22_000, 46_000, 74_000, 110_000])
    expect(h.pendingDelays()).toEqual([60_000])
    expect(h.maxInFlight).toBe(1)
})

for (const code of ["NO_SERVICE", "NOT_GRANTED", "DISABLED"]) {
    test(`${code} is permanent: no retry timer, automatic triggers ignored until the user acts`, async () => {
        const h = harness()
        h.outcomes.push({ kind: "failed", code })
        await h.scheduler.trigger("startup")
        expect(h.scheduler.state().phase).toBe("halted")
        expect(h.timers.size).toBe(0)
        await h.scheduler.trigger("auto")
        await h.scheduler.trigger("lifecycle")
        h.scheduler.visibilityChanged()
        await h.flush()
        expect(h.runs).toHaveLength(1)
        await h.scheduler.trigger("user")
        expect(h.runs).toHaveLength(2)
        expect(h.scheduler.state().phase).toBe("healthy")
    })
}

test("permanent classification covers permission, disabled and client errors only", () => {
    for (const code of ["NO_SERVICE", "NOT_GRANTED", "DISABLED", "HOST_UNAVAILABLE", "BAD_PATH"]) expect(isPermanentFailure(code)).toBe(true)
    for (const code of ["HOST_TIMEOUT", "SERVICE_FAILED", "REQUEST_FAILED", null]) expect(isPermanentFailure(code)).toBe(false)
    expect(isPermanentFailure(null, 500)).toBe(false)
    expect(isPermanentFailure(null, 503)).toBe(false)
    expect(isPermanentFailure(null, 404)).toBe(true)
})

test("never more than one request in flight; triggers during a request coalesce into one follow-up", async () => {
    const h = harness()
    let release!: (o: RunOutcome) => void
    h.outcomes.push(() => new Promise<RunOutcome>((resolve) => { release = resolve }))
    const first = h.scheduler.trigger("startup")
    await h.flush()
    const second = h.scheduler.trigger("user", { manual: true })
    const third = h.scheduler.trigger("lifecycle", { rescan: true })
    await h.flush()
    expect(h.runs).toHaveLength(1)
    release({ kind: "ok" })
    await Promise.all([first, second, third])
    expect(h.maxInFlight).toBe(1)
    expect(h.runs).toHaveLength(2)
    expect(h.runs[1]).toMatchObject({ manual: true, rescan: true, source: "user" })
})

test("timer cannot start a second request while one is in flight", async () => {
    const h = harness({ intervalMs: 5_000 })
    await h.scheduler.trigger("startup")
    let release!: (o: RunOutcome) => void
    h.outcomes.push(() => new Promise<RunOutcome>((resolve) => { release = resolve }))
    await h.advance(5_000)
    expect(h.runs).toHaveLength(2)
    await h.advance(30_000)
    expect(h.runs).toHaveLength(2)
    expect(h.timers.size).toBe(0)
    release({ kind: "ok" })
    await h.flush()
    expect(h.maxInFlight).toBe(1)
    expect(h.pendingDelays()).toEqual([5_000])
})

test("after recovery the saved normal interval is restored", async () => {
    const h = harness({ intervalMs: 120_000 })
    h.outcomes.push(transient(), transient())
    await h.scheduler.trigger("startup")
    await h.advance(RECOVERY_DELAYS_MS[0])
    await h.advance(RECOVERY_DELAYS_MS[1])
    expect(h.scheduler.state().phase).toBe("healthy")
    expect(h.scheduler.state().attempt).toBe(0)
    expect(h.pendingDelays()).toEqual([120_000])
})

test("a superseded response (navigation, path or settings change) runs the current request instead", async () => {
    const h = harness()
    h.outcomes.push({ kind: "superseded" }, { kind: "ok" })
    await h.scheduler.trigger("startup")
    expect(h.runs).toHaveLength(2)
    expect(h.scheduler.state().phase).toBe("healthy")
    expect(h.pendingDelays()).toEqual([60_000])
})

test("hidden frame cancels the retry timer; becoming visible resumes recovery", async () => {
    const h = harness()
    h.outcomes.push(transient())
    await h.scheduler.trigger("startup")
    expect(h.timers.size).toBe(1)
    h.env.visible = false
    h.scheduler.visibilityChanged()
    expect(h.timers.size).toBe(0)
    await h.advance(120_000)
    expect(h.runs).toHaveLength(1)
    h.env.visible = true
    h.scheduler.visibilityChanged()
    await h.flush()
    expect(h.runs).toHaveLength(2)
    expect(h.scheduler.state().phase).toBe("healthy")
})

test("a timer that fires while hidden does not request and does not re-arm", async () => {
    const h = harness({ intervalMs: 5_000 })
    await h.scheduler.trigger("startup")
    h.env.visible = false
    await h.advance(5_000)
    expect(h.runs).toHaveLength(1)
    expect(h.timers.size).toBe(0)
})

test("settings view skips automatic ticks without consuming recovery attempts", async () => {
    const h = harness()
    h.outcomes.push(transient())
    await h.scheduler.trigger("startup")
    h.env.settingsView = true
    await h.advance(RECOVERY_DELAYS_MS[0])
    expect(h.runs).toHaveLength(1)
    expect(h.scheduler.state().attempt).toBe(1)
})

test("dispose cancels timers and ignores a late completion", async () => {
    const h = harness()
    let release!: (o: RunOutcome) => void
    h.outcomes.push(() => new Promise<RunOutcome>((resolve) => { release = resolve }))
    const pending = h.scheduler.trigger("startup")
    await h.flush()
    h.scheduler.dispose()
    release(transient())
    await pending
    expect(h.timers.size).toBe(0)
    await h.scheduler.trigger("user")
    expect(h.runs).toHaveLength(1)
})

test("auto-refresh off: no polling, startup/user loads still get bounded recovery", async () => {
    const h = harness({ autoRefresh: false })
    await h.scheduler.trigger("startup")
    expect(h.timers.size).toBe(0)
    h.outcomes.push(transient(), { kind: "ok" })
    await h.scheduler.trigger("user", { manual: true })
    expect(h.scheduler.state().phase).toBe("recovering")
    await h.advance(RECOVERY_DELAYS_MS[0])
    expect(h.runs).toHaveLength(3)
    expect(h.scheduler.state().phase).toBe("healthy")
    expect(h.timers.size).toBe(0)
})

test("auto-refresh off: a failed chat-lifecycle refresh is not retried by itself", async () => {
    const h = harness({ autoRefresh: false })
    h.outcomes.push(transient())
    await h.scheduler.trigger("lifecycle")
    expect(h.scheduler.state().phase).toBe("failing")
    expect(h.timers.size).toBe(0)
})

test("turning auto-refresh off cancels the normal timer; turning it on re-arms the saved interval", async () => {
    const h = harness({ intervalMs: 30_000 })
    await h.scheduler.trigger("startup")
    expect(h.pendingDelays()).toEqual([30_000])
    h.env.autoRefresh = false
    h.scheduler.reschedule()
    expect(h.timers.size).toBe(0)
    h.env.autoRefresh = true
    h.env.intervalMs = 300_000
    h.scheduler.reschedule()
    expect(h.pendingDelays()).toEqual([300_000])
})

test("reschedule during recovery keeps the backoff timer", async () => {
    const h = harness()
    h.outcomes.push(transient())
    await h.scheduler.trigger("startup")
    h.scheduler.reschedule()
    expect(h.pendingDelays()).toEqual([RECOVERY_DELAYS_MS[0]])
})

test("state reports the recovery attempt and the failure code", async () => {
    const h = harness()
    h.outcomes.push(transient("REQUEST_FAILED"))
    await h.scheduler.trigger("startup")
    expect(h.scheduler.state()).toMatchObject({
        phase: "recovering",
        attempt: 1,
        maxAttempts: RECOVERY_DELAYS_MS.length,
        lastFailure: { code: "REQUEST_FAILED" },
        nextAt: RECOVERY_DELAYS_MS[0],
    })
})

test("diagnosis separates host timeout, service startup, data request and permanent states", () => {
    expect(diagnoseFailure({ code: "HOST_TIMEOUT", elapsedMs: 20_000, serviceStatus: "starting" }).kind).toBe("service-start")
    expect(diagnoseFailure({ code: "HOST_TIMEOUT", elapsedMs: 20_000, serviceStatus: "ready" }).kind).toBe("data-request")
    expect(diagnoseFailure({ code: "HOST_TIMEOUT", elapsedMs: 20_000, serviceStatus: null }).kind).toBe("host-timeout")
    expect(diagnoseFailure({ code: "SERVICE_FAILED", elapsedMs: 15_000, serviceStatus: "failed" }).kind).toBe("service-start")
    expect(diagnoseFailure({ code: "REQUEST_FAILED", elapsedMs: 20_000, serviceStatus: "ready" }).kind).toBe("data-request")
    expect(diagnoseFailure({ code: null, httpStatus: 500, elapsedMs: 40, serviceStatus: "ready" }).kind).toBe("service-error")
    expect(diagnoseFailure({ code: "NO_SERVICE", elapsedMs: 3, serviceStatus: "stopped" }).kind).toBe("permission")
    expect(diagnoseFailure({ code: "NOT_GRANTED", elapsedMs: 3, serviceStatus: null }).kind).toBe("permission")
    expect(diagnoseFailure({ code: "DISABLED", elapsedMs: 3, serviceStatus: null }).kind).toBe("disabled")
    expect(diagnoseFailure({ code: "HOST_TIMEOUT", elapsedMs: 20_000, serviceStatus: "ready" }).summary).toMatch(/20 s/)
})

// ------------------------------------------------- R2: eligibility at dequeue and arm time

for (const queued of ["lifecycle", "auto", "visible", "retry"] as const) {
    test(`a ${queued} request queued behind a request that halts never runs`, async () => {
        const h = harness()
        const release = h.hold()
        const first = h.scheduler.trigger("startup")
        await h.flush()
        void h.scheduler.trigger(queued)
        release({ kind: "failed", code: "NO_SERVICE" })
        await first
        expect(h.runs.map((r) => r.source)).toEqual(["startup"])
        expect(h.scheduler.state().phase).toBe("halted")
        expect(h.timers.size).toBe(0)
    })
}

test("a user request queued behind a request that halts still runs", async () => {
    const h = harness()
    const release = h.hold()
    const first = h.scheduler.trigger("startup")
    await h.flush()
    void h.scheduler.trigger("user", { manual: true })
    release({ kind: "failed", code: "NO_SERVICE" })
    await first
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "user"])
    expect(h.runs[1]!.manual).toBe(true)
    expect(h.maxInFlight).toBe(1)
})

test("hidden while a request runs: the queued automatic request does not run and no timer is armed", async () => {
    const h = harness()
    const release = h.hold()
    const first = h.scheduler.trigger("startup")
    await h.flush()
    void h.scheduler.trigger("lifecycle")
    h.env.visible = false
    h.scheduler.visibilityChanged()
    release({ kind: "ok" })
    await first
    expect(h.runs.map((r) => r.source)).toEqual(["startup"])
    expect(h.runs.some((r) => !r.visible)).toBe(false)
    expect(h.timers.size).toBe(0)
    await h.advance(600_000)
    expect(h.runs).toHaveLength(1)
    // showing the frame refreshes once and restores the saved cadence
    h.env.visible = true
    h.scheduler.visibilityChanged()
    await h.flush()
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "visible"])
    expect(h.runs[1]!.visible).toBe(true)
    expect(h.pendingDelays()).toEqual([60_000])
    expect(h.maxInFlight).toBe(1)
})

test("auto-refresh off: a chat event missed while hidden is replayed once on show", async () => {
    const h = harness({ autoRefresh: false })
    await h.scheduler.trigger("startup")
    h.env.visible = false
    h.scheduler.visibilityChanged()
    await h.scheduler.trigger("lifecycle")
    await h.scheduler.trigger("lifecycle")
    expect(h.runs).toHaveLength(1)
    h.env.visible = true
    h.scheduler.visibilityChanged()
    await h.flush()
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "visible"])
    expect(h.timers.size).toBe(0)
    // nothing left to replay
    h.env.visible = false
    h.scheduler.visibilityChanged()
    h.env.visible = true
    h.scheduler.visibilityChanged()
    await h.flush()
    expect(h.runs).toHaveLength(2)
})

test("auto-refresh off: showing the frame without a missed event sends nothing", async () => {
    const h = harness({ autoRefresh: false })
    await h.scheduler.trigger("startup")
    h.env.visible = false
    h.scheduler.visibilityChanged()
    h.env.visible = true
    h.scheduler.visibilityChanged()
    await h.flush()
    expect(h.runs).toHaveLength(1)
})

test("explicit navigation queued while the frame hides still runs, and nothing automatic follows", async () => {
    const h = harness()
    const release = h.hold()
    const first = h.scheduler.trigger("startup")
    await h.flush()
    const nav = h.scheduler.trigger("user")
    h.env.visible = false
    h.scheduler.visibilityChanged()
    release({ kind: "superseded" })
    await Promise.all([first, nav])
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "user"])
    expect(h.timers.size).toBe(0)
})

test("a superseded automatic request is not re-run once the frame is hidden", async () => {
    const h = harness({ intervalMs: 5_000 })
    await h.scheduler.trigger("startup")
    const release = h.hold()
    await h.advance(5_000)
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "auto"])
    h.env.visible = false
    h.scheduler.visibilityChanged()
    release({ kind: "superseded" })
    await h.flush()
    expect(h.runs).toHaveLength(2)
    expect(h.timers.size).toBe(0)
    h.env.visible = true
    h.scheduler.visibilityChanged()
    await h.flush()
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "auto", "visible"])
})

test("a lifecycle event while hidden and idle does not request at once", async () => {
    const h = harness()
    await h.scheduler.trigger("startup")
    h.env.visible = false
    h.scheduler.visibilityChanged()
    await h.scheduler.trigger("lifecycle")
    expect(h.runs).toHaveLength(1)
    expect(h.timers.size).toBe(0)
})

test("hidden when a transient failure settles: no retry timer while hidden; show resumes recovery", async () => {
    const h = harness()
    const release = h.hold()
    const first = h.scheduler.trigger("startup")
    await h.flush()
    h.env.visible = false
    h.scheduler.visibilityChanged()
    release(transient())
    await first
    expect(h.scheduler.state().phase).toBe("recovering")
    expect(h.timers.size).toBe(0)
    await h.advance(120_000)
    expect(h.runs).toHaveLength(1)
    h.env.visible = true
    h.scheduler.visibilityChanged()
    await h.flush()
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "visible"])
    expect(h.scheduler.state().phase).toBe("healthy")
})

test("settings view: a queued automatic request is dropped at dequeue, no timer runs under the form", async () => {
    const h = harness()
    const release = h.hold()
    const first = h.scheduler.trigger("user") // opening Settings loads /locations
    await h.flush()
    h.env.settingsView = true
    void h.scheduler.trigger("lifecycle")
    release({ kind: "ok" })
    await first
    expect(h.runs.map((r) => r.source)).toEqual(["user"])
    expect(h.runs.some((r) => r.settingsView)).toBe(false)
    expect(h.timers.size).toBe(0)
    // leaving Settings is a user refresh: it runs and the saved cadence comes back
    h.env.settingsView = false
    await h.scheduler.trigger("user", { manual: true })
    expect(h.runs.map((r) => r.source)).toEqual(["user", "user"])
    expect(h.pendingDelays()).toEqual([60_000])
})

test("settings view: explicit requests from the form still run", async () => {
    const h = harness()
    await h.scheduler.trigger("startup")
    h.env.settingsView = true
    await h.scheduler.trigger("user", { manual: true, rescan: true })
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "user"])
    expect(h.runs[1]!.rescan).toBe(true)
})

test("halted: a later show sends nothing; the next user action resumes and re-arms", async () => {
    const h = harness()
    h.outcomes.push({ kind: "failed", code: "DISABLED" })
    await h.scheduler.trigger("startup")
    h.env.visible = false
    h.scheduler.visibilityChanged()
    await h.scheduler.trigger("lifecycle")
    h.env.visible = true
    h.scheduler.visibilityChanged()
    await h.flush()
    expect(h.runs).toHaveLength(1)
    await h.scheduler.trigger("user", { manual: true })
    expect(h.runs).toHaveLength(2)
    expect(h.pendingDelays()).toEqual([60_000])
})

test("an automatic trigger that cannot run never cancels a pending recovery retry", async () => {
    const h = harness()
    h.outcomes.push(transient())
    await h.scheduler.trigger("startup")
    expect(h.pendingDelays()).toEqual([RECOVERY_DELAYS_MS[0]])
    h.env.settingsView = true // the form opened; no explicit request yet
    await h.scheduler.trigger("lifecycle")
    expect(h.runs).toHaveLength(1)
    expect(h.scheduler.state().nextAt).toBe(RECOVERY_DELAYS_MS[0])
    h.env.settingsView = false
    await h.advance(RECOVERY_DELAYS_MS[0])
    expect(h.runs.map((r) => r.source)).toEqual(["startup", "retry"])
})
