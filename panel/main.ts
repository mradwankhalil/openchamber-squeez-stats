/**
 * Squeez Stats — OpenChamber extension panel.
 *
 * One page serves two surfaces:
 *  - `panel`: the rail side panel with the full report.
 *  - `status`: the compact section in the chat's Work Status panel.
 *
 * The page is a thin view. The extension's local service reads the squeez
 * state files and returns the numbers; this file only renders them.
 * Charts are hand-rolled SVG/divs — no dependencies.
 */

import { connectHost, HostRequestError } from "@openchamber/sdk"
import type { HostReadyContext } from "@openchamber/sdk"
import { applyHostReady, mountBanner, mountButton } from "@openchamber/sdk/ui"
import type { BannerHandle, ButtonHandle } from "@openchamber/sdk/ui"
import type { AllTime, DayPoint, HandlerStat, LiveSession, StatsPayload } from "../service/stats"

const POLL_MS = 4000
const DAILY_WINDOW = 30
const TOP_HANDLERS = 8

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

type MetricRow = {
    label: string
    value: string
    tone?: "success"
}

let mounted = false
let surface: "panel" | "status" = "panel"
let payload: StatsPayload | null = null
let notice: Notice | null = null
let pollTimer: number | null = null
let fetchSeq = 0
let lastStatusHeight = -1

let refs: {
    subtitle: HTMLElement
    notice: HTMLElement
    liveMeta: HTMLElement
    liveMetrics: HTMLElement
    liveHint: HTMLElement
    allTimeMetrics: HTMLElement
    allTimeDonut: HTMLElement
    handlerBars: HTMLElement
    blobsMetrics: HTMLElement
    dailyChart: HTMLElement
    dailyMeta: HTMLElement
    refresh: ButtonHandle
} | null = null

let statusRefs: {
    saved: HTMLElement
    ratio: HTMLElement
    sub: HTMLElement
} | null = null

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

// -------------------------------------------------------------------- charts

/** Donut chart. Segments share 100% of the ring; center shows a label. */
function donut(
    segments: { label: string; value: number; className: string }[],
    centerValue: string,
    centerLabel: string,
): SVGSVGElement {
    const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0)
    const size = 120
    const stroke = 18
    const radius = (size - stroke) / 2
    const circumference = 2 * Math.PI * radius
    const svgNS = "http://www.w3.org/2000/svg"
    const svg = document.createElementNS(svgNS, "svg")
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`)
    svg.setAttribute("class", "sq-donut")

    const track = document.createElementNS(svgNS, "circle")
    track.setAttribute("cx", String(size / 2))
    track.setAttribute("cy", String(size / 2))
    track.setAttribute("r", String(radius))
    track.setAttribute("class", "sq-donut-track")
    track.setAttribute("stroke-width", String(stroke))
    track.setAttribute("fill", "none")
    svg.appendChild(track)

    if (total > 0) {
        let offset = 0
        for (const seg of segments) {
            const frac = Math.max(0, seg.value) / total
            if (frac <= 0) continue
            const arc = document.createElementNS(svgNS, "circle")
            arc.setAttribute("cx", String(size / 2))
            arc.setAttribute("cy", String(size / 2))
            arc.setAttribute("r", String(radius))
            arc.setAttribute("class", `sq-donut-seg ${seg.className}`)
            arc.setAttribute("stroke-width", String(stroke))
            arc.setAttribute("fill", "none")
            arc.setAttribute("stroke-dasharray", `${frac * circumference} ${circumference}`)
            arc.setAttribute("stroke-dashoffset", String(-offset * circumference))
            arc.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`)
            const title = document.createElementNS(svgNS, "title")
            title.textContent = `${seg.label}: ${(frac * 100).toFixed(1)}%`
            arc.appendChild(title)
            svg.appendChild(arc)
            offset += frac
        }
    }

    const valueText = document.createElementNS(svgNS, "text")
    valueText.setAttribute("x", String(size / 2))
    valueText.setAttribute("y", String(size / 2 - 2))
    valueText.setAttribute("class", "sq-donut-value")
    valueText.setAttribute("text-anchor", "middle")
    valueText.textContent = centerValue
    const labelText = document.createElementNS(svgNS, "text")
    labelText.setAttribute("x", String(size / 2))
    labelText.setAttribute("y", String(size / 2 + 14))
    labelText.setAttribute("class", "sq-donut-label")
    labelText.setAttribute("text-anchor", "middle")
    labelText.textContent = centerLabel
    svg.appendChild(valueText)
    svg.appendChild(labelText)
    return svg
}

function donutLegend(
    segments: { label: string; value: number; className: string }[],
    format: (value: number) => string,
): HTMLElement {
    const legend = el("div", "sq-legend")
    for (const seg of segments) {
        const row = el("div", "sq-legend-row")
        row.append(
            el("span", `sq-legend-dot ${seg.className}`),
            el("span", "sq-legend-label", seg.label),
            el("span", "sq-legend-value", format(seg.value)),
        )
        legend.appendChild(row)
    }
    return legend
}

/** Horizontal bar list for ranked data (top commands). */
function hbarChart(
    rows: { label: string; value: number; display: string }[],
): HTMLElement {
    const wrap = el("div", "sq-hbars")
    const max = rows.reduce((m, r) => Math.max(m, r.value), 0)
    for (const row of rows) {
        const item = el("div", "sq-hbar")
        const head = el("div", "sq-hbar-head")
        head.append(
            el("span", "sq-hbar-label", row.label),
            el("span", "sq-hbar-value", row.display),
        )
        const track = el("div", "sq-hbar-track")
        const fill = el("div", "sq-hbar-fill")
        fill.style.width = max > 0 ? `${Math.max(2, (row.value / max) * 100)}%` : "0%"
        track.appendChild(fill)
        item.append(head, track)
        wrap.appendChild(item)
    }
    return wrap
}

/** Column chart for the daily savings series. */
function columnChart(points: DayPoint[]): HTMLElement {
    const wrap = el("div", "sq-cols")
    const shown = points.slice(-DAILY_WINDOW)
    const max = shown.reduce((m, p) => Math.max(m, p.savedTokens), 0)
    const svgNS = "http://www.w3.org/2000/svg"
    const svg = document.createElementNS(svgNS, "svg")
    svg.setAttribute("class", "sq-cols-svg")
    const width = Math.max(120, shown.length * 14)
    const height = 72
    const barWidth = 10
    svg.setAttribute("viewBox", `0 0 ${width} ${height + 16}`)
    svg.setAttribute("preserveAspectRatio", "none")

    shown.forEach((point, i) => {
        const frac = max > 0 ? point.savedTokens / max : 0
        const barHeight = Math.max(point.savedTokens > 0 ? 2 : 0, frac * (height - 6))
        const rect = document.createElementNS(svgNS, "rect")
        rect.setAttribute("x", String(i * 14 + 2))
        rect.setAttribute("y", String(height - barHeight))
        rect.setAttribute("width", String(barWidth))
        rect.setAttribute("height", String(barHeight))
        rect.setAttribute("rx", "2")
        rect.setAttribute("class", "sq-col")
        const title = document.createElementNS(svgNS, "title")
        title.textContent = `${point.day}: ~${formatTokens(point.savedTokens)} saved · ${plural(point.events, "event")}`
        rect.appendChild(title)
        svg.appendChild(rect)
    })

    const labelIndices = [...new Set([0, Math.floor((shown.length - 1) / 2), shown.length - 1])]
    for (const i of labelIndices) {
        const point = shown[i]
        if (!point) continue
        const text = document.createElementNS(svgNS, "text")
        text.setAttribute("x", String(i * 14 + 2))
        text.setAttribute("y", String(height + 12))
        text.setAttribute("class", "sq-col-label")
        text.textContent = point.day.slice(5)
        svg.appendChild(text)
    }

    wrap.appendChild(svg)
    return wrap
}

// -------------------------------------------------------------------- mounting

function section(title: string): { sectionEl: HTMLElement; meta: HTMLElement } {
    const sectionEl = el("section", "sq-section")
    const header = el("div", "sq-section-header")
    const meta = el("span", "sq-section-meta", "")
    header.append(el("span", undefined, title), meta)
    sectionEl.appendChild(header)
    return { sectionEl, meta }
}

function mountPanel(): void {
    const panel = el("div", "sq sq-panel")

    const header = el("div", "sq-header")
    const heading = el("div", "sq-heading")
    const title = el("div", "sq-title", "Squeez")
    const subtitle = el("div", "sq-subtitle", "")
    heading.append(title, subtitle)
    const actions = el("div", "sq-actions")
    const refresh = mountButton(actions, {
        label: "Refresh",
        variant: "ghost",
        size: "xs",
        onClick: () => void refreshStats(),
    })
    header.append(heading, actions)

    const noticeEl = el("div", "sq-notice")
    const body = el("div", "sq-body")

    // Live session
    const live = section("Live session")
    const liveMetrics = el("div", "sq-metrics")
    const liveHint = el("div", "sq-hint")
    live.sectionEl.append(liveMetrics, liveHint)

    // All-time
    const allTime = section("All-time")
    const allTimeMetrics = el("div", "sq-metrics")
    const allTimeDonut = el("div", "sq-chart")
    const handlerBars = el("div", "sq-subsection")
    allTime.sectionEl.append(allTimeMetrics, allTimeDonut, handlerBars)

    // Blob store
    const blobs = section("Blob store")
    const blobsMetrics = el("div", "sq-metrics")
    blobs.sectionEl.appendChild(blobsMetrics)

    // Daily series
    const daily = section("Tokens saved per day")
    const dailyChart = el("div", "sq-chart")
    daily.sectionEl.appendChild(dailyChart)

    body.append(live.sectionEl, allTime.sectionEl, blobs.sectionEl, daily.sectionEl)
    panel.append(header, noticeEl, body)
    root.replaceChildren(panel)

    refs = {
        subtitle,
        notice: noticeEl,
        liveMeta: live.meta,
        liveMetrics,
        liveHint,
        allTimeMetrics,
        allTimeDonut,
        handlerBars,
        blobsMetrics,
        dailyChart,
        dailyMeta: daily.meta,
        refresh,
    }
}

function mountStatus(): void {
    const status = el("div", "sq sq-status")
    const main = el("div", "sq-status-main")
    const saved = el("span", "sq-status-saved", "Squeez")
    const ratio = el("span", "sq-status-ratio")
    ratio.hidden = true
    main.append(saved, ratio)
    const sub = el("div", "sq-status-sub", "")
    status.append(main, sub)
    root.replaceChildren(status)
    statusRefs = { saved, ratio, sub }
}

// -------------------------------------------------------------------- fetching

async function refreshStats(): Promise<void> {
    const seq = ++fetchSeq
    refs?.refresh.update({ loading: true })
    try {
        const result = await host.serviceRequest({ method: "GET", path: "/stats" })
        if (seq !== fetchSeq) return
        if (result.status !== 200) {
            throw new Error(`stats service responded with HTTP ${result.status}`)
        }
        payload = JSON.parse(result.body) as StatsPayload
        notice = null
    } catch (error) {
        if (seq !== fetchSeq) return
        notice = describeError(error)
    } finally {
        if (seq === fetchSeq) {
            refs?.refresh.update({ loading: false })
            render()
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
                return {
                    tone: "info",
                    title: "Squeez Stats is paused",
                    body: "Enable the extension in Settings → Extensions.",
                }
            case "SERVICE_FAILED":
            case "HOST_TIMEOUT":
                return {
                    tone: "error",
                    title: "Stats service is not responding",
                    body: "Retry, or restart OpenChamber if it keeps failing.",
                }
            default:
                return { tone: "error", title: "Could not load stats", body: error.message }
        }
    }
    return {
        tone: "error",
        title: "Could not load stats",
        body: error instanceof Error ? error.message : String(error),
    }
}

function startPolling(): void {
    if (pollTimer !== null) return
    pollTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") void refreshStats()
    }, POLL_MS)
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void refreshStats()
    })
}

// -------------------------------------------------------------------- render

function render(): void {
    if (surface === "status") {
        renderStatus()
        return
    }
    if (!refs) return

    refs.subtitle.textContent = "squeez compression savings"
    renderNotice()

    const live = payload?.live ?? null
    const allTime = payload?.allTime ?? null
    const daily = payload?.daily ?? []
    const blobs = payload?.blobs ?? null

    // ---- live
    refs.liveMeta.textContent = live ? live.sessionFile.replace(/\.jsonl$/, "") : ""
    renderMetrics(refs.liveMetrics, live ? liveRows(live) : [])
    setHint(refs.liveHint, liveHintContent(live))

    // ---- all-time
    renderMetrics(refs.allTimeMetrics, allTime ? allTimeRows(allTime) : [])
    renderTokenDonut(refs.allTimeDonut, allTime)
    renderHandlerBars(refs.handlerBars, allTime?.handlers ?? [])

    // ---- blobs
    renderMetrics(
        refs.blobsMetrics,
        blobs
            ? [
                  { label: "Stashed outputs", value: String(blobs.count) },
                  { label: "Size on disk", value: formatBytes(blobs.bytes) },
              ]
            : [],
    )

    // ---- daily
    refs.dailyMeta.textContent =
        daily.length > 0 ? `last ${Math.min(daily.length, DAILY_WINDOW)} of ${plural(daily.length, "day")}` : ""
    refs.dailyChart.replaceChildren()
    if (daily.length > 0) refs.dailyChart.appendChild(columnChart(daily))
    else refs.dailyChart.hidden = true
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
        ...(showRetry ? { action: { label: "Retry", onClick: () => void refreshStats() } } : {}),
    })
}

function renderStatus(): void {
    if (!statusRefs) return
    const live = payload?.live ?? null
    const allTime = payload?.allTime ?? null

    if (notice) {
        statusRefs.saved.textContent = "Squeez"
        statusRefs.ratio.hidden = true
        statusRefs.sub.textContent = notice.title
        statusRefs.sub.classList.add("sq-status-error")
    } else if (payload?.reason === "storage-missing") {
        statusRefs.saved.textContent = "Squeez"
        statusRefs.ratio.hidden = true
        statusRefs.sub.textContent = "squeez home not found"
        statusRefs.sub.classList.add("sq-status-error")
    } else if (allTime) {
        statusRefs.saved.textContent = `~${formatTokens(allTime.savedTokens)} tokens saved`
        statusRefs.ratio.hidden = false
        statusRefs.ratio.textContent = formatRatio(allTime.inTokens, allTime.outTokens)
        const bits: string[] = [plural(allTime.totalCalls, "call")]
        if (live) bits.push(`session ~${formatTokens(Math.max(0, live.inTokens - live.outTokens))}`)
        statusRefs.sub.textContent = bits.join(" · ")
        statusRefs.sub.classList.remove("sq-status-error")
    } else {
        statusRefs.saved.textContent = "Squeez"
        statusRefs.ratio.hidden = true
        statusRefs.sub.textContent = "No stats recorded yet"
        statusRefs.sub.classList.remove("sq-status-error")
    }

    syncStatusHeight()
}

function renderMetrics(container: HTMLElement, rows: MetricRow[]): void {
    container.replaceChildren(
        ...rows.map((row) => {
            const item = el("div", "sq-metric")
            const label = el("span", "sq-metric-label", row.label)
            const value = el("span", "sq-metric-value", row.value)
            if (row.tone) value.dataset.tone = row.tone
            item.append(label, value)
            return item
        }),
    )
    container.hidden = rows.length === 0
}

function renderTokenDonut(container: HTMLElement, allTime: AllTime | null): void {
    container.replaceChildren()
    if (!allTime || allTime.inTokens <= 0) {
        container.hidden = true
        return
    }
    container.hidden = false
    const segments = [
        { label: "Kept after compression", value: allTime.outTokens, className: "sq-seg-kept" },
        { label: "Squeezed away", value: allTime.savedTokens, className: "sq-seg-saved" },
    ]
    const pct = Math.round((allTime.savedTokens / allTime.inTokens) * 100)
    const chart = el("div", "sq-donut-wrap")
    chart.appendChild(donut(segments, `${pct}%`, "squeezed"))
    chart.appendChild(donutLegend(segments, (v) => `~${formatTokens(v)} tok`))
    container.appendChild(chart)
}

function renderHandlerBars(container: HTMLElement, handlers: HandlerStat[]): void {
    container.replaceChildren()
    const top = handlers.filter((h) => h.savedTokens > 0).slice(0, TOP_HANDLERS)
    if (top.length === 0) {
        container.hidden = true
        return
    }
    container.hidden = false
    container.appendChild(el("div", "sq-subsection-title", "Top commands by tokens saved"))
    container.appendChild(
        hbarChart(
            top.map((h) => ({
                label: h.name,
                value: h.savedTokens,
                display: `~${formatTokens(h.savedTokens)} · ${plural(h.calls, "call")}`,
            })),
        ),
    )
}

function liveHintContent(live: LiveSession | null): (Node | string)[] | null {
    if (payload === null) return ["Loading stats…"]
    if (payload.reason === "storage-missing") {
        return [
            "squeez home not found: ",
            el("code", undefined, payload.squeezHome),
            ". If squeez lives elsewhere, set SQUEEZ_STATS_HOME for the service.",
        ]
    }
    if (!live) return ["No live squeez session. Stats appear once squeez tracks a command."]
    return null
}

function setHint(node: HTMLElement, content: (Node | string)[] | null): void {
    if (!content || content.length === 0) {
        node.hidden = true
        node.replaceChildren()
        return
    }
    node.hidden = false
    node.replaceChildren(...content)
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

// -------------------------------------------------------------------- rows

function liveRows(live: LiveSession): MetricRow[] {
    const saved = Math.max(0, live.inTokens - live.outTokens)
    return [
        { label: "Session file", value: live.sessionFile || "—" },
        { label: "Events tracked", value: String(live.events) },
        { label: "Tokens in|out", value: `~${formatTokens(live.inTokens)} | ~${formatTokens(live.outTokens)}` },
        { label: "Saved this session", value: `~${formatTokens(saved)}`, tone: "success" },
        { label: "Ratio", value: formatRatio(live.inTokens, live.outTokens) },
        { label: "Session tokens", value: `~${formatTokens(live.totalTokens)}` },
        { label: "Overhead tokens", value: `~${formatTokens(live.overheadTokens)}` },
        { label: "Started", value: formatStarted(live.startedAt) },
    ]
}

function allTimeRows(allTime: AllTime): MetricRow[] {
    return [
        { label: "Tokens saved", value: `~${formatTokens(allTime.savedTokens)}`, tone: "success" },
        { label: "Ratio", value: formatRatio(allTime.inTokens, allTime.outTokens) },
        { label: "Tokens in|out", value: `~${formatTokens(allTime.inTokens)} | ~${formatTokens(allTime.outTokens)}` },
        { label: "Commands tracked", value: String(allTime.totalCalls) },
        { label: "Events", value: String(allTime.events) },
        { label: "Session logs", value: String(allTime.sessionFiles) },
    ]
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

function formatRatio(inputTokens: number, outputTokens: number): string {
    if (inputTokens <= 0) return "0:1"
    if (outputTokens <= 0) return "∞:1"
    return `${(inputTokens / outputTokens).toFixed(1)}:1`
}

function formatStarted(timestamp: number): string {
    if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return "—"
    const delta = Date.now() - timestamp
    if (delta < 60_000) return "just now"
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

function plural(count: number, noun: string): string {
    return count === 1 ? `1 ${noun}` : `${count} ${noun}s`
}

// -------------------------------------------------------------------- wiring

host.onReady((ctx: HostReadyContext) => {
    applyHostReady(ctx, document.documentElement)
    surface = ctx.surface === "status" ? "status" : "panel"
    if (!mounted) {
        mounted = true
        if (surface === "status") mountStatus()
        else mountPanel()
        startPolling()
    }
    void refreshStats()
})

host.onSessionLifecycle(() => {
    void refreshStats()
})
