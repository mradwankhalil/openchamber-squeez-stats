/**
 * Squeez Stats — OpenChamber extension panel.
 *
 * One page serves two surfaces:
 *  - `panel`: the rail side panel, four views (Overview, Sessions, Now, Storage)
 *    and Settings.
 *  - `status`: one line in the chat's Work Status panel (today's numbers).
 *
 * Settings live in the extension's host storage (`host.storage`, key
 * "settings"), so both surfaces read the same values. Nothing about this
 * machine is built in: squeez's folder is discovered by the service, and the
 * user can point every file somewhere else.
 *
 * The page is a thin view: the local service reads squeez's files and returns
 * finished numbers. Every section carries one sentence saying what it counts.
 * Charts are plain HTML/SVG, no dependencies.
 */

import { connectHost, HostRequestError } from "@openchamber/sdk"
import type { HostReadyContext } from "@openchamber/sdk"
import { applyHostReady, mountBanner, mountButton, mountSelect, mountSwitch, mountTabs, mountTextField } from "@openchamber/sdk/ui"
import type { BannerHandle, ButtonHandle, TabsHandle } from "@openchamber/sdk/ui"
import { DEFAULT_LIMITS, LIMIT_MAX, LIMIT_MIN } from "../service/report"
import { formatRefreshedAt, initializeSurface } from "./startup"
import type {
    CommandRow,
    CountRow,
    ListLimits,
    LocationsPayload,
    NowPayload,
    OverviewPayload,
    SeriesPoint,
    SessionDetailPayload,
    SessionRow,
    SessionsPayload,
    StatusPayload,
    StoragePayload,
    WindowReport,
} from "../service/report"

type View = "overview" | "sessions" | "now" | "storage" | "settings"
type Range = "today" | "7d" | "30d" | "all"
type Metric = "saved" | "commands" | "tools"

// ------------------------------------------------------------------ settings

type PathKey = "home" | "sessions" | "summaries" | "blobs" | "config"
type ListKey = keyof ListLimits

type Settings = {
    autoRefresh: boolean
    refreshSeconds: number
    defaultRange: Range
    showEmptySessions: boolean
    limits: ListLimits
    /** empty string = found automatically */
    paths: Record<PathKey, string>
}

const SETTINGS_KEY = "settings"
const PATH_KEYS: PathKey[] = ["home", "sessions", "summaries", "blobs", "config"]
const RANGES: Range[] = ["today", "7d", "30d", "all"]
const RANGE_LABELS: Record<Range, string> = { today: "Today", "7d": "7 days", "30d": "30 days", all: "All" }
const REFRESH_CHOICES = [15, 30, 60, 120, 300, 600, 1800]
const LIMIT_CHOICES = [3, 5, 8, 10, 12, 15, 20, 30, 50]

const PATH_FIELDS: { key: PathKey; label: string; help: string; kind: "folder" | "file" }[] = [
    { key: "home", label: "squeez folder", help: "Where squeez keeps its state. The other locations default to places inside it.", kind: "folder" },
    { key: "sessions", label: "Event logs folder", help: "Holds the hourly YYYY-MM-DD-HH.jsonl logs, current.json and context.json. Required.", kind: "folder" },
    { key: "summaries", label: "Session records file", help: "summaries.jsonl, one record per finished session.", kind: "file" },
    { key: "blobs", label: "Stashed outputs folder", help: "Oversized outputs squeez set aside.", kind: "folder" },
    { key: "config", label: "squeez config file", help: "config.ini.", kind: "file" },
]

const LIST_FIELDS: { key: ListKey; label: string; group: "Overview and sessions" | "Now" }[] = [
    { key: "topCommands", label: "Where the savings come from", group: "Overview and sessions" },
    { key: "weakCommands", label: "What squeez barely shortens", group: "Overview and sessions" },
    { key: "largestOutputs", label: "Biggest single outputs", group: "Overview and sessions" },
    { key: "toolsByName", label: "Tool outputs", group: "Overview and sessions" },
    { key: "errors", label: "Errors in shell output", group: "Overview and sessions" },
    { key: "files", label: "Files mentioned", group: "Overview and sessions" },
    { key: "git", label: "Git activity", group: "Overview and sessions" },
    { key: "tests", label: "Test results", group: "Overview and sessions" },
    { key: "recentCalls", label: "Latest calls", group: "Now" },
    { key: "repeatedErrors", label: "Recurring errors", group: "Now" },
    { key: "fileEdits", label: "Most-edited files", group: "Now" },
    { key: "repeatedCommands", label: "Repeated commands", group: "Now" },
]

function defaultSettings(): Settings {
    return {
        autoRefresh: true,
        refreshSeconds: 60,
        defaultRange: "30d",
        showEmptySessions: false,
        limits: { ...DEFAULT_LIMITS },
        paths: { home: "", sessions: "", summaries: "", blobs: "", config: "" },
    }
}

/** Stored settings are untrusted: keep known fields with valid values. */
function normalizeSettings(raw: unknown): Settings {
    const out = defaultSettings()
    if (!raw || typeof raw !== "object") return out
    const r = raw as Record<string, unknown>
    if (typeof r.autoRefresh === "boolean") out.autoRefresh = r.autoRefresh
    const secs = Number(r.refreshSeconds)
    if (Number.isFinite(secs)) out.refreshSeconds = Math.min(3600, Math.max(5, Math.round(secs)))
    if (typeof r.defaultRange === "string" && (RANGES as string[]).includes(r.defaultRange)) out.defaultRange = r.defaultRange as Range
    if (typeof r.showEmptySessions === "boolean") out.showEmptySessions = r.showEmptySessions
    if (r.limits && typeof r.limits === "object") {
        const l = r.limits as Record<string, unknown>
        for (const key of Object.keys(DEFAULT_LIMITS) as ListKey[]) {
            const v = Number(l[key])
            if (Number.isFinite(v)) out.limits[key] = Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.round(v)))
        }
    }
    if (r.paths && typeof r.paths === "object") {
        const p = r.paths as Record<string, unknown>
        for (const key of PATH_KEYS) if (typeof p[key] === "string") out.paths[key] = (p[key] as string).trim()
    }
    return out
}

let settings: Settings = defaultSettings()
let settingsProblem: string | null = null

async function loadSettings(): Promise<void> {
    try {
        settings = normalizeSettings(await host.storage.get(SETTINGS_KEY))
        settingsProblem = null
    } catch (error) {
        settingsProblem = `Saved settings could not be read (${error instanceof Error ? error.message : String(error)}); using defaults.`
    }
}

async function saveSettings(): Promise<void> {
    try {
        await host.storage.set(SETTINGS_KEY, settings as unknown as Parameters<typeof host.storage.set>[1])
        settingsProblem = null
    } catch (error) {
        settingsProblem = `Settings could not be saved (${error instanceof Error ? error.message : String(error)}). They apply until the panel reloads.`
    }
}

function refreshLabel(seconds: number): string {
    if (seconds < 60) return `${seconds} seconds`
    if (seconds % 60 === 0) return seconds === 60 ? "1 minute" : `${seconds / 60} minutes`
    return `${seconds} seconds`
}

/** The query every data request carries: the user's locations and list lengths. */
function serviceQuery(base: Record<string, string>, paths: Record<PathKey, string> = settings.paths, withLimits = true): Record<string, string> {
    const query = { ...base }
    for (const key of PATH_KEYS) if (paths[key].trim()) query[key] = paths[key].trim()
    if (withLimits) query.limits = JSON.stringify(settings.limits)
    return query
}

const host = connectHost()
const rootElement = document.querySelector<HTMLElement>("#root")
if (!rootElement) {
    throw new Error("Missing #root")
}
const root = rootElement

type Notice = {
    tone: "info" | "success" | "warning" | "error"
    title: string
    body?: string
}

let mounted = false
let initialized = false
let surface: "panel" | "status" = "panel"
let view: View = "overview"
let range: Range = "30d"
let metric: Metric = "saved"
let detailStart: number | null = null
let showEmptySessions = false
let notice: Notice | null = null
let pollTimer: number | null = null
let fetchSeq = 0
let lastStatusHeight = -1
/** last rendered payload per request key, minus `generatedAt` */
let lastRenderedKey = ""
/** request of the last render; a different one starts at the top */
let lastRequestKey = ""
let lastPayload: unknown = null
/** Only reuse data for the endpoint, period and file locations that produced it. */
let lastPayloadKey = ""
let lastRefreshedAt: number | null = null
/** locations typed in Settings but not saved yet */
let draftPaths: Record<PathKey, string> = { home: "", sessions: "", summaries: "", blobs: "", config: "" }
/** a /locations answer for the draft, from "Check" */
let draftLocations: LocationsPayload | null = null

let refs: {
    subtitle: HTMLElement
    lastRefreshed: HTMLElement
    tabsRow: HTMLElement
    rangeRow: HTMLElement
    notice: HTMLElement
    body: HTMLElement
    refresh: ButtonHandle
    settingsButton: ButtonHandle
    tabs: TabsHandle
    rangeTabs: TabsHandle
} | null = null

let statusRefs: { main: HTMLElement; badge: HTMLElement; sub: HTMLElement } | null = null
let noticeHandle: BannerHandle | null = null

// ---------------------------------------------------------------- dom helpers

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

/** A titled block with a one-sentence explanation. */
function section(title: string, explain?: string): { root: HTMLElement; body: HTMLElement } {
    const rootEl = el("section", "sq-section")
    rootEl.appendChild(el("h2", "sq-section-title", title))
    if (explain) rootEl.appendChild(el("p", "sq-explain", explain))
    const body = el("div", "sq-section-body")
    rootEl.appendChild(body)
    return { root: rootEl, body }
}

function card(label: string, value: string, sub?: string, tone?: "success" | "warning"): HTMLElement {
    const node = el("div", "sq-card")
    node.appendChild(el("div", "sq-card-label", label))
    const v = el("div", "sq-card-value", value)
    if (tone) v.dataset.tone = tone
    node.appendChild(v)
    if (sub) node.appendChild(el("div", "sq-card-sub", sub))
    return node
}

function cards(items: HTMLElement[]): HTMLElement {
    const grid = el("div", "sq-cards")
    grid.append(...items)
    return grid
}

function note(text: string, tone?: "warning"): HTMLElement {
    const node = el("p", "sq-note", text)
    if (tone) node.dataset.tone = tone
    return node
}

type RankItem = {
    primary: string
    secondary?: string
    value: string
    fraction: number
    mono?: boolean
}

/** Ranked rows: name and value on one line, detail and a bar under them. */
function rankList(items: RankItem[]): HTMLElement {
    const list = el("ol", "sq-rank")
    for (const item of items) {
        const li = el("li", "sq-rank-row")
        const head = el("div", "sq-rank-head")
        const name = el("span", item.mono ? "sq-rank-name sq-mono" : "sq-rank-name", item.primary)
        name.title = item.primary
        head.append(name, el("span", "sq-rank-value", item.value))
        li.appendChild(head)
        if (item.secondary) li.appendChild(el("div", "sq-rank-sub", item.secondary))
        const track = el("div", "sq-bar-track")
        const fill = el("div", "sq-bar-fill")
        fill.style.width = `${Math.max(1.5, Math.min(100, item.fraction * 100))}%`
        track.appendChild(fill)
        li.appendChild(track)
        list.appendChild(li)
    }
    return list
}

/** Plain text rows with an optional count and time. */
function textList(rows: { text: string; meta?: string; count?: number }[], mono = true): HTMLElement {
    const list = el("ul", "sq-list")
    for (const row of rows) {
        const li = el("li", "sq-list-row")
        const text = el("span", mono ? "sq-list-text sq-mono" : "sq-list-text", row.text)
        text.title = row.text
        li.appendChild(text)
        const side = el("span", "sq-list-side")
        if (row.count !== undefined && row.count > 1) side.appendChild(el("span", "sq-count", `×${row.count}`))
        if (row.meta) side.appendChild(el("span", "sq-list-meta", row.meta))
        if (side.childNodes.length > 0) li.appendChild(side)
        list.appendChild(li)
    }
    return list
}

/** Key/value rows. */
function kvList(rows: [string, string][]): HTMLElement {
    const list = el("dl", "sq-kv")
    for (const [k, v] of rows) {
        list.append(el("dt", undefined, k), el("dd", undefined, v))
    }
    return list
}

function progress(fraction: number, tone?: "warning"): HTMLElement {
    const track = el("div", "sq-bar-track sq-bar-track-lg")
    const fill = el("div", "sq-bar-fill")
    if (tone) fill.dataset.tone = tone
    fill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`
    track.appendChild(fill)
    return track
}

// -------------------------------------------------------------------- charts

/** Column chart in HTML so labels never stretch. */
function columnChart(
    points: { label: string; value: number; tip: string }[],
    axis: [string, string, string],
): HTMLElement {
    const wrap = el("div", "sq-chart")
    const bars = el("div", "sq-cols")
    const max = points.reduce((m, p) => Math.max(m, p.value), 0)
    for (const p of points) {
        const col = el("div", "sq-col")
        col.title = p.tip
        const bar = el("div", "sq-col-bar")
        bar.style.height = max > 0 && p.value > 0 ? `${Math.max(3, (p.value / max) * 100)}%` : "0"
        col.appendChild(bar)
        bars.appendChild(col)
    }
    const labels = el("div", "sq-axis")
    labels.append(el("span", undefined, axis[0]), el("span", undefined, axis[1]), el("span", undefined, axis[2]))
    wrap.append(bars, labels)
    return wrap
}

function seriesTip(p: SeriesPoint): string {
    return [
        p.label,
        `${formatTokens(p.savedTokens)} tokens saved`,
        `${plural(p.commands, "shell command")} (${formatTokens(p.inTokens)} → ${formatTokens(p.outTokens)})`,
        `${plural(p.toolCalls, "tool output")} (~${formatTokens(p.toolTokens)} tokens)`,
    ].join("\n")
}

function seriesChart(report: WindowReport): HTMLElement {
    const wrap = el("div")
    const switcher = el("div", "sq-segmented")
    const options: [Metric, string][] = [
        ["saved", "Tokens saved"],
        ["commands", "Shell commands"],
        ["tools", "Tool outputs"],
    ]
    for (const [id, label] of options) {
        const b = el("button", "sq-seg", label)
        b.type = "button"
        b.setAttribute("aria-pressed", String(metric === id))
        b.addEventListener("click", () => {
            metric = id
            renderPanel(true)
        })
        switcher.appendChild(b)
    }
    const points = report.series.map((p) => ({
        label: p.label,
        value: metric === "saved" ? p.savedTokens : metric === "commands" ? p.commands : p.toolCalls,
        tip: seriesTip(p),
    }))
    const first = report.series[0]?.label ?? ""
    const mid = report.series[Math.floor((report.series.length - 1) / 2)]?.label ?? ""
    const last = report.series[report.series.length - 1]?.label ?? ""
    wrap.append(switcher, columnChart(points, [shortLabel(first), shortLabel(mid), shortLabel(last)]))
    return wrap
}

function shortLabel(label: string): string {
    return /^\d{4}-\d{2}-\d{2}$/.test(label) ? label.slice(5) : label
}

// --------------------------------------------------------------- the report

/** Everything a time window holds. Shared by Overview, a session and Now. */
function renderReport(container: HTMLElement, report: WindowReport, options: { hero: boolean }): void {
    const shell = report.shell

    if (options.hero) {
        const hero = el("div", "sq-hero")
        if (shell.commands > 0) {
            hero.append(
                el("div", "sq-hero-value", `${formatTokens(shell.savedTokens)} tokens`),
                el("div", "sq-hero-label", "cut from shell output"),
                el(
                    "div",
                    "sq-hero-sub",
                    `${plural(shell.commands, "shell command")} · ${formatTokens(shell.inTokens)} → ${formatTokens(shell.outTokens)} tokens · ${percent(shell.savedTokens, shell.inTokens)} shorter`,
                ),
            )
        } else {
            hero.append(el("div", "sq-hero-value", "No shell commands"), el("div", "sq-hero-label", "squeez had nothing to compress in this period"))
        }
        container.appendChild(hero)
        container.appendChild(
            el(
                "p",
                "sq-explain",
                "squeez shortens what shell commands print before the agent reads it. Token counts are squeez's own estimates of that output before and after.",
            ),
        )
    }

    const c = section("At a glance")
    c.body.appendChild(
        cards([
            card("Shortened", count(shell.compressed), `of ${plural(shell.commands, "command")}`, "success"),
            card("Unchanged", count(shell.unchanged), `${percent(shell.unchanged, shell.commands)} passed through as-is`),
            card("Got longer", count(shell.grew), "squeez added a note"),
            card("Tool outputs", count(report.tools.calls), `~${formatTokens(report.tools.tokens)} tokens, measured only`),
            card("Sessions started", count(report.sessionsStarted)),
            card(
                "Active",
                report.firstEvent ? formatClock(report.firstEvent) : "—",
                report.lastEvent ? `until ${formatClock(report.lastEvent)}` : undefined,
            ),
        ]),
    )
    container.appendChild(c.root)

    if (report.series.length > 1) {
        const s = section(
            report.granularity === "hour" ? "Hour by hour" : "Day by day",
            "Hover a bar for that period's numbers.",
        )
        s.body.appendChild(seriesChart(report))
        container.appendChild(s.root)
    }

    if (report.granularity === "day" && report.hourOfDay.some((h) => h.commands + h.toolCalls > 0)) {
        const s = section("Time of day", "When the work happens: shell commands and tool outputs by local hour.")
        s.body.appendChild(
            columnChart(
                report.hourOfDay.map((h) => ({
                    label: `${h.hour}:00`,
                    value: h.commands + h.toolCalls,
                    tip: `${String(h.hour).padStart(2, "0")}:00 · ${plural(h.commands, "shell command")} · ${plural(h.toolCalls, "tool output")}`,
                })),
                ["00:00", "12:00", "23:00"],
            ),
        )
        container.appendChild(s.root)
    }

    if (report.topCommands.length > 0) {
        const s = section("Where the savings come from", "Programs whose output squeez shortened, by tokens removed.")
        s.body.appendChild(commandRank(report.topCommands, "saved"))
        container.appendChild(s.root)
    }

    if (report.weakCommands.length > 0) {
        const s = section(
            "What squeez barely shortens",
            "Output that reached the agent almost unchanged (under 10% removed), by tokens kept.",
        )
        s.body.appendChild(commandRank(report.weakCommands, "kept"))
        container.appendChild(s.root)
    }

    if (report.largestOutputs.length > 0) {
        const s = section("Biggest single outputs", "The individual commands that printed the most.")
        const max = report.largestOutputs[0]?.inTokens ?? 0
        s.body.appendChild(
            rankList(
                report.largestOutputs.map((o) => ({
                    primary: o.cmd.replace(/\s*\r?\n\s*/g, " ⏎ "),
                    secondary: `${formatTokens(o.inTokens)} → ${formatTokens(o.outTokens)} tokens · ${formatClock(o.ts)}`,
                    value: `−${percent(o.inTokens - o.outTokens, o.inTokens)}`,
                    fraction: max > 0 ? o.inTokens / max : 0,
                    mono: true,
                })),
            ),
        )
        container.appendChild(s.root)
    }

    if (report.toolsByName.length > 0) {
        const s = section(
            "Tool outputs",
            "Every tool result squeez tracked: file reads, edits, searches, MCP tools, and the shell result itself after compression. squeez records their size; it compresses only shell output.",
        )
        const max = report.toolsByName[0]?.tokens ?? 0
        s.body.appendChild(
            rankList(
                report.toolsByName.map((t) => ({
                    primary: t.name,
                    secondary: `${plural(t.calls, "call")}${t.server ? ` · ${t.server}` : ""}`,
                    value: `~${formatTokens(t.tokens)}`,
                    fraction: max > 0 ? t.tokens / max : 0,
                    mono: true,
                })),
            ),
        )
        container.appendChild(s.root)
    }

    appendCountSection(container, "Errors in shell output", "Error lines squeez picked out of command output.", report.errors)
    appendCountSection(container, "Files mentioned", "Paths that appeared in shell output, most frequent first.", report.files)
    appendCountSection(container, "Git activity", "Commits and refs squeez saw in git output, newest first.", report.git)

    if (report.tests.length > 0) {
        const s = section("Test results", "Lines squeez took for test-run summaries, newest first. Its detection is loose, so some are just output that looked like one.")
        s.body.appendChild(textList(report.tests.map((t) => ({ text: t.text, meta: formatClock(t.ts) }))))
        container.appendChild(s.root)
    }
}

function commandRank(rows: CommandRow[], mode: "saved" | "kept"): HTMLElement {
    const max = rows.reduce((m, r) => Math.max(m, mode === "saved" ? r.savedTokens : r.outTokens), 0)
    return rankList(
        rows.map((r) => ({
            primary: r.name,
            secondary: `${plural(r.runs, "run")} · ${formatTokens(r.inTokens)} → ${formatTokens(r.outTokens)} · ${percent(r.savedTokens, r.inTokens)} shorter`,
            value: mode === "saved" ? `−${formatTokens(r.savedTokens)}` : `${formatTokens(r.outTokens)} kept`,
            fraction: max > 0 ? (mode === "saved" ? r.savedTokens : r.outTokens) / max : 0,
            mono: true,
        })),
    )
}

function appendCountSection(container: HTMLElement, title: string, explain: string, rows: CountRow[]): void {
    if (rows.length === 0) return
    const s = section(title, explain)
    s.body.appendChild(textList(rows.map((r) => ({ text: r.text, count: r.count, meta: formatClock(r.last) }))))
    container.appendChild(s.root)
}

// ---------------------------------------------------------------- views

function renderOverview(container: HTMLElement, data: OverviewPayload): void {
    renderReport(container, data.report, { hero: true })
}

function renderSessions(container: HTMLElement, data: SessionsPayload): void {
    container.appendChild(
        el(
            "p",
            "sq-explain",
            "A squeez session runs from one agent start to the next start anywhere on this machine. Sub-agents and parallel chats each start one, so there are many short sessions. Each session's numbers are the events logged during it.",
        ),
    )
    const active = data.rows.filter((r) => r.shellCommands + r.toolCalls > 0)
    const lengths = active.map((r) => r.end - r.start).sort((a, b) => a - b)
    const median = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] ?? 0 : 0
    container.appendChild(
        cards([
            card("Sessions started", count(data.total)),
            card("With activity", count(data.active), "ran at least one command or tool"),
            card("Empty", count(data.empty), "started and ended without activity"),
            card("Typical length", lengths.length > 0 ? formatDuration(median) : "—", "median of active sessions"),
        ]),
    )

    const toggleRow = el("div", "sq-toggle")
    mountSwitch(toggleRow, {
        label: "Show empty sessions",
        checked: showEmptySessions,
        onChange: (next) => {
            showEmptySessions = next
            settings.showEmptySessions = next
            void saveSettings()
            renderPanel(true)
        },
    })
    container.appendChild(toggleRow)

    const rows = showEmptySessions ? data.rows : active
    if (rows.length === 0) {
        container.appendChild(note("No sessions in this period."))
        return
    }
    const list = el("div", "sq-sessions")
    const maxSaved = rows.reduce((m, r) => Math.max(m, r.savedTokens), 0)
    for (const row of rows) list.appendChild(sessionButton(row, maxSaved))
    container.appendChild(list)
    if (data.truncated) container.appendChild(note(`Showing the newest ${data.rows.length} of ${data.total} sessions.`))
}

function sessionButton(row: SessionRow, maxSaved: number): HTMLElement {
    const b = el("button", "sq-session")
    b.type = "button"
    const left = el("div", "sq-session-left")
    const when = el("div", "sq-session-when", formatClock(row.start))
    if (row.ongoing) when.appendChild(el("span", "sq-badge", "now"))
    left.append(when, el("div", "sq-session-sub", row.ongoing ? `running ${formatDuration(row.end - row.start)}` : formatDuration(row.end - row.start)))
    const right = el("div", "sq-session-right")
    right.append(
        el("div", "sq-session-saved", row.savedTokens > 0 ? `−${formatTokens(row.savedTokens)}` : "—"),
        el("div", "sq-session-sub", `${plural(row.shellCommands, "cmd")} · ${plural(row.toolCalls, "tool")}`),
    )
    const track = el("div", "sq-bar-track sq-session-bar")
    const fill = el("div", "sq-bar-fill")
    fill.style.width = maxSaved > 0 ? `${(row.savedTokens / maxSaved) * 100}%` : "0"
    track.appendChild(fill)
    b.append(left, right, track)
    b.addEventListener("click", () => {
        detailStart = row.start
        lastRenderedKey = ""
        void refresh()
    })
    return b
}

function renderSessionDetail(container: HTMLElement, data: SessionDetailPayload): void {
    const back = el("div", "sq-back")
    mountButton(back, {
        label: "← All sessions",
        variant: "ghost",
        size: "sm",
        onClick: () => {
            detailStart = null
            lastRenderedKey = ""
            void refresh()
        },
    })
    container.appendChild(back)

    const row = data.row
    if (!row || !data.report) {
        container.appendChild(note("This session is no longer in squeez's records."))
        return
    }

    const head = el("div", "sq-hero")
    head.append(
        el("div", "sq-hero-value", formatClock(row.start)),
        el("div", "sq-hero-label", row.ongoing ? `running for ${formatDuration(row.end - row.start)}` : `lasted ${formatDuration(row.end - row.start)}`),
        el(
            "div",
            "sq-hero-sub",
            `${formatTokens(row.savedTokens)} tokens cut · ${plural(row.shellCommands, "shell command")} · ${plural(row.toolCalls, "tool output")}`,
        ),
    )
    container.appendChild(head)

    const summary = data.summary
    if (summary) {
        const s = section(
            "squeez's record of this session",
            "Written by squeez when the next session started. The score is squeez's own: 30% compression, 30% share of work not done by sub-agents, 20% repeated output avoided, 20% context budget left.",
        )
        s.body.appendChild(
            cards([
                card("squeez score", pct(summary.score.overall)),
                card("Compression", pct(summary.score.compression)),
                card("Not sub-agents", pct(summary.score.toolChoice)),
                card("Repeats avoided", pct(summary.score.reuse)),
                card("Budget left", pct(summary.score.budget)),
                card("Files touched", count(summary.filesTouchedCount), `${count(summary.filesCommittedCount)} clean in git when it ended`),
            ]),
        )
        const lists: [string, string[]][] = [
            ["Completed", summary.completed],
            ["Next steps squeez noted", summary.nextSteps],
            ["Errors seen", summary.errors],
            ["Git", summary.gitEvents],
            ["Files", summary.filesTouched],
        ]
        for (const [title, items] of lists) {
            if (items.length === 0) continue
            s.body.appendChild(el("h3", "sq-subtitle", title))
            s.body.appendChild(textList(items.slice(0, 12).map((text) => ({ text }))))
            if (items.length > 12) s.body.appendChild(el("p", "sq-explain", `and ${items.length - 12} more`))
        }
        if (summary.testSummary) {
            s.body.appendChild(el("h3", "sq-subtitle", "Last test summary"))
            s.body.appendChild(textList([{ text: summary.testSummary }]))
        }
        container.appendChild(s.root)
    } else if (!row.ongoing) {
        container.appendChild(note("squeez kept no record for this session (records are pruned after the retention period)."))
    }

    renderReport(container, data.report, { hero: false })
}

function renderNow(container: HTMLElement, data: NowPayload): void {
    const current = data.current
    if (!current) {
        container.appendChild(note("squeez is not tracking a session right now."))
        return
    }
    container.appendChild(
        el(
            "p",
            "sq-explain",
            "squeez follows one session at a time for the whole machine: whichever agent started most recently. It may not be the chat you are looking at.",
        ),
    )

    const net = current.savedTokens - current.overheadTokens
    const hero = el("div", "sq-hero")
    hero.append(
        el("div", "sq-hero-value", `${formatTokens(current.savedTokens)} tokens`),
        el("div", "sq-hero-label", "cut from shell output this session"),
        el("div", "sq-hero-sub", `started ${formatClock(current.start)} · ${formatAgo(current.start)}`),
    )
    container.appendChild(hero)

    container.appendChild(
        cards([
            card("Agent received", formatTokens(current.receivedTokens), "all tool results, shell after compression"),
            card("squeez's own text", formatTokens(current.overheadTokens), "banners and tags it added"),
            card("Net", `${net < 0 ? "−" : ""}${formatTokens(Math.abs(net))}`, "cut minus squeez's own text", net >= 0 ? "success" : "warning"),
            card("Tool calls tracked", count(current.trackedCalls)),
        ]),
    )

    const ctx = data.context
    if (ctx) {
        if (!data.contextMatches) {
            container.appendChild(note("squeez's working context was last written by a different session; the numbers below may lag.", "warning"))
        }
        if (ctx.ctxWindow > 0) {
            const s = section("Context window", "The last reading squeez took from the harness: how full the agent's context was.")
            const frac = ctx.ctxTokens / ctx.ctxWindow
            s.body.append(
                el("div", "sq-big", `${formatTokens(ctx.ctxTokens)} of ${formatTokens(ctx.ctxWindow)} (${percent(ctx.ctxTokens, ctx.ctxWindow)})`),
                progress(frac, frac > 0.75 ? "warning" : undefined),
                el("div", "sq-card-sub", `${formatTokens(ctx.cacheReadTokens)} of it read from cache`),
            )
            container.appendChild(s.root)
        }

        const kinds: [string, number][] = [
            ["Shell", ctx.tokensBash],
            ["File reads", ctx.tokensRead],
            ["Searches", ctx.tokensGrep],
            ["Other tools", ctx.tokensOther],
        ]
        const kindMax = kinds.reduce((m, [, v]) => Math.max(m, v), 0)
        if (kindMax > 0) {
            const s = section("Output this session, by kind", "Tokens of tool output the agent received this session, as squeez counted them.")
            s.body.appendChild(
                rankList(kinds.map(([name, v]) => ({ primary: name, value: `~${formatTokens(v)}`, fraction: v / kindMax }))),
            )
            container.appendChild(s.root)
        }

        const s = section("What squeez did this session", "Interventions beyond shortening shell output.")
        s.body.appendChild(
            cards([
                card("Repeats caught", String(ctx.exactDedupHits + ctx.fuzzyDedupHits), `${ctx.exactDedupHits} exact · ${ctx.fuzzyDedupHits} similar`),
                card("Re-reads noticed", String(ctx.rereads), "same file read again"),
                card("Summarised", String(ctx.summarizeTriggers), "outputs too long to keep"),
                card("Max compression", String(ctx.ultraCalls), "calls under context pressure"),
                card("Sub-agents", String(ctx.agentSpawns), ctx.agentEstimatedTokens > 0 ? `~${formatTokens(ctx.agentEstimatedTokens)} tokens est.` : undefined),
                card("Pace", String(ctx.callsThisMinute), "calls in the latest minute"),
            ]),
        )
        container.appendChild(s.root)

        if (ctx.recentCalls.length > 0) {
            const r = section("Latest calls", "squeez's call log, newest first. The number is the call's position in squeez's running count.")
            r.body.appendChild(
                textList(ctx.recentCalls.map((call) => ({ text: call.label.replace(/\s+/g, " "), meta: `#${call.n} · ${formatBytes(call.bytes)}` }))),
            )
            container.appendChild(r.root)
        }
        if (ctx.repeatedErrors.length > 0) {
            const r = section("Recurring errors", "Errors squeez has seen more than once. Kept across sessions.")
            r.body.appendChild(textList(ctx.repeatedErrors.map((e) => ({ text: e.text, count: e.count }))))
            container.appendChild(r.root)
        }
        if (ctx.fileEdits.length > 0) {
            const r = section("Most-edited files", "Files squeez saw modified most often. Kept across sessions.")
            const max = ctx.fileEdits[0]?.count ?? 0
            r.body.appendChild(
                rankList(ctx.fileEdits.map((f) => ({ primary: f.path, value: `×${f.count}`, fraction: max > 0 ? f.count / max : 0, mono: true }))),
            )
            container.appendChild(r.root)
        }
        if (ctx.repeatedCommands.length > 0) {
            const r = section("Repeated commands", "Commands run over and over (squeez nudges the agent about these).")
            r.body.appendChild(textList(ctx.repeatedCommands.map((c) => ({ text: c.name, count: c.count }))))
            container.appendChild(r.root)
        }
        container.appendChild(
            note(`squeez remembers ${plural(ctx.seenFiles, "file")} read and has counted ${ctx.callCounter.toLocaleString("en-US")} calls overall.`),
        )
    }

    if (data.report) {
        container.appendChild(el("h2", "sq-divider", "This session's log"))
        renderReport(container, data.report, { hero: false })
    }
}

function renderStorage(container: HTMLElement, data: StoragePayload): void {
    container.appendChild(el("p", "sq-explain", "What squeez keeps on disk, and its settings."))
    const p = data.meta.paths
    container.appendChild(
        kvList([
            ["squeez folder", `${p.home}${data.meta.pathSource === "auto" ? "  (found automatically)" : ""}`],
            ["Event logs", p.sessionsDir],
            ["Session records", p.summariesFile],
            ["Stashed outputs", p.blobsDir],
            ["Config", p.configFile],
        ]),
    )

    const logs = data.logs
    const l = section("Event logs", "One file per session-start hour. Every number in this panel is counted from these events.")
    l.body.appendChild(
        cards([
            card("Files", String(logs.files), formatBytes(logs.bytes)),
            card("Events", logs.events.toLocaleString("en-US")),
            card("Recovered", logs.recoveredEvents.toLocaleString("en-US"), "events written two to a line"),
            card("Unreadable", String(logs.unreadableLines), "lines skipped"),
        ]),
    )
    l.body.appendChild(kvList([["Covers", formatSpan(logs.firstEvent, logs.lastEvent)]]))
    container.appendChild(l.root)

    const sm = data.summaries
    const retention = data.config.find((c) => c.key === "memory_retention_days")?.value
    const s = section(
        "Session records",
        "squeez's summary of each finished session (memory/summaries.jsonl). Their tokens_saved field re-counts the whole hourly log, so it double-counts; this panel recounts from events instead.",
    )
    s.body.appendChild(
        cards([
            card("Records", sm.count.toLocaleString("en-US"), formatBytes(sm.bytes)),
            card("Kept for", retention ? `${retention} days` : "—", "squeez prunes older ones"),
        ]),
    )
    s.body.appendChild(kvList([["Covers", formatSpan(sm.first, sm.last)]]))
    container.appendChild(s.root)

    const blobs = data.blobs
    if (blobs) {
        const b = section("Stashed outputs", "Oversized outputs squeez set aside so the agent can fetch them later instead of reading them in full.")
        b.body.appendChild(
            cards([
                card("Outputs", blobs.count.toLocaleString("en-US"), formatBytes(blobs.bytes)),
                card("Search index", formatBytes(blobs.indexBytes)),
            ]),
        )
        b.body.appendChild(kvList([["Covers", formatSpan(blobs.oldest, blobs.newest)]]))
        if (blobs.largest.length > 0) {
            b.body.appendChild(el("h3", "sq-subtitle", "Largest"))
            b.body.appendChild(
                textList(
                    blobs.largest.map((x) => ({
                        text: x.preview ? x.preview.replace(/\s+/g, " ") : x.id,
                        meta: `${formatBytes(x.bytes)} · ${formatClock(x.modified)}`,
                    })),
                ),
            )
        }
        container.appendChild(b.root)
    }

    const h = data.handlers
    const hs = section(
        "squeez's per-command table",
        "handler_stats.json: totals per first word of the command line, kept since the table was created. squeez stops adding names at 64.",
    )
    hs.body.append(el("div", "sq-big", `${h.used} of ${h.max} names used`), progress(h.max > 0 ? h.used / h.max : 0, h.used >= h.max ? "warning" : undefined))
    if (h.used >= h.max) {
        hs.body.appendChild(note("The table is full: commands starting with a new word are no longer counted in it. That is why it shows far less than the event logs.", "warning"))
    }
    hs.body.appendChild(
        cards([card("Calls", h.calls.toLocaleString("en-US")), card("Tokens", `${formatTokens(h.inTokens)} → ${formatTokens(h.outTokens)}`)]),
    )
    const max = h.rows.reduce((m, r) => Math.max(m, r.inTokens - r.outTokens), 0)
    hs.body.appendChild(
        rankList(
            h.rows.map((r) => ({
                primary: r.name,
                secondary: `${plural(r.calls, "call")} · ${formatTokens(r.inTokens)} → ${formatTokens(r.outTokens)}`,
                value: `−${formatTokens(Math.max(0, r.inTokens - r.outTokens))}`,
                fraction: max > 0 ? Math.max(0, r.inTokens - r.outTokens) / max : 0,
                mono: true,
            })),
        ),
    )
    container.appendChild(hs.root)

    if (data.config.length > 0) {
        const c = section("Settings", "squeez's config.ini.")
        c.body.appendChild(kvList(data.config.map((x) => [x.key, x.value])))
        container.appendChild(c.root)
    }
}

// ------------------------------------------------------------------ settings view

/** A labelled row in the settings form. */
function settingRow(container: HTMLElement, help?: string): HTMLElement {
    const row = el("div", "sq-setting")
    const control = el("div", "sq-setting-control")
    row.appendChild(control)
    if (help) row.appendChild(el("p", "sq-explain sq-setting-help", help))
    container.appendChild(row)
    return control
}

function applySettingsChange(options: { reschedule?: boolean; refetch?: boolean } = {}): void {
    void saveSettings().then(() => {
        if (options.reschedule) schedulePoll()
        if (settingsProblem) renderPanel(true)
    })
    if (options.refetch) lastRenderedKey = ""
}

function openSettings(): void {
    view = "settings"
    detailStart = null
    draftPaths = { ...settings.paths }
    draftLocations = null
    lastRenderedKey = ""
    refs?.body.replaceChildren(el("p", "sq-explain", "Loading…"))
    syncChrome()
    void refresh(true)
}

function closeSettings(): void {
    view = "overview"
    refs?.tabs.update({ activeId: view })
    draftLocations = null
    lastRenderedKey = ""
    refs?.body.replaceChildren(el("p", "sq-explain", "Loading…"))
    syncChrome()
    void refresh(true)
}

async function checkDraftLocations(rescan = false): Promise<void> {
    try {
        const result = await host.serviceRequest({
            method: "GET",
            path: "/locations",
            query: serviceQuery(rescan ? { rescan: "1" } : {}, draftPaths, false),
        })
        if (result.status !== 200) throw new Error(`stats service responded with HTTP ${result.status}`)
        draftLocations = JSON.parse(result.body) as LocationsPayload
        notice = null
    } catch (error) {
        notice = describeError(error)
    }
    renderPanel(true)
}

function renderSettings(container: HTMLElement, saved: LocationsPayload): void {
    const back = el("div", "sq-back")
    mountButton(back, { label: "← Back to stats", variant: "ghost", size: "sm", onClick: closeSettings })
    container.appendChild(back)
    container.appendChild(el("p", "sq-explain", "Saved for this extension and shared by the panel and the Work Status line."))
    if (settingsProblem) container.appendChild(note(settingsProblem, "warning"))

    // refresh
    const r = section("Refreshing", "How often the numbers update by themselves. Refresh in the header always updates now.")
    mountSwitch(settingRow(r.body), {
        label: "Refresh automatically",
        checked: settings.autoRefresh,
        description: settings.autoRefresh ? `every ${refreshLabel(settings.refreshSeconds)}` : "only when you press Refresh or a chat starts or ends",
        onChange: (next) => {
            settings.autoRefresh = next
            applySettingsChange({ reschedule: true })
            renderPanel(true)
        },
    })
    const choices = REFRESH_CHOICES.includes(settings.refreshSeconds) ? REFRESH_CHOICES : [...REFRESH_CHOICES, settings.refreshSeconds].sort((a, b) => a - b)
    mountSelect(settingRow(r.body), {
        label: "Refresh every",
        value: String(settings.refreshSeconds),
        options: choices.map((s) => ({ id: String(s), label: refreshLabel(s) })),
        disabled: !settings.autoRefresh,
        onChange: (id) => {
            settings.refreshSeconds = Number(id)
            applySettingsChange({ reschedule: true })
            renderPanel(true)
        },
    })
    container.appendChild(r.root)

    // display
    const d = section("Display")
    mountSelect(settingRow(d.body, "The period Overview and Sessions show when the panel opens."), {
        label: "Default period",
        value: settings.defaultRange,
        options: RANGES.map((id) => ({ id, label: RANGE_LABELS[id] })),
        onChange: (id) => {
            settings.defaultRange = id as Range
            range = settings.defaultRange
            refs?.rangeTabs.update({ activeId: range })
            applySettingsChange()
            renderPanel(true)
        },
    })
    mountSwitch(settingRow(d.body), {
        label: "Show empty sessions",
        checked: settings.showEmptySessions,
        description: "Sessions that started and ended without running anything.",
        onChange: (next) => {
            settings.showEmptySessions = next
            showEmptySessions = next
            applySettingsChange()
            renderPanel(true)
        },
    })
    container.appendChild(d.root)

    // list lengths
    const lists = section("List lengths", "How many rows each list shows.")
    for (const group of ["Overview and sessions", "Now"] as const) {
        lists.body.appendChild(el("h3", "sq-subtitle", group))
        const grid = el("div", "sq-setting-grid")
        for (const field of LIST_FIELDS.filter((f) => f.group === group)) {
            const current = settings.limits[field.key]
            const options = LIMIT_CHOICES.includes(current) ? LIMIT_CHOICES : [...LIMIT_CHOICES, current].sort((a, b) => a - b)
            mountSelect(settingRow(grid), {
                label: field.label,
                value: String(current),
                options: options.map((n) => ({ id: String(n), label: `${n} rows` })),
                onChange: (id) => {
                    settings.limits[field.key] = Number(id)
                    applySettingsChange({ refetch: true })
                    renderPanel(true)
                },
            })
        }
        lists.body.appendChild(grid)
    }
    container.appendChild(lists.root)

    renderLocationSettings(container, saved)

    const reset = section("Reset")
    mountButton(settingRow(reset.body, "Back to the defaults: refresh every minute, 30 days, default list lengths, locations found automatically."), {
        label: "Reset all settings",
        variant: "outline",
        size: "sm",
        onClick: () => {
            settings = defaultSettings()
            range = settings.defaultRange
            showEmptySessions = settings.showEmptySessions
            draftPaths = { ...settings.paths }
            draftLocations = null
            refs?.rangeTabs.update({ activeId: range })
            applySettingsChange({ reschedule: true, refetch: true })
            void refresh(true)
        },
    })
    container.appendChild(reset.root)
}

function renderLocationSettings(container: HTMLElement, saved: LocationsPayload): void {
    const shown = draftLocations ?? saved
    const s = section(
        "squeez's files",
        "Found automatically: the folder squeez last wrote to among the places it can live. If that is wrong, or nothing was found, enter the locations here. Leave a field empty to use the default inside the squeez folder.",
    )

    const missingRequired = shown.checks.some((c) => c.required && !c.exists)
    s.body.appendChild(
        note(
            missingRequired
                ? "squeez's event logs were not found at the location below. Pick the right squeez folder, or enter the event logs folder."
                : `${shown.pathSource === "auto" ? "Found automatically" : "Using your locations"}: everything the panel needs is there.`,
            missingRequired ? "warning" : undefined,
        ),
    )

    const status = el("ul", "sq-list sq-checks")
    for (const check of shown.checks) {
        const field = PATH_FIELDS.find((f) => f.key === check.id)
        const li = el("li", "sq-list-row")
        const text = el("span", "sq-list-text")
        text.append(el("span", "sq-check-label", field?.label ?? check.id), el("span", "sq-check-path sq-mono", check.path))
        text.title = check.path
        const mark = el("span", "sq-check-mark", check.exists ? "found" : check.required ? "missing" : "not there")
        mark.dataset.state = check.exists ? "ok" : check.required ? "bad" : "absent"
        li.append(text, mark)
        status.appendChild(li)
    }
    s.body.appendChild(status)

    for (const field of PATH_FIELDS) {
        const resolved = shown.checks.find((c) => c.id === field.key)?.path ?? ""
        const handle = mountTextField(settingRow(s.body), {
            label: field.label,
            value: draftPaths[field.key],
            placeholder: resolved ? `automatic: ${resolved}` : "automatic",
            helper: `${field.help} Full ${field.kind} path.`,
            mono: true,
            onChange: (value) => {
                draftPaths[field.key] = value
                handle.update({ value })
            },
        })
    }

    const actions = el("div", "sq-setting-actions")
    mountButton(actions, { label: "Check", variant: "outline", size: "sm", onClick: () => void checkDraftLocations() })
    mountButton(actions, {
        label: "Save locations",
        variant: "default",
        size: "sm",
        onClick: () => {
            settings.paths = { ...draftPaths }
            draftLocations = null
            applySettingsChange({ refetch: true })
            void refresh(true)
        },
    })
    mountButton(actions, {
        label: "Find automatically",
        variant: "ghost",
        size: "sm",
        onClick: () => {
            draftPaths = { home: "", sessions: "", summaries: "", blobs: "", config: "" }
            settings.paths = { ...draftPaths }
            applySettingsChange({ refetch: true })
            void checkDraftLocations(true)
        },
    })
    s.body.appendChild(actions)

    const found = shown.candidates
    if (found.length > 0) {
        s.body.appendChild(el("h3", "sq-subtitle", "Places squeez can live"))
        s.body.appendChild(el("p", "sq-explain", "Every folder squeez uses for one of its hosts, checked on this machine."))
        const list = el("ul", "sq-list")
        for (const c of found) {
            const li = el("li", "sq-list-row")
            const text = el("span", "sq-list-text")
            text.append(
                el("span", "sq-check-path sq-mono", c.path),
                el(
                    "span",
                    "sq-check-label",
                    c.hasSessions
                        ? `${plural(c.logFiles, "event log")}${c.lastLog ? ` · last written ${formatAgo(c.lastLog)}` : ""}${c.source === "env" ? " · from environment" : ""}`
                        : "not here",
                ),
            )
            text.title = c.path
            li.appendChild(text)
            if (c.hasSessions) {
                const side = el("span", "sq-list-side")
                mountButton(side, {
                    label: c.path === shown.paths.home ? "In use" : "Use this",
                    variant: "ghost",
                    size: "xs",
                    disabled: c.path === shown.paths.home,
                    onClick: () => {
                        draftPaths = { home: c.path, sessions: "", summaries: "", blobs: "", config: "" }
                        settings.paths = { ...draftPaths }
                        applySettingsChange({ refetch: true })
                        void checkDraftLocations()
                    },
                })
                li.appendChild(side)
            }
            list.appendChild(li)
        }
        s.body.appendChild(list)
    }
    container.appendChild(s.root)
}

// -------------------------------------------------------------------- mounting

function mountPanel(): void {
    const panel = el("div", "sq sq-panel")

    const header = el("div", "sq-header")
    const heading = el("div", "sq-heading")
    heading.append(el("h1", "sq-title", "Squeez"), el("div", "sq-subtitle-line", ""))
    const actions = el("div", "sq-actions")
    const actionArea = el("div", "sq-action-area")
    const lastRefreshed = el("div", "sq-last-refreshed", formatRefreshedAt(null))
    const refreshButton = mountButton(actions, {
        label: "Refresh",
        variant: "ghost",
        size: "sm",
        disabled: !initialized,
        onClick: () => {
            lastRenderedKey = ""
            void refresh(true)
        },
    })
    const settingsButton = mountButton(actions, {
        label: "Settings",
        variant: "ghost",
        size: "sm",
        disabled: !initialized,
        onClick: () => (view === "settings" ? closeSettings() : openSettings()),
    })
    actionArea.append(actions, lastRefreshed)
    header.append(heading, actionArea)

    const tabsRow = el("div", "sq-tabs")
    const tabs = mountTabs(tabsRow, {
        items: [
            { id: "overview", label: "Overview" },
            { id: "sessions", label: "Sessions" },
            { id: "now", label: "Now" },
            { id: "storage", label: "Storage" },
        ],
        activeId: view,
        onChange: (next) => {
            view = next as View
            detailStart = null
            tabs.update({ activeId: view })
            syncChrome()
            lastRenderedKey = ""
            refs?.body.replaceChildren(el("p", "sq-explain", "Loading…"))
            void refresh(true)
        },
    })

    const rangeRow = el("div", "sq-range")
    const rangeTabs = mountTabs(rangeRow, {
        items: RANGES.map((id) => ({ id, label: RANGE_LABELS[id] })),
        activeId: range,
        onChange: (next) => {
            range = next as Range
            rangeTabs.update({ activeId: range })
            detailStart = null
            lastRenderedKey = ""
            void refresh(true)
        },
    })

    const noticeEl = el("div", "sq-notice")
    const body = el("div", "sq-body")
    body.appendChild(loadingFeedback("Loading saved settings", "Reading your refresh preferences and file locations from OpenChamber."))
    panel.append(header, tabsRow, rangeRow, noticeEl, body)
    root.replaceChildren(panel)

    refs = {
        subtitle: heading.lastElementChild as HTMLElement,
        lastRefreshed,
        tabsRow,
        rangeRow,
        notice: noticeEl,
        body,
        refresh: refreshButton,
        settingsButton,
        tabs,
        rangeTabs,
    }
    syncChrome()
}

/** Which header rows show for the current view. */
function syncChrome(): void {
    if (!refs) return
    refs.tabsRow.hidden = !initialized || view === "settings"
    refs.rangeRow.hidden = !initialized || !((view === "overview" || view === "sessions") && detailStart === null)
    refs.refresh.update({ disabled: !initialized })
    refs.settingsButton.update({ label: view === "settings" ? "Done" : "Settings" })
    refs.settingsButton.update({ disabled: !initialized })
}

function loadingFeedback(title: string, description: string): HTMLElement {
    const feedback = el("div", "sq-loading")
    feedback.setAttribute("role", "status")
    feedback.setAttribute("aria-live", "polite")
    feedback.append(el("h2", "sq-section-title", title), el("p", "sq-explain", description))
    return feedback
}

function mountStatus(): void {
    const status = el("div", "sq sq-status")
    const top = el("div", "sq-status-top")
    const main = el("span", "sq-status-main", "Squeez")
    const badge = el("span", "sq-badge")
    badge.hidden = true
    top.append(main, badge)
    const sub = el("div", "sq-status-sub", "")
    status.append(top, sub)
    root.replaceChildren(status)
    statusRefs = { main, badge, sub }
}

// -------------------------------------------------------------------- fetching

function rangeStart(r: Range): number {
    if (r === "all") return 0
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    if (r === "7d") d.setDate(d.getDate() - 6)
    if (r === "30d") d.setDate(d.getDate() - 29)
    return d.getTime()
}

function todayStart(): number {
    return rangeStart("today")
}

function currentRequest(): { path: string; query: Record<string, string> } {
    if (surface === "status") return { path: "/status", query: serviceQuery({ start: String(todayStart()) }, settings.paths, false) }
    if (view === "settings") return { path: "/locations", query: serviceQuery({}, settings.paths, false) }
    if (view === "sessions" && detailStart !== null) return { path: "/session", query: serviceQuery({ start: String(detailStart) }) }
    if (view === "overview" || view === "sessions") return { path: `/${view}`, query: serviceQuery({ start: String(rangeStart(range)) }) }
    return { path: `/${view}`, query: serviceQuery({}) }
}

/**
 * Fetch the current view. `manual` (a click) shows the spinner on Refresh;
 * background refreshes never do, so the header stays still.
 */
async function refresh(manual = false): Promise<void> {
    const seq = ++fetchSeq
    const request = currentRequest()
    if (manual) refs?.refresh.update({ loading: true })
    try {
        const result = await host.serviceRequest({ method: "GET", path: request.path, query: request.query })
        if (seq !== fetchSeq) return
        if (result.status !== 200) {
            throw new Error(`stats service responded with HTTP ${result.status}`)
        }
        lastPayload = JSON.parse(result.body)
        lastPayloadKey = `${request.path}?${JSON.stringify(request.query)}`
        if (request.path !== "/locations") lastRefreshedAt = Date.now()
        notice = null
    } catch (error) {
        if (seq !== fetchSeq) return
        notice = describeError(error)
    } finally {
        if (seq === fetchSeq) {
            if (manual) refs?.refresh.update({ loading: false })
            render()
        } else if (manual) {
            // a newer request took over; it clears the spinner only if it is manual too
            refs?.refresh.update({ loading: false })
        }
    }
}

function describeError(error: unknown): Notice {
    if (error instanceof HostRequestError) {
        switch (error.code) {
            case "NO_SERVICE":
                return {
                    tone: "warning",
                    title: "Local service not approved",
                    body: "Open Settings → Extensions, select Squeez Stats, and allow its local service. Then retry.",
                }
            case "DISABLED":
                return { tone: "info", title: "Squeez Stats is paused", body: "Enable the extension in Settings → Extensions." }
            case "SERVICE_FAILED":
            case "HOST_TIMEOUT":
                return { tone: "error", title: "Stats service is not responding", body: "Retry, or restart OpenChamber if it keeps failing." }
            default:
                return { tone: "error", title: "Could not load stats", body: error.message }
        }
    }
    return { tone: "error", title: "Could not load stats", body: error instanceof Error ? error.message : String(error) }
}

/**
 * One timer, re-armed after each refresh, at the interval from settings.
 * Off when auto-refresh is off. Hidden pages and the settings form skip a
 * tick (no re-render under the user's typing).
 */
function schedulePoll(): void {
    if (pollTimer !== null) {
        window.clearTimeout(pollTimer)
        pollTimer = null
    }
    if (!settings.autoRefresh) return
    pollTimer = window.setTimeout(() => {
        pollTimer = null
        void (async () => {
            if (document.visibilityState === "visible" && view !== "settings") {
                // the status line has no settings form; pick up changes made in the panel
                if (surface === "status") await loadSettings()
                await refresh(false)
            }
            schedulePoll()
        })()
    }, settings.refreshSeconds * 1000)
}

let visibilityHooked = false

function startPolling(): void {
    schedulePoll()
    if (visibilityHooked) return
    visibilityHooked = true
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && settings.autoRefresh && view !== "settings") void refresh(false)
    })
}

// -------------------------------------------------------------------- render

function render(): void {
    if (surface === "status") renderStatus()
    else renderPanel(false)
}

/** Repaint the body; skipped when the payload did not change, so polling never jumps the scroll. */
function renderPanel(force: boolean): void {
    if (!refs) return
    renderNotice()
    syncChrome()
    // This lives outside the body diff: unchanged stats still get a fresh clock.
    refs.lastRefreshed.textContent = formatRefreshedAt(lastRefreshedAt)

    const { path, query } = currentRequest()
    const requestKey = `${path}?${JSON.stringify(query)}`
    const data = (requestKey === lastPayloadKey ? lastPayload : null) as { meta?: { available?: boolean; home?: string; lastEvent?: number | null; generatedAt?: number } } | null
    const meta = data?.meta
    const cadence = settings.autoRefresh ? `updates every ${refreshLabel(settings.refreshSeconds)}` : "auto-refresh off"
    refs.subtitle.textContent =
        view === "settings" ? "settings" : meta?.lastEvent ? `last activity ${formatAgo(meta.lastEvent)} · ${cadence}` : cadence

    const key = `${requestKey}|${JSON.stringify({ ...(data ?? {}), meta: { ...meta, generatedAt: 0, lastEvent: 0 } })}`
    if (!force && key === lastRenderedKey) return
    lastRenderedKey = key

    const body = refs.body
    const scrollTop = requestKey === lastRequestKey ? body.scrollTop : 0
    lastRequestKey = requestKey
    const content = el("div", "sq-content")

    if (!data) {
        if (!notice) content.appendChild(loadingFeedback(
            "Preparing your stats",
            "Waiting for the local service to find and read squeez’s history. A first load can take longer while the service starts and builds its cache. Nothing is uploaded.",
        ))
    } else if (path === "/locations") renderSettings(content, data as unknown as LocationsPayload)
    else if (meta && meta.available === false) {
        content.appendChild(
            note(`squeez's event logs were not found${meta.home ? ` (looked in ${meta.home})` : ""}. Is squeez installed? If it keeps its files elsewhere, choose them in Settings.`, "warning"),
        )
        const open = el("div", "sq-back")
        mountButton(open, { label: "Choose squeez's files…", variant: "default", size: "sm", onClick: openSettings })
        content.appendChild(open)
    } else if (path === "/overview") renderOverview(content, data as unknown as OverviewPayload)
    else if (path === "/sessions") renderSessions(content, data as unknown as SessionsPayload)
    else if (path === "/session") renderSessionDetail(content, data as unknown as SessionDetailPayload)
    else if (path === "/now") renderNow(content, data as unknown as NowPayload)
    else if (path === "/storage") renderStorage(content, data as unknown as StoragePayload)

    body.replaceChildren(content)
    body.scrollTop = scrollTop
}

function renderNotice(): void {
    if (!refs) return
    noticeHandle?.dispose()
    noticeHandle = null
    refs.notice.replaceChildren()
    if (!notice) return
    const showRetry = notice.tone === "error" || notice.tone === "warning"
    noticeHandle = mountBanner(refs.notice, {
        tone: notice.tone,
        title: notice.title,
        ...(notice.body ? { body: notice.body } : {}),
        ...(showRetry ? { action: { label: "Retry", onClick: () => void refresh(true) } } : {}),
    })
}

function renderStatus(): void {
    if (!statusRefs) return
    const { path, query } = currentRequest()
    const data = (`${path}?${JSON.stringify(query)}` === lastPayloadKey ? lastPayload : null) as StatusPayload | null
    statusRefs.sub.classList.remove("sq-status-error")
    statusRefs.badge.hidden = true

    if (notice) {
        statusRefs.main.textContent = "Squeez"
        statusRefs.sub.textContent = notice.title
        statusRefs.sub.classList.add("sq-status-error")
    } else if (!data) {
        statusRefs.main.textContent = "Squeez"
        statusRefs.sub.textContent = "Loading…"
    } else if (!data.meta.available) {
        statusRefs.main.textContent = "Squeez"
        statusRefs.sub.textContent = "squeez home not found"
        statusRefs.sub.classList.add("sq-status-error")
    } else if (data.shell.commands > 0) {
        statusRefs.main.textContent = `${formatTokens(data.shell.savedTokens)} tokens cut today`
        statusRefs.badge.hidden = false
        statusRefs.badge.textContent = `−${percent(data.shell.savedTokens, data.shell.inTokens)}`
        statusRefs.badge.title = "how much shorter shell output was, today"
        statusRefs.sub.textContent = `from ${plural(data.shell.commands, "shell command")} · ${plural(data.tools.calls, "tool output")} measured`
    } else {
        statusRefs.main.textContent = "No shell commands today"
        statusRefs.sub.textContent = `${plural(data.tools.calls, "tool output")} measured · squeez only shortens shell output`
    }
    syncStatusHeight()
}

function syncStatusHeight(): void {
    if (surface !== "status") return
    const node = root.firstElementChild
    if (!(node instanceof HTMLElement)) return
    const height = Math.ceil(node.scrollHeight)
    if (height <= 0 || height === lastStatusHeight) return
    lastStatusHeight = height
    void host.setHeight(height).catch(() => {})
}

// -------------------------------------------------------------------- format

function formatTokens(tokens: number): string {
    const value = Math.max(0, Math.round(tokens))
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}`.replace(/\.0$/, "") + "M"
    if (value >= 1000) return `${(value / 1000).toFixed(1)}`.replace(/\.0$/, "") + "K"
    return String(value)
}

function formatBytes(bytes: number): string {
    const value = Math.max(0, bytes)
    if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`
    if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
    return `${Math.round(value)} B`
}

/** part/whole as a whole-number percent; "0%" when whole is 0. */
function percent(part: number, whole: number): string {
    if (!(whole > 0)) return "0%"
    const p = (part / whole) * 100
    return `${p > 0 && p < 1 ? "<1" : Math.round(p)}%`
}

/** basis points (0..10000) as a percent */
function pct(basisPoints: number): string {
    return `${Math.round(basisPoints / 100)}%`
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function formatClock(ms: number): string {
    const d = new Date(ms)
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    const today = new Date()
    if (d.toDateString() === today.toDateString()) return `today ${time}`
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`
}

function formatSpan(from: number | null, to: number | null): string {
    if (!from || !to) return "—"
    return `${formatClock(from)} → ${formatClock(to)}`
}

function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return `${s} s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} min`
    const h = Math.floor(m / 60)
    if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
    const d = Math.floor(h / 24)
    return h % 24 ? `${d} d ${h % 24} h` : `${d} d`
}

function formatAgo(ms: number): string {
    const delta = Date.now() - ms
    if (delta < 60_000) return "just now"
    return `${formatDuration(delta)} ago`
}

function plural(n: number, noun: string): string {
    return `${count(n)} ${n === 1 ? noun : `${noun}s`}`
}

function count(n: number): string {
    return n.toLocaleString("en-US")
}

// -------------------------------------------------------------------- wiring

host.onReady((ctx: HostReadyContext) => {
    applyHostReady(ctx, document.documentElement)
    surface = ctx.surface === "status" ? "status" : "panel"
    if (mounted) {
        if (initialized) void refresh(false)
        return
    }
    mounted = true
    void initializeSurface({
        mount: () => {
            if (surface === "status") mountStatus()
            else mountPanel()
        },
        loadSettings,
        applySettings: () => {
            range = settings.defaultRange
            showEmptySessions = settings.showEmptySessions
            initialized = true
            refs?.rangeTabs.update({ activeId: range })
            syncChrome()
            render()
        },
        startPolling,
        refresh: () => refresh(false),
    })
})

host.onSessionLifecycle(() => {
    if (!initialized || view === "settings") return
    void (async () => {
        if (surface === "status") await loadSettings()
        await refresh(false)
    })()
})
