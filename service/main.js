// service/main.ts
import http from "node:http";

// service/stats.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
  return path.join(os.homedir(), ".claude", "squeez");
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
  if (type === "bash") {
    return { inTokens: num(raw.in_tk), outTokens: num(raw.out_tk), ts: num(raw.ts) };
  }
  if (type === "tool") {
    const est = num(raw.tokens_est);
    return { inTokens: est, outTokens: est, ts: num(raw.ts) };
  }
  return null;
}
function dayFromFileName(name) {
  const match = /^(\d{4}-\d{2}-\d{2})-\d{2}\.jsonl$/.exec(name);
  return match ? match[1] : null;
}
var MAX_SESSION_FILES = 400;

class StatsStore {
  squeezHome;
  constructor(squeezHome) {
    this.squeezHome = squeezHome;
  }
  get sessionsDir() {
    return path.join(this.squeezHome, "sessions");
  }
  async readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }
  async readHandlers() {
    const raw = await this.readJson(path.join(this.sessionsDir, "handler_stats.json"));
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
      text = await fs.readFile(path.join(this.sessionsDir, file), "utf8");
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
    const blobsDir = path.join(this.squeezHome, "blobs");
    let entries;
    try {
      entries = await fs.readdir(blobsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile())
        continue;
      try {
        const stat2 = await fs.stat(path.join(blobsDir, entry.name));
        bytes += stat2.size;
        count += 1;
      } catch {}
    }
    return { count, bytes };
  }
  async getStats() {
    const generatedAt = Date.now();
    let sessionEntries;
    try {
      sessionEntries = await fs.readdir(this.sessionsDir);
    } catch {
      return {
        ok: true,
        squeezHome: this.squeezHome,
        generatedAt,
        reason: "storage-missing",
        live: null,
        allTime: null,
        daily: [],
        blobs: null
      };
    }
    let live = null;
    const currentRaw = await this.readJson(path.join(this.sessionsDir, "current.json"));
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
    const handlers = await this.readHandlers();
    const jsonlFiles = sessionEntries.filter((entry) => dayFromFileName(entry) !== null).sort().slice(-MAX_SESSION_FILES);
    const dayMap = new Map;
    let totalEvents = 0;
    let eventsIn = 0;
    let eventsOut = 0;
    for (const file of jsonlFiles) {
      const day = dayFromFileName(file);
      if (!day)
        continue;
      const events = await this.readSessionEvents(file);
      const point = dayMap.get(day) ?? {
        day,
        events: 0,
        inTokens: 0,
        outTokens: 0,
        savedTokens: 0
      };
      for (const event of events) {
        point.events += 1;
        point.inTokens += event.inTokens;
        point.outTokens += event.outTokens;
        totalEvents += 1;
        eventsIn += event.inTokens;
        eventsOut += event.outTokens;
      }
      point.savedTokens = Math.max(0, point.inTokens - point.outTokens);
      dayMap.set(day, point);
    }
    const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
    let allTime = null;
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
        sessionFiles: jsonlFiles.length,
        events: totalEvents,
        handlers
      };
    }
    const blobs = await this.readBlobs();
    return {
      ok: true,
      squeezHome: this.squeezHome,
      generatedAt,
      live,
      allTime,
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
      sendJson(res, 200, await store.getStats());
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
