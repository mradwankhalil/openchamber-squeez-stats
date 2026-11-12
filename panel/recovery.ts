/**
 * Refresh scheduling with a short, bounded recovery phase.
 *
 * Kept free of the DOM and the host bridge so it can be tested with a fake
 * clock. The rules:
 *  - at most one request in flight; triggers that arrive meanwhile coalesce
 *    into one follow-up request;
 *  - one timer; it is armed only when no request is in flight;
 *  - a transient failure (service starting, crashed, slow, HTTP 5xx) retries
 *    after RECOVERY_DELAYS_MS, then falls back to the user's normal interval;
 *  - a permanent failure (not approved, paused, bad request) is not retried
 *    until the user acts or the host re-sends ready;
 *  - hidden frames arm nothing; dispose cancels everything.
 *
 * The scheduler never restarts the service. A request after a crash lets the
 * host restart it, exactly like a click on Retry.
 */

/** Waits between recovery attempts. Sum stays far below one minute. */
export const RECOVERY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const

/**
 * Why a request is being made.
 * `startup` / `user` carry intent (opening the surface, a click, navigation),
 * `retry` is a recovery attempt, the rest are automatic.
 */
export type RefreshSource = "startup" | "user" | "retry" | "visible" | "lifecycle" | "auto"

export interface RefreshRequest {
    manual: boolean
    rescan: boolean
    source: RefreshSource
}

export type RunOutcome =
    | { kind: "ok" }
    | { kind: "failed"; code: string | null; httpStatus?: number }
    /** the view, range, locations or settings changed while it ran; its answer was dropped */
    | { kind: "superseded" }

export type RecoveryPhase = "idle" | "healthy" | "recovering" | "failing" | "halted"

export interface RecoveryState {
    phase: RecoveryPhase
    /** failed attempts in the current episode; 0 when healthy */
    attempt: number
    maxAttempts: number
    /** when the armed timer fires (scheduler clock), or null */
    nextAt: number | null
    lastFailure: { code: string | null; httpStatus?: number } | null
}

export interface SchedulerOptions {
    run: (request: RefreshRequest) => Promise<RunOutcome>
    autoRefresh: () => boolean
    intervalMs: () => number
    isVisible: () => boolean
    /** visible and not in a view where background repaints are unwelcome */
    canRunAutomatically: () => boolean
    setTimer: (fn: () => void, ms: number) => unknown
    clearTimer: (handle: unknown) => void
    now: () => number
    onChange?: (state: RecoveryState) => void
    delaysMs?: readonly number[]
}

export interface RefreshScheduler {
    /** Request a refresh now. Resolves when no request is in flight or queued. */
    trigger: (source: RefreshSource, options?: { manual?: boolean; rescan?: boolean }) => Promise<void>
    /** Settings changed: re-arm the normal timer (keeps a running recovery). */
    reschedule: () => void
    /** Call on every `visibilitychange`. */
    visibilityChanged: () => void
    dispose: () => void
    state: () => RecoveryState
}

const PERMANENT_CODES = new Set([
    "NO_SERVICE",
    "NOT_GRANTED",
    "DISABLED",
    "HOST_UNAVAILABLE",
    "HOST_REJECTED",
    "BAD_PATH",
    "RESPONSE_TOO_LARGE",
])

/** Failures a retry cannot fix without the user doing something. */
export function isPermanentFailure(code: string | null, httpStatus?: number): boolean {
    if (code && PERMANENT_CODES.has(code)) return true
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) return httpStatus !== 408 && httpStatus !== 429
    return false
}

/** Sources that may lift a permanent stop: explicit intent or a fresh host ready. */
const RESUMING_SOURCES = new Set<RefreshSource>(["startup", "user"])
const SOURCE_RANK: Record<RefreshSource, number> = { user: 5, startup: 4, retry: 3, visible: 2, lifecycle: 1, auto: 0 }
const MAX_SUPERSEDED_IN_A_ROW = 3

export function createRefreshScheduler(options: SchedulerOptions): RefreshScheduler {
    const delays = options.delaysMs ?? RECOVERY_DELAYS_MS
    let phase: RecoveryPhase = "idle"
    let attempt = 0
    /** may this failure episode schedule fast retries? */
    let episodeAllowed = false
    let lastFailure: RecoveryState["lastFailure"] = null
    let timer: unknown = null
    let timerAt: number | null = null
    let pending: RefreshRequest | null = null
    let running = false
    let drain: Promise<void> = Promise.resolve()
    let disposed = false

    const state = (): RecoveryState => ({ phase, attempt, maxAttempts: delays.length, nextAt: timerAt, lastFailure })
    const changed = () => options.onChange?.(state())

    function clearTimer(): void {
        if (timer !== null) options.clearTimer(timer)
        timer = null
        timerAt = null
    }

    function arm(ms: number, source: "retry" | "auto"): void {
        clearTimer()
        if (disposed) return
        timerAt = options.now() + ms
        timer = options.setTimer(() => {
            timer = null
            timerAt = null
            if (disposed || !options.isVisible()) return // visibilityChanged resumes
            if (!options.canRunAutomatically()) {
                armNormal()
                return
            }
            void trigger(source)
        }, ms)
    }

    function armNormal(): void {
        if (options.autoRefresh()) arm(options.intervalMs(), "auto")
        else clearTimer()
    }

    function settle(request: RefreshRequest, outcome: Exclude<RunOutcome, { kind: "superseded" }>): void {
        if (outcome.kind === "ok") {
            phase = "healthy"
            attempt = 0
            episodeAllowed = false
            lastFailure = null
            armNormal()
            return
        }
        lastFailure = outcome.httpStatus === undefined ? { code: outcome.code } : { code: outcome.code, httpStatus: outcome.httpStatus }
        if (isPermanentFailure(outcome.code, outcome.httpStatus)) {
            phase = "halted"
            attempt = 0
            episodeAllowed = false
            clearTimer()
            return
        }
        const intent = request.source === "startup" || request.source === "user"
        // A click or a fresh start begins a new bounded episode; automatic retries never do.
        if (attempt === 0 || (intent && phase !== "recovering")) {
            attempt = 0
            episodeAllowed = options.autoRefresh() || intent
        }
        attempt++
        if (episodeAllowed && attempt <= delays.length) {
            phase = "recovering"
            arm(delays[attempt - 1]!, "retry")
        } else {
            phase = "failing"
            armNormal()
        }
    }

    async function loop(): Promise<void> {
        let superseded = 0
        try {
            while (pending && !disposed) {
                const request = pending
                pending = null
                let outcome: RunOutcome
                try {
                    outcome = await options.run(request)
                } catch {
                    outcome = { kind: "failed", code: null }
                }
                if (disposed) return
                if (outcome.kind === "superseded") {
                    if (++superseded <= MAX_SUPERSEDED_IN_A_ROW) {
                        pending ??= { manual: request.manual, rescan: request.rescan, source: request.source }
                        continue
                    }
                    if (!pending) armNormal()
                    continue
                }
                superseded = 0
                settle(request, outcome)
                changed()
            }
        } finally {
            running = false
        }
    }

    function trigger(source: RefreshSource, extra: { manual?: boolean; rescan?: boolean } = {}): Promise<void> {
        if (disposed) return Promise.resolve()
        if (phase === "halted" && !RESUMING_SOURCES.has(source)) return running ? drain : Promise.resolve()
        const request: RefreshRequest = { manual: !!extra.manual, rescan: !!extra.rescan, source }
        pending = pending
            ? {
                  manual: pending.manual || request.manual,
                  rescan: pending.rescan || request.rescan,
                  source: SOURCE_RANK[request.source] > SOURCE_RANK[pending.source] ? request.source : pending.source,
              }
            : request
        // the request about to run replaces whatever the timer would have done
        clearTimer()
        if (!running) {
            running = true
            drain = loop()
        }
        return drain
    }

    return {
        trigger,
        reschedule() {
            if (disposed || running || phase === "halted") return
            if (phase === "recovering" && timer !== null) return
            armNormal()
        },
        visibilityChanged() {
            if (disposed) return
            if (!options.isVisible()) {
                clearTimer()
                changed()
                return
            }
            if (phase === "halted" || !options.canRunAutomatically()) return
            if (options.autoRefresh() || phase === "recovering") void trigger("visible")
        },
        dispose() {
            disposed = true
            pending = null
            clearTimer()
        },
        state,
    }
}

// ----------------------------------------------------------------- diagnosis

export type FailureKind =
    | "permission"
    | "disabled"
    | "service-start"
    | "data-request"
    | "host-timeout"
    | "service-error"
    | "host"
    | "unknown"

export interface FailureFacts {
    code: string | null
    httpStatus?: number
    /** how long the failed request took */
    elapsedMs: number
    /** `host.serviceStatus()` right after the failure, or null when it was not available */
    serviceStatus: string | null
}

/**
 * Name the failure precisely enough to tell a slow host message, a service
 * that never started, a slow data request and a permanent refusal apart.
 */
export function diagnoseFailure(facts: FailureFacts): { kind: FailureKind; summary: string } {
    const after = `after ${Math.max(0, Math.round(facts.elapsedMs / 1000))} s`
    const status = facts.serviceStatus ? ` Service status: ${facts.serviceStatus}.` : ""
    switch (facts.code) {
        case "NO_SERVICE":
        case "NOT_GRANTED":
            return { kind: "permission", summary: `The local service is not approved or not running (${facts.code}).${status}` }
        case "DISABLED":
            return { kind: "disabled", summary: "The extension is paused in Settings → Extensions." }
        case "SERVICE_FAILED":
            return { kind: "service-start", summary: `The stats service crashed or never became ready, ${after}.${status}` }
        case "HOST_TIMEOUT":
            if (facts.serviceStatus === "starting" || facts.serviceStatus === "failed" || facts.serviceStatus === "stopped")
                return { kind: "service-start", summary: `No answer ${after} while the service was not ready.${status}` }
            if (facts.serviceStatus === "ready")
                return { kind: "data-request", summary: `The service was running but this request got no answer ${after}.${status}` }
            return { kind: "host-timeout", summary: `OpenChamber did not answer ${after}; the service state is unknown.` }
        case "REQUEST_FAILED":
            return { kind: "data-request", summary: `The request reached the service but got no usable answer ${after}.${status}` }
        case "HOST_UNAVAILABLE":
        case "HOST_REJECTED":
        case "BAD_PATH":
        case "RESPONSE_TOO_LARGE":
            return { kind: "host", summary: `OpenChamber refused the request (${facts.code}).` }
    }
    if (facts.httpStatus !== undefined) return { kind: "service-error", summary: `The service answered HTTP ${facts.httpStatus} ${after}.${status}` }
    return { kind: "unknown", summary: `The request failed ${after}${facts.code ? ` (${facts.code})` : ""}.${status}` }
}
