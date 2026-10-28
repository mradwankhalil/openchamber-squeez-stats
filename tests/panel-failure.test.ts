import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

// Exercise the production transport/render boundary without a browser dependency.
// Only host transport and DOM/widget operations are replaced, not refresh logic.
const source = readFileSync(new URL("../panel/main.ts", import.meta.url), "utf8")
const parsed = ts.createSourceFile("panel/main.ts", source, ts.ScriptTarget.Latest, true)
const names = new Set(["refresh", "renderPanel"])
const functions = parsed.statements
    .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
    .map((node) => node.getText(parsed))
    .join("\n")
if (functions.length === 0) throw new Error("Production panel functions not found")
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

type Request = { path: string; query: Record<string, string> }
type Element = { children: Element[]; scrollTop: number; appendChild: (node: Element) => void; replaceChildren: (...nodes: Element[]) => void }

function element(): Element {
    return {
        children: [], scrollTop: 0,
        appendChild(node) { this.children.push(node) },
        replaceChildren(...nodes) { this.children = nodes },
    }
}

function panel() {
    let request: Request = { path: "/overview", query: { start: "100" } }
    let response = { status: 200, body: JSON.stringify({ meta: { available: true }, report: {} }) }
    const calls: { path: string; data: unknown }[] = []
    const body = element()
    const clock = { textContent: "" }
    const context = {
        fetchSeq: 0, lastPayload: null, lastPayloadKey: "", lastRefreshedAt: null,
        notice: null, lastRenderedKey: "", lastRequestKey: "", detailStart: null,
        view: "overview", settings: { autoRefresh: false, refreshSeconds: 60 },
        refs: { body, lastRefreshed: clock, subtitle: { textContent: "" }, refresh: { update() {} } },
        host: { serviceRequest: async () => response },
        currentRequest: () => request,
        describeError: () => ({ title: "Service unavailable" }),
        renderNotice() {}, syncChrome() {}, refreshLabel: () => "1 minute",
        formatRefreshedAt: (at: number | null) => String(at),
        el: element, loadingFeedback: element,
        renderOverview: (_node: Element, data: unknown) => { calls.push({ path: "/overview", data }) },
        renderSessions: (_node: Element, data: unknown) => { calls.push({ path: "/sessions", data }) },
        renderSettings: (_node: Element, data: unknown) => { calls.push({ path: "/locations", data }) },
        render: () => api.renderPanel(false),
    }
    const api = vm.runInNewContext(`${compiled}\n({ refresh, renderPanel })`, context) as {
        refresh: () => Promise<void>
        renderPanel: (force: boolean) => void
    }
    return {
        api, body, calls, clock, context,
        request(next: Request) {
            request = next
            context.view = next.path === "/locations" ? "settings" : next.path.slice(1)
            context.lastRenderedKey = ""
        },
        fail() { response = { status: 500, body: "{}" } },
    }
}

test("Overview success then Sessions failure never renders Overview data as Sessions", async () => {
    const p = panel()
    await p.api.refresh()
    expect(p.calls.map((call) => call.path)).toEqual(["/overview"])
    p.request({ path: "/sessions", query: { start: "100" } })
    p.fail()
    await p.api.refresh()
    expect(p.calls.map((call) => call.path)).toEqual(["/overview"])
    expect(p.context.notice).not.toBeNull()
})

test("Overview success then locations failure never passes stats to Settings", async () => {
    const p = panel()
    await p.api.refresh()
    p.request({ path: "/locations", query: {} })
    p.fail()
    await p.api.refresh()
    expect(p.calls.map((call) => call.path)).toEqual(["/overview"])
})

test("same-request failure retains rendered stats and successful refresh timestamp", async () => {
    const p = panel()
    await p.api.refresh()
    const node = p.body.children[0]
    const timestamp = p.clock.textContent
    p.body.scrollTop = 240
    p.fail()
    await p.api.refresh()
    expect(p.body.children[0]).toBe(node)
    expect(p.body.scrollTop).toBe(240)
    expect(p.clock.textContent).toBe(timestamp)
    expect(p.calls).toHaveLength(1)
})

test("range or file-location changes cannot display stats for the prior request", async () => {
    const queries: Record<string, string>[] = [{ start: "200" }, { start: "100", home: "/different/squeez" }]
    for (const query of queries) {
        const p = panel()
        await p.api.refresh()
        p.request({ path: "/overview", query })
        p.fail()
        await p.api.refresh()
        expect(p.calls).toHaveLength(1)
    }
})

test("render during a view transition cannot dispatch the previous payload", async () => {
    const p = panel()
    await p.api.refresh()
    p.request({ path: "/sessions", query: { start: "100" } })
    p.api.renderPanel(true)
    expect(p.calls.map((call) => call.path)).toEqual(["/overview"])
})
