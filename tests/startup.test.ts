import { expect, test } from "bun:test"
import { formatRefreshedAt, initializeSurface } from "../panel/startup"

test("mounts feedback before a slow settings read completes", async () => {
    const steps: string[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const starting = initializeSurface({
        mount: () => { steps.push("visible") },
        loadSettings: () => pending,
        applySettings: () => { steps.push("settings applied") },
        startPolling: () => { steps.push("polling") },
        refresh: async () => { steps.push("stats") },
    })
    expect(steps).toEqual(["visible"])
    release()
    await starting
    expect(steps).toEqual(["visible", "settings applied", "polling", "stats"])
})

test("does not label an unfinished or failed refresh as successful", () => {
    expect(formatRefreshedAt(null)).toBe("Last refreshed: not yet")
})

test("refresh label includes a full local date and time, including seconds", () => {
    // ICU versions differ on the joiner ("28 Oct 2026, 12:34:56" vs "28 Oct 2026 at 12:34:56"),
    // so check the parts rather than one exact string
    const label = formatRefreshedAt(new Date(2026, 9, 28, 12, 34, 56).getTime(), "en-GB")
    expect(label.startsWith("Last refreshed: 28 Oct 2026")).toBe(true)
    expect(label.endsWith("12:34:56")).toBe(true)
})
