import { describe, expect, test } from "bun:test"
import { bumpVersion, compareVersions, isShipped, shippedManifest } from "../scripts/lib.mjs"

describe("versions", () => {
    test("bumps", () => {
        expect(bumpVersion("0.3.0", "patch")).toBe("0.3.1")
        expect(bumpVersion("0.3.4", "minor")).toBe("0.4.0")
        expect(bumpVersion("0.3.4", "major")).toBe("1.0.0")
        expect(bumpVersion("0.3.4", "0.10.0")).toBe("0.10.0")
    })

    test("refuses a version that is not higher, or nonsense", () => {
        expect(() => bumpVersion("0.3.4", "0.3.4")).toThrow()
        expect(() => bumpVersion("0.3.4", "0.2.9")).toThrow()
        expect(() => bumpVersion("0.3.4", "huge")).toThrow()
    })

    test("compares numerically", () => {
        expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0)
        expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
        expect(compareVersions("0.3.0", "0.3.1")).toBeLessThan(0)
    })
})

describe("what reaches users", () => {
    test("bundles, page, styles and icon do; sources, tests, docs and tooling do not", () => {
        for (const f of ["panel/main.js", "panel/index.html", "panel/panel.css", "service/main.js", "icon.svg"]) expect(isShipped(f)).toBe(true)
        for (const f of ["panel/main.ts", "service/store.ts", "tests/report.test.ts", "README.md", "scripts/smoke.mjs", ".github/workflows/ci.yml", "LICENSE"])
            expect(isShipped(f)).toBe(false)
    })

    test("package.json counts only for its manifest and runtime dependencies", () => {
        const base = { version: "1.0.0", openchamber: { apiVersion: 1 }, dependencies: { a: "1" }, scripts: { x: "y" } }
        expect(shippedManifest(base)).toBe(shippedManifest({ ...base, version: "2.0.0", scripts: {}, devDependencies: { b: "1" } }))
        expect(shippedManifest(base)).not.toBe(shippedManifest({ ...base, openchamber: { apiVersion: 2 } }))
        expect(shippedManifest(base)).not.toBe(shippedManifest({ ...base, dependencies: { a: "2" } }))
    })
})
