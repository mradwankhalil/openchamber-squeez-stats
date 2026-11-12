import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

// Exercise the production transport/render boundary without a browser dependency.
// Only host transport and DOM/widget operations are replaced, not refresh logic.
const source = readFileSync(new URL("../panel/main.ts", import.meta.url), "utf8")
const parsed = ts.createSourceFile("panel/main.ts", source, ts.ScriptTarget.Latest, true)
const names = new Set(["fetchCurrent", "failureFrom", "requestKey", "renderPanel"])
const found = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text))
if (found.length !== names.size) throw new Error(`Production panel functions not found: ${[...names].filter((n) => !found.some((f) => f.name?.text === n)).join(", ")}`)
const compiled = ts.transpileModule(found.map((node) => node.getText(parsed)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

type Request = { path: string; query: Record<string, string> }
type Element = { children: Element[]; scrollTop: number; appendChild: (node: Element) => void; replaceChildren: (...nodes: Element[]) => void }
type Answer = { status: number; body: string }
type Outcome = { kind: string; code?: string | null; httpStatus?: number }

function element(): Element {
    return {
        children: [], scrollTop: 0,
        appendChild(node) { this.children.push(node) },
        replaceChildren(...nodes) { this.children = nodes },
    }
}

class HostRequestError extends Error {
    constructor(readonly code: string, message: string) { super(message) }
}

const job = { manual: false, rescan: false, source: "user" }

function panel() {
    let request: Request = { path: "/overview", query: { start: "100" } }
    let answer: () => Promise<Answer> = async () => ({ status: 200, body: JSON.stringify({ meta: { available: true }, report: {} }) })
    const calls: { path: string; data: unknown }[] = []
    const recorded: unknown[] = []
    let recovered = 0
    const body = element()
    const clock = { textContent: "" }
    const context = {
        fetchSeq: 0, lastPayload: null, lastPayloadKey: "", lastRefreshedAt: null, lastRefreshedKey: "",
        notice: null as unknown, failure: null as unknown, lastRenderedKey: "", lastRequestKey: "", detailStart: null,
        surface: "panel", view: "overview", settings: { autoRefresh: false, refreshSeconds: 60 },
        refs: { body, lastRefreshed: clock, subtitle: { textContent: "" }, refresh: { update() {} } },
        host: { serviceRequest: () => answer() },
        HostRequestError,
        scheduler: { state: () => ({ phase: "failing" }) },
        currentRequest: () => request,
        loadSettings: async () => {},
        describeError: (error: unknown) => ({ tone: "error", title: error instanceof HostRequestError ? error.code : "Could not load stats" }),
        recordFailure: async (f: unknown) => { recorded.push(f) },
        noteRecovered: () => { recovered++ },
        renderNotice() {}, syncChrome() {}, refreshLabel: () => "1 minute",
        formatRefreshedAt: (at: number | null) => String(at),
        el: element, loadingFeedback: () => ({ ...element(), loading: true }),
        renderOverview: (_node: Element, data: unknown) => { calls.push({ path: "/overview", data }) },
        renderSessions: (_node: Element, data: unknown) => { calls.push({ path: "/sessions", data }) },
        renderSettings: (_node: Element, data: unknown) => { calls.push({ path: "/locations", data }) },
        render: () => api.renderPanel(false),
        Date, JSON,
    }
    const api = vm.runInNewContext(`${compiled}\n({ fetchCurrent, renderPanel })`, context) as {
        fetchCurrent: (job: unknown) => Promise<Outcome>
        renderPanel: (force: boolean) => void
    }
    return {
        api, body, calls, clock, context, recorded,
        get recovered() { return recovered },
        fetch: () => api.fetchCurrent(job),
        request(next: Request) {
            request = next
            context.view = next.path === "/locations" ? "settings" : next.path.slice(1)
            context.lastRenderedKey = ""
        },
        fail(status = 500) { answer = async () => ({ status, body: "{}" }) },
        throwCode(code: string) { answer = async () => { throw new HostRequestError(code, code) } },
        succeed() { answer = async () => ({ status: 200, body: JSON.stringify({ meta: { available: true }, report: {} }) }) },
        /** the next request stays open until released */
        hold() {
            let release!: (a: Answer | Error) => void
            answer = () => new Promise<Answer>((resolve, reject) => {
                release = (a) => (a instanceof Error ? reject(a) : resolve(a))
            })
            return (a: Answer | Error) => release(a)
        },
    }
}

test("Overview success then Sessions failure never renders Overview data as Sessions", async () => {
    const p = panel()
    await p.fetch()
    expect(p.calls.map((call) => call.path)).toEqual(["/overview"])
    p.request({ path: "/sessions", query: { start: "100" } })
    p.fail()
    await p.fetch()
    expect(p.calls.map((call) => call.path)).toEqual(["/overview"])
    expect(p.context.notice).not.toBeNull()
})

test("Overview success then locations failure never passes stats to Settings", async () => {
    const p = panel()
    await p.fetch()
    p.request({ path: "/locations", query: {} })
    p.fail()
    await p.fetch()
    expect(p.calls.map((call) => call.path)).toEqual(["/overview"])
})

test("same-request failure retains rendered stats and successful refresh timestamp", async () => {
    const p = panel()
    await p.fetch()
    const node = p.body.children[0]
    const timestamp = p.clock.textContent
    expect(timestamp).not.toBe("null")
    p.body.scrollTop = 240
    p.fail()
    await p.fetch()
    expect(p.body.children[0]).toBe(node)
    expect(p.body.scrollTop).toBe(240)
    expect(p.clock.textContent).toBe(timestamp)
    expect(p.calls).toHaveLength(1)
})

test("range or file-location changes cannot display stats for the prior request", async () => {
    const queries: Record<string, string>[] = [{ start: "200" }, { start: "100", home: "/different/squeez" }]
    for (const query of queries) {
        const p = panel()
        await p.fetch()
        p.request({ path: "/overview", query })
        p.fail()
        await p.fetch()
        expect(p.calls).toHaveLength(1)
    }
})

test("render during a view transition cannot dispatch the previous payload", async () => {
    const p = panel()
    await p.fetch()
    p.request({ path: "/sessions", query: { start: "100" } })
    p.api.renderPanel(true)
    expect(p.calls.map((call) => call.path)).toEqual(["/overview"])
})

test("a failed request for another view shows no successful refresh time", async () => {
    const p = panel()
    await p.fetch()
    p.request({ path: "/sessions", query: { start: "100" } })
    p.fail()
    await p.fetch()
    expect(p.clock.textContent).toBe("null")
    // the Overview answer keeps its own time for when the user returns
    expect(p.context.lastRefreshedAt).not.toBeNull()
})

test("a late answer after navigation is superseded and changes nothing", async () => {
    const p = panel()
    const release = p.hold()
    const running = p.fetch()
    p.request({ path: "/sessions", query: { start: "100" } })
    release({ status: 200, body: JSON.stringify({ meta: { available: true }, rows: [] }) })
    expect(await running).toEqual({ kind: "superseded" })
    expect(p.context.lastPayloadKey).toBe("")
    expect(p.context.lastRefreshedAt).toBeNull()
    expect(p.calls).toHaveLength(0)
})

test("a late failure after a settings or path change raises no notice and records nothing", async () => {
    const p = panel()
    await p.fetch()
    const release = p.hold()
    const running = p.fetch()
    p.request({ path: "/overview", query: { start: "100", home: "/elsewhere" } })
    release(new HostRequestError("HOST_TIMEOUT", "timeout"))
    expect(await running).toEqual({ kind: "superseded" })
    expect(p.context.notice).toBeNull()
    expect(p.context.failure).toBeNull()
    expect(p.recorded).toHaveLength(0)
})

test("host error codes and HTTP statuses reach the scheduler and the diagnostics", async () => {
    const p = panel()
    p.throwCode("SERVICE_FAILED")
    expect(await p.fetch()).toEqual({ kind: "failed", code: "SERVICE_FAILED" })
    p.fail(503)
    expect(await p.fetch()).toEqual({ kind: "failed", code: null, httpStatus: 503 })
    expect(p.recorded).toHaveLength(2)
    expect(p.recorded[0]).toMatchObject({ code: "SERVICE_FAILED", path: "/overview" })
    expect(p.recorded[1]).toMatchObject({ code: null, httpStatus: 503 })
    expect((p.recorded[0] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0)
})

test("success after failure clears the failure and closes the diagnostics episode", async () => {
    const p = panel()
    p.throwCode("HOST_TIMEOUT")
    await p.fetch()
    expect(p.context.failure).not.toBeNull()
    p.succeed()
    expect(await p.fetch()).toEqual({ kind: "ok" })
    expect(p.context.failure).toBeNull()
    expect(p.context.notice).toBeNull()
    expect(p.recovered).toBe(1)
})

test("with no stats yet, a failure that is not being retried replaces the loading message", async () => {
    const p = panel()
    p.api.renderPanel(true) // first paint, before any answer: loading feedback
    const loading = (p.body.children[0] as Element).children.some((c) => (c as Element & { loading?: boolean }).loading)
    expect(loading).toBe(true)
    p.throwCode("NO_SERVICE")
    await p.fetch()
    const content = p.body.children[0] as Element
    expect(content.children.some((c) => (c as Element & { loading?: boolean }).loading)).toBe(false)
})
