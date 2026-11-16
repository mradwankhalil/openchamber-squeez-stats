import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

// The failure banner's wording, from the production functions in panel/main.ts.
const source = readFileSync(new URL("../panel/main.ts", import.meta.url), "utf8")
const parsed = ts.createSourceFile("panel/main.ts", source, ts.ScriptTarget.Latest, true)
const names = new Set(["displayNotice", "refreshLabel", "formatStamp"])
const found = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text))
if (found.length !== names.size) throw new Error(`Production panel functions not found: ${[...names].filter((n) => !found.some((f) => f.name?.text === n)).join(", ")}`)
const compiled = ts.transpileModule(found.map((node) => node.getText(parsed)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

type Notice = { tone: string; title: string; body?: string }

function banner(state: { phase: string; attempt?: number; maxAttempts?: number; nextDelayMs: number | null }, refreshSeconds = 60): Notice | null {
    const notice: Notice = { tone: "error", title: "Stats service is not responding", body: "Retry, or restart OpenChamber if it keeps failing." }
    const context = {
        notice,
        failure: { notice, diagnosis: null },
        settings: { autoRefresh: true, refreshSeconds },
        scheduler: { state: () => ({ attempt: 0, maxAttempts: 4, ...state }) },
        requestKey: () => "k",
        currentRequest: () => ({}),
        lastPayloadKey: "", lastRefreshedKey: "", lastRefreshedAt: null,
        Date, Math,
    }
    const api = vm.runInNewContext(`${compiled}\n({ displayNotice })`, context) as { displayNotice: () => Notice | null }
    return api.displayNotice()
}

test("during steady retries the banner names the 15 s wait, not the saved interval", () => {
    const n = banner({ phase: "failing", nextDelayMs: 15_000 })
    expect(n?.body).toContain("Next try in 15 seconds.")
    expect(n?.body).not.toContain("1 minute")
})

test("after the steady window the banner names the saved interval", () => {
    expect(banner({ phase: "failing", nextDelayMs: 60_000 })?.body).toContain("Next try in 1 minute.")
})

test("with nothing armed (auto-refresh off, hidden) the banner promises no next try", () => {
    expect(banner({ phase: "failing", nextDelayMs: null })?.body).not.toContain("Next try")
})

test("quick retries keep their attempt count", () => {
    expect(banner({ phase: "recovering", attempt: 2, nextDelayMs: 4_000 })?.body).toContain("attempt 2 of 4")
})
