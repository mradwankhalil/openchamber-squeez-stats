// service/main.ts
import http from "node:http";

// service/stats.ts
import * as fs2 from "node:fs/promises";
import * as os2 from "node:os";
import * as path2 from "node:path";

// service/pricing.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
var MODELS_DEV_URL = "https://models.dev/api.json";
var RATES_TTL_MS = 24 * 3600000;
var MIX_TTL_MS = 5 * 60000;
var DROP_TOKENS = new Set([
  "latest",
  "preview",
  "thinking",
  "instruct",
  "chat",
  "the"
]);
function tokenize(text) {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !DROP_TOKENS.has(t)));
}
function scoreOverlap(a, b) {
  let score = 0;
  for (const t of a)
    if (b.has(t))
      score += t.length > 3 ? 2 : 1;
  return score;
}
function parseModelRef(raw) {
  if (typeof raw !== "string" || !raw.trim())
    return null;
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        const o = parsed;
        if (typeof o.id === "string" && o.id) {
          return { provider: typeof o.providerID === "string" ? o.providerID : "", model: o.id };
        }
      }
    } catch {}
    return null;
  }
  const slash = text.indexOf("/");
  return slash > 0 ? { provider: text.slice(0, slash), model: text.slice(slash + 1) } : { provider: "", model: text };
}
function versionRuns(text) {
  return text.match(/\d+/g) ?? [];
}

class PricingEngine {
  cacheFile;
  dbPaths;
  rates = null;
  ratesLoadedAt = 0;
  mixCache = new Map;
  constructor(opts) {
    const home = os.homedir();
    this.cacheFile = opts?.cacheFile ?? process.env.STATS_PRICING_CACHE ?? path.join(home, ".config", "openchamber", "squeez-stats-pricing.json");
    const xdgData = process.env.XDG_DATA_HOME;
    this.dbPaths = opts?.dbPaths ?? [
      ...process.env.OPENCODE_DB_PATH ? [process.env.OPENCODE_DB_PATH] : [],
      ...xdgData && xdgData.trim() ? [path.join(xdgData.trim(), "opencode", "opencode.db")] : [],
      path.join(home, ".local", "share", "opencode", "opencode.db"),
      path.join(home, ".opencode-v2", "data", "opencode.db")
    ];
  }
  async price(windowStart, windowEnd, tokensSaved) {
    try {
      if (!(tokensSaved > 0))
        return null;
      const mix = await this.getMix(windowStart, windowEnd);
      if (mix.length === 0)
        return null;
      await this.loadRates();
      const priced = this.applyRates(mix);
      const totalWeight = priced.reduce((s, m) => s + m.weight, 0);
      if (totalWeight <= 0)
        return null;
      let weightedInput = 0;
      let weightedCache = 0;
      let coveredWeight = 0;
      for (const m of priced) {
        if (m.inputRate === null)
          continue;
        coveredWeight += m.weight;
        weightedInput += m.share * m.inputRate;
        weightedCache += m.share * (m.cacheRate ?? m.inputRate);
      }
      if (coveredWeight <= 0)
        return null;
      const coverage = coveredWeight / totalWeight;
      const scale = 1 / coverage;
      return {
        dollarsMin: tokensSaved / 1e6 * weightedCache * scale,
        dollarsMax: tokensSaved / 1e6 * weightedInput * scale,
        coverage,
        mix: priced,
        windowStart,
        windowEnd
      };
    } catch {
      return null;
    }
  }
  async getMix(windowStart, windowEnd) {
    const cacheKey = `${Math.floor(windowStart / 60000)}:${Math.floor(windowEnd / 60000)}`;
    const cached = this.mixCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MIX_TTL_MS)
      return cached.mix;
    const dbPath = await this.freshestDb();
    if (!dbPath)
      return [];
    const mix = this.queryMix(dbPath, windowStart, windowEnd);
    this.mixCache.set(cacheKey, { at: Date.now(), mix });
    return mix;
  }
  async freshestDb() {
    let best = null;
    let bestMtime = -1;
    for (const p of this.dbPaths) {
      try {
        const stat2 = await fs.stat(p);
        if (stat2.isFile() && stat2.mtimeMs > bestMtime) {
          bestMtime = stat2.mtimeMs;
          best = p;
        }
      } catch {}
    }
    return best;
  }
  queryMix(dbPath, startMs, endMs) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session')").all().map((r) => r.name).filter((n) => typeof n === "string");
      const byKey = new Map;
      const seenIds = new Set;
      for (const table of ["session_v2", "session"]) {
        if (!tables.includes(table))
          continue;
        const rows = db.prepare(`SELECT id, model, tokens_input, tokens_cache_read
                         FROM ${table}
                         WHERE time_created <= ? AND time_updated >= ?`).all(endMs, startMs);
        for (const row of rows) {
          if (typeof row.id === "string") {
            if (seenIds.has(row.id))
              continue;
            seenIds.add(row.id);
          }
          const weight = (typeof row.tokens_input === "number" ? row.tokens_input : 0) + (typeof row.tokens_cache_read === "number" ? row.tokens_cache_read : 0);
          if (!(weight > 0))
            continue;
          const ref = parseModelRef(row.model);
          if (!ref)
            continue;
          const key = ref.provider ? `${ref.provider}/${ref.model}` : ref.model;
          const existing = byKey.get(key);
          if (existing) {
            existing.weight += weight;
          } else {
            byKey.set(key, {
              key,
              provider: ref.provider,
              model: ref.model,
              weight,
              share: 0,
              inputRate: null,
              cacheRate: null,
              matched: null
            });
          }
        }
      }
      const entries = [...byKey.values()];
      const total = entries.reduce((sum, e) => sum + e.weight, 0);
      for (const e of entries)
        e.share = total > 0 ? e.weight / total : 0;
      entries.sort((a, b) => b.weight - a.weight);
      return entries;
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  async loadRates() {
    if (this.rates && Date.now() - this.ratesLoadedAt < RATES_TTL_MS)
      return;
    try {
      const stat2 = await fs.stat(this.cacheFile);
      if (Date.now() - stat2.mtimeMs < RATES_TTL_MS) {
        const raw2 = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
        const parsed2 = this.parseRates(raw2);
        if (parsed2.length > 0) {
          this.rates = parsed2;
          this.ratesLoadedAt = Date.now();
          return;
        }
      }
    } catch {}
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok)
      throw new Error(`models.dev HTTP ${res.status}`);
    const raw = await res.json();
    const parsed = this.parseRates(raw);
    if (parsed.length === 0)
      throw new Error("models.dev payload had no priced models");
    this.rates = parsed;
    this.ratesLoadedAt = Date.now();
    try {
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(raw));
      await fs.rename(tmp, this.cacheFile);
    } catch {}
  }
  parseRates(raw) {
    if (typeof raw !== "object" || raw === null)
      return [];
    const out = [];
    for (const [providerId, provider] of Object.entries(raw)) {
      if (typeof provider !== "object" || provider === null)
        continue;
      const models = provider.models;
      if (typeof models !== "object" || models === null)
        continue;
      for (const [modelId, model] of Object.entries(models)) {
        if (typeof model !== "object" || model === null)
          continue;
        const m = model;
        const cost = m.cost;
        const inputRate = typeof cost?.input === "number" ? cost.input : null;
        if (inputRate === null || !(inputRate > 0))
          continue;
        const cacheRate = typeof cost?.cache_read === "number" && cost.cache_read > 0 ? cost.cache_read : null;
        out.push({
          id: `${providerId}/${modelId}`,
          tokens: tokenize(`${providerId} ${modelId} ${typeof m.name === "string" ? m.name : ""}`),
          inputRate,
          cacheRate
        });
      }
    }
    return out;
  }
  applyRates(mix) {
    if (!this.rates)
      return mix;
    for (const entry of mix) {
      const want = tokenize(`${entry.model} ${entry.provider}`);
      const wantVersions = versionRuns(entry.model);
      let best = null;
      let bestScore = 0;
      for (const rate of this.rates) {
        let score = scoreOverlap(want, rate.tokens);
        const rateVersions = versionRuns(rate.id);
        if (wantVersions.length > 0 && rateVersions.length > 0) {
          if (wantVersions[0] === rateVersions[0]) {
            score += 2;
            if (wantVersions.length > 1 && wantVersions[1] === rateVersions[1])
              score += 1;
          } else {
            score -= 3;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          best = rate;
        }
      }
      if (best && bestScore >= 2) {
        entry.inputRate = best.inputRate;
        entry.cacheRate = best.cacheRate;
        entry.matched = best.id;
      }
    }
    return mix;
  }
}

// service/stats.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function str(value) {
  return typeof value === "string" ? value : "";
}
function resolveSqueezHome() {
  const override = process.env.SQUEEZ_STATS_HOME;
  if (override && override.trim())
    return override.trim();
  return path2.join(os2.homedir(), ".claude", "squeez");
}
function bashCommandName(cmd) {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.length > 24 ? `${base.slice(0, 24)}…` : base || "bash";
}
function parseEvent(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw))
    return null;
  const type = str(raw.type);
  const ts = num(raw.ts) * 1000;
  if (type === "bash") {
    return {
      kind: "bash",
      name: bashCommandName(str(raw.cmd)),
      inTokens: num(raw.in_tk),
      outTokens: num(raw.out_tk),
      ts
    };
  }
  if (type === "tool") {
    const est = num(raw.tokens_est);
    return { kind: "tool", name: str(raw.tool) || "tool", inTokens: est, outTokens: est, ts };
  }
  return null;
}
var FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/;
function dayFromFileName(name) {
  const match = FILE_NAME_RE.exec(name);
  return match ? match[1] : null;
}
function hourFromFileName(name) {
  const match = FILE_NAME_RE.exec(name);
  if (!match)
    return null;
  const [y, m, d] = match[1].split("-").map(Number);
  const ms = new Date(y, m - 1, d, Number(match[2])).getTime();
  return Number.isFinite(ms) ? ms : null;
}
function dayStartMs(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match)
    return null;
  const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(ms) ? ms : null;
}
var MAX_SESSION_FILES = 400;

class StatsStore {
  squeezHome;
  pricing;
  constructor(squeezHome, pricing) {
    this.squeezHome = squeezHome;
    this.pricing = pricing ?? new PricingEngine;
  }
  get sessionsDir() {
    return path2.join(this.squeezHome, "sessions");
  }
  async readJson(file) {
    try {
      return JSON.parse(await fs2.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }
  async readHandlers() {
    const raw = await this.readJson(path2.join(this.sessionsDir, "handler_stats.json"));
    if (!isRecord(raw))
      return [];
    const names = Array.isArray(raw.names) ? raw.names : [];
    const calls = Array.isArray(raw.calls) ? raw.calls : [];
    const inTokens = Array.isArray(raw.in_tokens) ? raw.in_tokens : [];
    const outTokens = Array.isArray(raw.out_tokens) ? raw.out_tokens : [];
    const handlers = [];
    for (let i = 0;i < names.length; i++) {
      const name = names[i];
      if (typeof name !== "string" || !name)
        continue;
      const inT = num(inTokens[i]);
      const outT = num(outTokens[i]);
      handlers.push({
        name,
        calls: num(calls[i]),
        inTokens: inT,
        outTokens: outT,
        savedTokens: Math.max(0, inT - outT)
      });
    }
    handlers.sort((a, b) => b.savedTokens - a.savedTokens);
    return handlers;
  }
  async readSessionEvents(file) {
    let text;
    try {
      text = await fs2.readFile(path2.join(this.sessionsDir, file), "utf8");
    } catch {
      return [];
    }
    const events = [];
    for (const line of text.split(`
`)) {
      if (!line.trim())
        continue;
      const event = parseEvent(line);
      if (event)
        events.push(event);
    }
    return events;
  }
  async readBlobs() {
    const blobsDir = path2.join(this.squeezHome, "blobs");
    let entries;
    try {
      entries = await fs2.readdir(blobsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile())
        continue;
      try {
        const stat3 = await fs2.stat(path2.join(blobsDir, entry.name));
        bytes += stat3.size;
        count += 1;
      } catch {}
    }
    return { count, bytes };
  }
  aggregateEvents(files, events) {
    const handlerMap = new Map;
    let inTokens = 0;
    let outTokens = 0;
    let savedTokens = 0;
    for (const event of events) {
      inTokens += event.inTokens;
      outTokens += event.outTokens;
      const saved = Math.max(0, event.inTokens - event.outTokens);
      savedTokens += saved;
      const existing = handlerMap.get(event.name);
      if (existing) {
        existing.calls += 1;
        existing.inTokens += event.inTokens;
        existing.outTokens += event.outTokens;
        existing.savedTokens += saved;
      } else {
        handlerMap.set(event.name, {
          name: event.name,
          calls: 1,
          inTokens: event.inTokens,
          outTokens: event.outTokens,
          savedTokens: saved
        });
      }
    }
    const handlers = [...handlerMap.values()].sort((a, b) => b.savedTokens - a.savedTokens);
    return {
      sessionFiles: files.length,
      events: events.length,
      inTokens,
      outTokens,
      savedTokens,
      handlers
    };
  }
  async getStats(scope = {}) {
    const generatedAt = Date.now();
    const emptyScope = { kind: "all", label: "All time" };
    let sessionEntries;
    try {
      sessionEntries = await fs2.readdir(this.sessionsDir);
    } catch {
      return {
        ok: true,
        squeezHome: this.squeezHome,
        generatedAt,
        reason: "storage-missing",
        live: null,
        allTime: null,
        scoped: null,
        scope: emptyScope,
        pricing: null,
        sessions: [],
        daily: [],
        blobs: null
      };
    }
    let live = null;
    const currentRaw = await this.readJson(path2.join(this.sessionsDir, "current.json"));
    if (isRecord(currentRaw)) {
      const sessionFile = str(currentRaw.session_file);
      const events = sessionFile ? await this.readSessionEvents(sessionFile) : [];
      let inTokens = 0;
      let outTokens = 0;
      for (const event of events) {
        inTokens += event.inTokens;
        outTokens += event.outTokens;
      }
      live = {
        sessionFile,
        startedAt: num(currentRaw.start_ts) * 1000,
        totalTokens: num(currentRaw.total_tokens),
        tokensSaved: num(currentRaw.tokens_saved),
        totalCalls: num(currentRaw.total_calls),
        overheadTokens: num(currentRaw.overhead_tokens),
        events: events.length,
        inTokens,
        outTokens
      };
    }
    const jsonlNames = sessionEntries.filter((entry) => dayFromFileName(entry) !== null).sort().slice(-MAX_SESSION_FILES);
    const files = [];
    for (const name of jsonlNames) {
      const day = dayFromFileName(name);
      const hourStart = hourFromFileName(name);
      if (!day || hourStart === null)
        continue;
      files.push({
        name,
        stem: name.replace(/\.jsonl$/, ""),
        day,
        hourStart,
        events: await this.readSessionEvents(name)
      });
    }
    let selectedFiles = files;
    let scopedEvents = null;
    let scopeEcho = emptyScope;
    let windowStart = 0;
    let windowEnd = generatedAt;
    if (scope.session) {
      selectedFiles = files.filter((f) => f.stem === scope.session);
      const file = selectedFiles[0];
      scopeEcho = {
        kind: "session",
        label: file ? `Session log ${file.stem}` : `Session ${scope.session} (not found)`
      };
      if (file) {
        windowStart = file.hourStart;
        windowEnd = file.hourStart + 3599999;
        scopedEvents = file.events;
      } else {
        scopedEvents = [];
      }
    } else if (scope.from || scope.to) {
      const fromMs = scope.from ? dayStartMs(scope.from) : null;
      const toMs = scope.to ? dayStartMs(scope.to) : null;
      const startMs = fromMs ?? 0;
      const endMs = toMs !== null ? toMs + 86399999 : generatedAt;
      selectedFiles = files.filter((f) => f.hourStart + 3600000 > startMs && f.hourStart <= endMs);
      scopedEvents = [];
      for (const file of selectedFiles) {
        for (const event of file.events) {
          if (event.ts >= startMs && event.ts <= endMs)
            scopedEvents.push(event);
        }
      }
      scopeEcho = {
        kind: "range",
        label: scope.from && scope.to ? `${scope.from} → ${scope.to}` : scope.from ? `Since ${scope.from}` : `Until ${scope.to}`
      };
      windowStart = startMs;
      windowEnd = endMs;
    } else {
      const starts = files.map((f) => f.hourStart);
      windowStart = starts.length > 0 ? Math.min(...starts) : 0;
    }
    const sessions = files.map((f) => ({
      stem: f.stem,
      startedAt: f.hourStart,
      events: f.events.length,
      savedTokens: f.events.reduce((sum, e) => sum + Math.max(0, e.inTokens - e.outTokens), 0)
    })).sort((a, b) => b.startedAt - a.startedAt);
    const handlers = await this.readHandlers();
    let allTime = null;
    let scoped = null;
    if (scopedEvents !== null) {
      scoped = this.aggregateEvents(selectedFiles, scopedEvents);
    } else {
      let totalEvents = 0;
      let eventsIn = 0;
      let eventsOut = 0;
      for (const file of files) {
        for (const event of file.events) {
          totalEvents += 1;
          eventsIn += event.inTokens;
          eventsOut += event.outTokens;
        }
      }
      const handlerCalls = handlers.reduce((sum, h) => sum + h.calls, 0);
      const handlerIn = handlers.reduce((sum, h) => sum + h.inTokens, 0);
      const handlerOut = handlers.reduce((sum, h) => sum + h.outTokens, 0);
      if (handlers.length > 0 || totalEvents > 0) {
        const inTokens = handlerIn > 0 ? handlerIn : eventsIn;
        const outTokens = handlerOut > 0 ? handlerOut : eventsOut;
        allTime = {
          totalCalls: handlerCalls > 0 ? handlerCalls : totalEvents,
          inTokens,
          outTokens,
          savedTokens: Math.max(0, inTokens - outTokens),
          sessionFiles: files.length,
          events: totalEvents,
          handlers
        };
      }
    }
    const savedForPricing = scoped ? scoped.savedTokens : allTime?.savedTokens ?? 0;
    const pricing = await this.pricing.price(windowStart, windowEnd, savedForPricing);
    const dayMap = new Map;
    for (const file of selectedFiles) {
      const events = scope.from || scope.to ? file.events.filter((e) => e.ts >= windowStart && e.ts <= windowEnd) : file.events;
      const point = dayMap.get(file.day) ?? {
        day: file.day,
        events: 0,
        inTokens: 0,
        outTokens: 0,
        savedTokens: 0
      };
      for (const event of events) {
        point.events += 1;
        point.inTokens += event.inTokens;
        point.outTokens += event.outTokens;
      }
      point.savedTokens = Math.max(0, point.inTokens - point.outTokens);
      dayMap.set(file.day, point);
    }
    const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
    const blobs = await this.readBlobs();
    return {
      ok: true,
      squeezHome: this.squeezHome,
      generatedAt,
      live,
      allTime,
      scoped,
      scope: scopeEcho,
      pricing,
      sessions,
      daily,
      blobs
    };
  }
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT || process.env.OPENCHAMBER_AGENT_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN || process.env.OPENCHAMBER_AGENT_TOKEN || "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("[squeez-stats] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var store = new StatsStore(resolveSqueezHome());
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
var server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      const scope = {};
      const session = (url.searchParams.get("session") ?? "").trim();
      const from = (url.searchParams.get("from") ?? "").trim();
      const to = (url.searchParams.get("to") ?? "").trim();
      if (session && /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(session))
        scope.session = session;
      else {
        if (DAY_RE.test(from))
          scope.from = from;
        if (DAY_RE.test(to))
          scope.to = to;
      }
      sendJson(res, 200, await store.getStats(scope));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[squeez-stats] listening on 127.0.0.1:${port} (home: ${store.squeezHome})`);
});
