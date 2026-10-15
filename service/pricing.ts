/**
 * Pricing engine — replaces context-mode's flat $5/1M estimate with rates
 * from models.dev weighted by the models the user actually ran.
 *
 * Data sources:
 *  - Model mix: OpenCode's `opencode.db` (read-only). The session tables
 *    carry per-session model refs and real token usage; the mix for a time
 *    window is weighted by input-side tokens (input + cache read), because
 *    kept-out bytes would have been prompt tokens.
 *  - Rates: https://models.dev/api.json, cached on disk for 24 h.
 *
 * Saved tokens are prompt-side, so the value is a range:
 *   min  = every saved token would have been billed at cache-read rate
 *   max  = every saved token would have been billed at full input rate
 * Truth sits between; the panel shows the range.
 *
 * Everything is best-effort: no db, no network, no match → null, and the
 * caller simply omits dollar figures. Never throws.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"

const MODELS_DEV_URL = "https://models.dev/api.json"
const RATES_TTL_MS = 24 * 3600_000
const MIX_TTL_MS = 5 * 60_000

// ------------------------------------------------------------------ types

export interface ModelMixEntry {
    /** e.g. "kimi-for-coding/k3-256k" */
    key: string
    provider: string
    model: string
    /** input-side tokens (input + cache.read) in the window */
    weight: number
    /** weight / total weight, 0..1 */
    share: number
    /** models.dev rate per 1M input tokens, null when unmatched */
    inputRate: number | null
    /** models.dev rate per 1M cache-read tokens, null when unmatched */
    cacheRate: number | null
    /** matched models.dev id, null when unmatched */
    matched: string | null
}

export interface PricingResult {
    /** tokensSaved priced at cache-read rates (lower bound) */
    dollarsMin: number
    /** tokensSaved priced at full input rates (upper bound) */
    dollarsMax: number
    /** share of the mix weight that matched a models.dev rate, 0..1 */
    coverage: number
    mix: ModelMixEntry[]
    /** window the mix was computed over (ms epoch) */
    windowStart: number
    windowEnd: number
}

interface RateEntry {
    id: string
    tokens: Set<string>
    inputRate: number
    cacheRate: number | null
}

// ------------------------------------------------------------- normalizing

const DROP_TOKENS = new Set([
    "latest", "preview", "thinking", "instruct", "chat", "the",
])

function tokenize(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length >= 2 && !DROP_TOKENS.has(t)),
    )
}

function scoreOverlap(a: Set<string>, b: Set<string>): number {
    let score = 0
    for (const t of a) if (b.has(t)) score += t.length > 3 ? 2 : 1
    return score
}

/** Parse the session table's `model` column: JSON {"id","providerID"} or bare text. */
function parseModelRef(raw: unknown): { provider: string; model: string } | null {
    if (typeof raw !== "string" || !raw.trim()) return null
    const text = raw.trim()
    if (text.startsWith("{")) {
        try {
            const parsed: unknown = JSON.parse(text)
            if (typeof parsed === "object" && parsed !== null) {
                const o = parsed as { id?: unknown; providerID?: unknown }
                if (typeof o.id === "string" && o.id) {
                    return { provider: typeof o.providerID === "string" ? o.providerID : "", model: o.id }
                }
            }
        } catch {
            // fall through
        }
        return null
    }
    const slash = text.indexOf("/")
    return slash > 0
        ? { provider: text.slice(0, slash), model: text.slice(slash + 1) }
        : { provider: "", model: text }
}

/** Digit runs of a model id, e.g. "claude-opus-5-5" -> ["5","5"], "k3-256k" -> ["3","256"]. */
function versionRuns(text: string): string[] {
    return text.match(/\d+/g) ?? []
}

// ------------------------------------------------------------------ engine

export class PricingEngine {
    private readonly cacheFile: string
    private readonly dbPaths: string[]
    private rates: RateEntry[] | null = null
    private ratesLoadedAt = 0
    private mixCache = new Map<string, { at: number; mix: ModelMixEntry[] }>()

    constructor(opts?: { cacheFile?: string; dbPaths?: string[] }) {
        const home = os.homedir()
        this.cacheFile =
            opts?.cacheFile ??
            process.env.STATS_PRICING_CACHE ??
            path.join(home, ".config", "openchamber", "squeez-stats-pricing.json")
        const xdgData = process.env.XDG_DATA_HOME
        this.dbPaths = opts?.dbPaths ?? [
            ...(process.env.OPENCODE_DB_PATH ? [process.env.OPENCODE_DB_PATH] : []),
            ...(xdgData && xdgData.trim()
                ? [path.join(xdgData.trim(), "opencode", "opencode.db")]
                : []),
            path.join(home, ".local", "share", "opencode", "opencode.db"),
            path.join(home, ".opencode-v2", "data", "opencode.db"),
        ]
    }

    /** Price `tokensSaved` over the given window. Null when nothing priceable. */
    async price(
        windowStart: number,
        windowEnd: number,
        tokensSaved: number,
    ): Promise<PricingResult | null> {
        try {
            if (!(tokensSaved > 0)) return null
            const mix = await this.getMix(windowStart, windowEnd)
            if (mix.length === 0) return null
            await this.loadRates()
            const priced = this.applyRates(mix)
            const totalWeight = priced.reduce((s, m) => s + m.weight, 0)
            if (totalWeight <= 0) return null
            let weightedInput = 0
            let weightedCache = 0
            let coveredWeight = 0
            for (const m of priced) {
                if (m.inputRate === null) continue
                coveredWeight += m.weight
                weightedInput += m.share * m.inputRate
                weightedCache += m.share * (m.cacheRate ?? m.inputRate)
            }
            if (coveredWeight <= 0) return null
            const coverage = coveredWeight / totalWeight
            // scale weighted rates up to full coverage so unmatched models
            // don't silently shrink the estimate
            const scale = 1 / coverage
            return {
                dollarsMin: (tokensSaved / 1e6) * weightedCache * scale,
                dollarsMax: (tokensSaved / 1e6) * weightedInput * scale,
                coverage,
                mix: priced,
                windowStart,
                windowEnd,
            }
        } catch {
            return null
        }
    }

    // ---- model mix from opencode.db --------------------------------------

    private async getMix(windowStart: number, windowEnd: number): Promise<ModelMixEntry[]> {
        const cacheKey = `${Math.floor(windowStart / 60000)}:${Math.floor(windowEnd / 60000)}`
        const cached = this.mixCache.get(cacheKey)
        if (cached && Date.now() - cached.at < MIX_TTL_MS) return cached.mix

        const dbPath = await this.freshestDb()
        if (!dbPath) return []
        const mix = this.queryMix(dbPath, windowStart, windowEnd)
        this.mixCache.set(cacheKey, { at: Date.now(), mix })
        return mix
    }

    private async freshestDb(): Promise<string | null> {
        let best: string | null = null
        let bestMtime = -1
        for (const p of this.dbPaths) {
            try {
                const stat = await fs.stat(p)
                if (stat.isFile() && stat.mtimeMs > bestMtime) {
                    bestMtime = stat.mtimeMs
                    best = p
                }
            } catch {
                // not present — skip
            }
        }
        return best
    }

    private queryMix(dbPath: string, startMs: number, endMs: number): ModelMixEntry[] {
        let db: DatabaseSync | null = null
        try {
            db = new DatabaseSync(dbPath, { readOnly: true })
            // Session tables carry per-session model + token aggregates.
            // session_v2 is written by OpenCode 2.x; session is the 1.x legacy.
            const tables = (
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session')",
                    )
                    .all() as { name: unknown }[]
            )
                .map((r) => r.name)
                .filter((n): n is string => typeof n === "string")
            const byKey = new Map<string, ModelMixEntry>()
            const seenIds = new Set<string>()
            for (const table of ["session_v2", "session"]) {
                if (!tables.includes(table)) continue
                const rows = db
                    .prepare(
                        `SELECT id, model, tokens_input, tokens_cache_read
                         FROM ${table}
                         WHERE time_created <= ? AND time_updated >= ?`,
                    )
                    .all(endMs, startMs) as {
                    id: unknown
                    model: unknown
                    tokens_input: unknown
                    tokens_cache_read: unknown
                }[]
                for (const row of rows) {
                    if (typeof row.id === "string") {
                        if (seenIds.has(row.id)) continue
                        seenIds.add(row.id)
                    }
                    const weight =
                        (typeof row.tokens_input === "number" ? row.tokens_input : 0) +
                        (typeof row.tokens_cache_read === "number" ? row.tokens_cache_read : 0)
                    if (!(weight > 0)) continue
                    const ref = parseModelRef(row.model)
                    if (!ref) continue
                    const key = ref.provider ? `${ref.provider}/${ref.model}` : ref.model
                    const existing = byKey.get(key)
                    if (existing) {
                        existing.weight += weight
                    } else {
                        byKey.set(key, {
                            key,
                            provider: ref.provider,
                            model: ref.model,
                            weight,
                            share: 0,
                            inputRate: null,
                            cacheRate: null,
                            matched: null,
                        })
                    }
                }
            }
            const entries = [...byKey.values()]
            const total = entries.reduce((sum, e) => sum + e.weight, 0)
            for (const e of entries) e.share = total > 0 ? e.weight / total : 0
            entries.sort((a, b) => b.weight - a.weight)
            return entries
        } catch {
            return []
        } finally {
            try {
                db?.close()
            } catch {
                // ignore
            }
        }
    }

    // ---- rates from models.dev -------------------------------------------

    private async loadRates(): Promise<void> {
        if (this.rates && Date.now() - this.ratesLoadedAt < RATES_TTL_MS) return

        // disk cache first
        try {
            const stat = await fs.stat(this.cacheFile)
            if (Date.now() - stat.mtimeMs < RATES_TTL_MS) {
                const raw: unknown = JSON.parse(await fs.readFile(this.cacheFile, "utf8"))
                const parsed = this.parseRates(raw)
                if (parsed.length > 0) {
                    this.rates = parsed
                    this.ratesLoadedAt = Date.now()
                    return
                }
            }
        } catch {
            // no usable cache — fetch
        }

        const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(20_000) })
        if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
        const raw: unknown = await res.json()
        const parsed = this.parseRates(raw)
        if (parsed.length === 0) throw new Error("models.dev payload had no priced models")
        this.rates = parsed
        this.ratesLoadedAt = Date.now()
        try {
            await fs.mkdir(path.dirname(this.cacheFile), { recursive: true })
            const tmp = `${this.cacheFile}.tmp`
            await fs.writeFile(tmp, JSON.stringify(raw))
            await fs.rename(tmp, this.cacheFile)
        } catch {
            // cache write failure is non-fatal
        }
    }

    private parseRates(raw: unknown): RateEntry[] {
        if (typeof raw !== "object" || raw === null) return []
        const out: RateEntry[] = []
        for (const [providerId, provider] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof provider !== "object" || provider === null) continue
            const models = (provider as { models?: unknown }).models
            if (typeof models !== "object" || models === null) continue
            for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
                if (typeof model !== "object" || model === null) continue
                const m = model as { name?: unknown; cost?: unknown }
                const cost = m.cost as { input?: unknown; cache_read?: unknown } | undefined
                const inputRate = typeof cost?.input === "number" ? cost.input : null
                if (inputRate === null || !(inputRate > 0)) continue
                const cacheRate =
                    typeof cost?.cache_read === "number" && cost.cache_read > 0
                        ? cost.cache_read
                        : null
                out.push({
                    id: `${providerId}/${modelId}`,
                    tokens: tokenize(`${providerId} ${modelId} ${typeof m.name === "string" ? m.name : ""}`),
                    inputRate,
                    cacheRate,
                })
            }
        }
        return out
    }

    // ---- matching ---------------------------------------------------------

    private applyRates(mix: ModelMixEntry[]): ModelMixEntry[] {
        if (!this.rates) return mix
        for (const entry of mix) {
            const want = tokenize(`${entry.model} ${entry.provider}`)
            const wantVersions = versionRuns(entry.model)
            let best: RateEntry | null = null
            let bestScore = 0
            for (const rate of this.rates) {
                let score = scoreOverlap(want, rate.tokens)
                // version awareness: same major version reinforces, a
                // different major version disqualifies (opus-5-5 != opus-4-5)
                const rateVersions = versionRuns(rate.id)
                if (wantVersions.length > 0 && rateVersions.length > 0) {
                    if (wantVersions[0] === rateVersions[0]) {
                        score += 2
                        if (wantVersions.length > 1 && wantVersions[1] === rateVersions[1]) score += 1
                    } else {
                        score -= 3
                    }
                }
                if (score > bestScore) {
                    bestScore = score
                    best = rate
                }
            }
            // require at least one distinctive (>3 char) token match
            if (best && bestScore >= 2) {
                entry.inputRate = best.inputRate
                entry.cacheRate = best.cacheRate
                entry.matched = best.id
            }
        }
        return mix
    }
}
