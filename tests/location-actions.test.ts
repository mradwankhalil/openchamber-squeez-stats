import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../panel/main.ts", import.meta.url), "utf8")
const parsed = ts.createSourceFile("panel/main.ts", source, ts.ScriptTarget.Latest, true)
const names = new Set(["serviceQuery", "currentRequest", "applySettingsChange", "checkDraftLocations", "renderLocationSettings", "renderPanel", "refresh"])
const declarations = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
if (declarations.length !== names.size) throw new Error("Production location functions not found")
const compiled = ts.transpileModule(declarations.map((node) => node.getText(parsed)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

type Node = { children: Node[]; scrollTop: number; dataset: Record<string, string>; append: (...nodes: Node[]) => void; appendChild: (node: Node) => void; replaceChildren: (...nodes: Node[]) => void }
type Button = { label: string; onClick: () => void }
function element(): Node {
    return {
        children: [], scrollTop: 0, dataset: {},
        append(...nodes) { this.children.push(...nodes) },
        appendChild(node) { this.children.push(node) },
        replaceChildren(...nodes) { this.children = nodes },
    }
}

function locations(home: string) {
    const buttons: Button[] = []
    const paths = { home, sessions: "", summaries: "", blobs: "", config: "" }
    const saved = {
        paths: { home: home || "/automatic" }, pathSource: home ? "settings" : "auto",
        checks: [{ id: "home", path: home || "/automatic", exists: true, required: true }],
        candidates: [{ path: "/other-squeez", hasSessions: true, logFiles: 1, lastLog: null, source: "default" }],
    }
    const renderedHomes: string[] = []
    const renderedChecks: string[] = []
    const requests: Record<string, string>[] = []
    const pending: { result: { status: number; body: string }; resolve: (result: { status: number; body: string }) => void }[] = []
    let hold = false
    let saves = 0
    let loading = 0
    let status = 200
    const context = {
        PATH_KEYS: Object.keys(paths), PATH_FIELDS: [], surface: "panel", view: "settings", detailStart: null,
        settings: { paths, limits: {}, autoRefresh: true, refreshSeconds: 60 }, draftPaths: { ...paths }, draftLocations: null,
        settingsProblem: null, lastRenderedKey: "", lastRequestKey: "", lastPayload: saved,
        lastPayloadKey: "", lastRefreshedAt: 123, notice: null, fetchSeq: 0, draftCheckSeq: 0,
        refs: { body: element(), subtitle: { textContent: "" }, lastRefreshed: { textContent: "" }, refresh: { update() {} } },
        saveSettings: async () => { saves++ }, schedulePoll() {}, describeError: () => ({ title: "Service unavailable" }),
        host: { serviceRequest: async (request: { query: Record<string, string> }) => {
            requests.push(request.query)
            const resolved = request.query.home || "/automatic"
            const result = { status, body: JSON.stringify({ ...saved, paths: { home: resolved }, checks: [{ id: "home", path: resolved, exists: true, required: true }] }) }
            if (hold) return new Promise<{ status: number; body: string }>((resolve) => { pending.push({ result, resolve }) })
            return result
        } },
        el: (_tag: string, className?: string, text?: string) => {
            if (className === "sq-check-path sq-mono" && text) renderedChecks.push(text)
            return element()
        },
        section: () => ({ root: element(), body: element() }), settingRow: element, note: element,
        mountTextField: () => ({ update() {} }), mountButton: (_node: Node, options: Button) => { buttons.push(options) },
        plural: () => "", formatAgo: () => "", renderNotice() {}, syncChrome() {}, formatRefreshedAt: () => "", refreshLabel: () => "",
        loadingFeedback: () => { loading++; return element() },
        renderSettings: (node: Node, data: { paths: { home: string } }) => {
            renderedHomes.push(data.paths.home)
            api.renderLocationSettings(node, data)
        },
        render: () => api.renderPanel(false),
    }
    const api = vm.runInNewContext(`${compiled}\n({ currentRequest, renderPanel, renderLocationSettings })`, context) as {
        currentRequest: () => { path: string; query: Record<string, string> }
        renderPanel: (force: boolean) => void
        renderLocationSettings: (node: Node, data: unknown) => void
    }
    const initial = api.currentRequest()
    context.lastPayloadKey = `${initial.path}?${JSON.stringify(initial.query)}`
    api.renderPanel(true)
    return {
        context, requests, renderedHomes, renderedChecks, loading: () => loading, saves: () => saves,
        fail() { status = 500 },
        hold() { hold = true },
        async release(index: number, responseStatus?: number) {
            const request = pending[index]
            if (!request) throw new Error(`Missing pending request: ${index}`)
            request.resolve({ ...request.result, status: responseStatus ?? request.result.status })
            await new Promise<void>((resolve) => setImmediate(resolve))
        },
        async click(label: string) {
            const button = buttons.find((candidate) => candidate.label === label)
            if (!button) throw new Error(`Missing production button: ${label}`)
            button.onClick()
            await new Promise<void>((resolve) => setImmediate(resolve))
        },
    }
}

test("Use this refreshes saved locations and leaves Settings visible", async () => {
    const p = locations("")
    await p.click("Use this")
    expect(p.renderedHomes).toEqual(["/automatic", "/other-squeez"])
    expect(p.loading()).toBe(0)
    expect(p.requests[0]?.home).toBe("/other-squeez")
    expect(p.saves()).toBe(1)
    expect(p.context.lastRefreshedAt).toBe(123)
})

test("Find automatically rescans saved locations without leaving Settings loading", async () => {
    const p = locations("/custom-squeez")
    await p.click("Find automatically")
    expect(p.renderedHomes).toEqual(["/custom-squeez", "/automatic"])
    expect(p.loading()).toBe(0)
    expect(p.requests[0]?.rescan).toBe("1")
    expect(p.context.settings.paths.home).toBe("")
    expect(p.saves()).toBe(1)
    expect(p.context.lastRefreshedAt).toBe(123)
})

test("Save locations renders the newly saved paths", async () => {
    const p = locations("/custom-squeez")
    p.context.draftPaths.home = "/typed-squeez"
    await p.click("Save locations")
    expect(p.renderedHomes).toEqual(["/custom-squeez", "/typed-squeez"])
    expect(p.loading()).toBe(0)
})

test("Check previews a draft without saving it or changing the saved payload key", async () => {
    const p = locations("/custom-squeez")
    const savedKey = p.context.lastPayloadKey
    p.context.draftPaths.home = "/unsaved-squeez"
    await p.click("Check")
    expect(p.requests[0]?.home).toBe("/unsaved-squeez")
    expect(p.context.settings.paths.home).toBe("/custom-squeez")
    expect(p.context.lastPayloadKey).toBe(savedKey)
    expect(p.context.draftLocations).not.toBeNull()
    expect(p.saves()).toBe(0)
    expect(p.loading()).toBe(0)
})

test("failed saved-location selection reports the error, never displays old paths as new", async () => {
    const p = locations("")
    p.fail()
    await p.click("Use this")
    expect(p.renderedHomes).toEqual(["/automatic"])
    expect(p.context.notice).not.toBeNull()
    expect(p.context.lastRefreshedAt).toBe(123)
})

test("Check finishing after Use this cannot restore obsolete draft checks", async () => {
    const p = locations("/custom-squeez")
    p.hold()
    p.context.draftPaths.home = "/obsolete-draft"
    await p.click("Check")
    await p.click("Use this")
    await p.release(1)
    expect(p.renderedChecks).toContain("/other-squeez")
    await p.release(0)
    expect(p.context.draftLocations).toBeNull()
    expect(p.renderedChecks).not.toContain("/obsolete-draft")
    expect(p.context.settings.paths.home).toBe("/other-squeez")
})

test("editing a draft invalidates its pending Check response", async () => {
    const p = locations("/custom-squeez")
    p.hold()
    p.context.draftPaths.home = "/old-draft"
    await p.click("Check")
    p.context.draftPaths.home = "/new-draft"
    await p.release(0)
    expect(p.context.draftLocations).toBeNull()
    expect(p.renderedChecks).not.toContain("/old-draft")
})

test("an older Check failure cannot overwrite a newer successful Check", async () => {
    const p = locations("/custom-squeez")
    p.hold()
    await p.click("Check")
    await p.click("Check")
    await p.release(1)
    expect(p.context.draftLocations).not.toBeNull()
    await p.release(0, 500)
    expect(p.context.notice).toBeNull()
})
