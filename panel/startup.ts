/** Startup ordering is kept separate from the host transport and DOM. */
export interface SurfaceStartup {
    mount: () => void
    loadSettings: () => Promise<void>
    applySettings: () => void
    startPolling: () => void
    refresh: () => Promise<void>
}

export async function initializeSurface(startup: SurfaceStartup): Promise<void> {
    startup.mount()
    await startup.loadSettings()
    startup.applySettings()
    startup.startPolling()
    await startup.refresh()
}

export function formatRefreshedAt(at: number | null, locale?: string): string {
    return at === null
        ? "Last refreshed: not yet"
        : `Last refreshed: ${new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" })}`
}
