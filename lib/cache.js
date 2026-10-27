import { randomBytes } from "node:crypto";

const SEARCH_CACHE_TTL_MS = 7 * 60 * 1000; // 7 minutes
const SEARCH_CACHE_MAX_ENTRIES = 100;

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_TTL_SECONDS = 300;
const PENDING_MAX_ENTRIES = 80;

const searchCache = new Map();
const pendingMemoryStore = new Map();
const inFlightTasks = new Map();
const modelCooldowns = new Map();

let lastCallMetrics = null;

export function markModelCooldown(model, durationMs = 5 * 60 * 1000) {
  if (!model) return;
  modelCooldowns.set(model, Date.now() + durationMs);
}

export function isModelOnCooldown(model) {
  if (!model) return false;
  const until = modelCooldowns.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    modelCooldowns.delete(model);
    return false;
  }
  return true;
}

export function recordLastCallMetrics(metrics) {
  lastCallMetrics = {
    ...metrics,
    recordedAt: new Date().toISOString()
  };
}

export function getLastCallMetrics() {
  return lastCallMetrics;
}

function normalizeCacheKey(query) {
  return String(query ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function getCachedSearchResult(query) {
  const key = normalizeCacheKey(query);
  if (!key) return null;

  const entry = searchCache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }

  // Refresh LRU order
  searchCache.delete(key);
  searchCache.set(key, entry);
  return entry.value;
}

export function setCachedSearchResult(query, value) {
  const key = normalizeCacheKey(query);
  if (!key || !value) return;

  if (searchCache.has(key)) {
    searchCache.delete(key);
  } else if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey !== undefined) searchCache.delete(oldestKey);
  }

  searchCache.set(key, {
    value,
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS
  });
}

export function clearCachesForTests() {
  searchCache.clear();
  pendingMemoryStore.clear();
  inFlightTasks.clear();
  modelCooldowns.clear();
  lastCallMetrics = null;
}

export function isUpstashConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

async function upstashCommand(args, timeoutMs = 1200) {
  const baseUrl = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!baseUrl || !token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(args),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function generatePendingId() {
  return randomBytes(6).toString("hex");
}

function prunePendingStore() {
  const now = Date.now();
  for (const [k, v] of pendingMemoryStore.entries()) {
    if (now > v.expiresAt) pendingMemoryStore.delete(k);
  }
  while (pendingMemoryStore.size >= PENDING_MAX_ENTRIES) {
    const oldest = pendingMemoryStore.keys().next().value;
    if (oldest === undefined) break;
    pendingMemoryStore.delete(oldest);
  }
}

export async function savePendingResult(pendingId, payload) {
  prunePendingStore();
  const record = {
    question: String(payload?.question || ""),
    answer: String(payload?.answer || ""),
    errorMessage: payload?.errorMessage ? String(payload.errorMessage) : ""
  };

  pendingMemoryStore.set(pendingId, {
    record,
    expiresAt: Date.now() + PENDING_TTL_MS
  });

  if (isUpstashConfigured()) {
    await upstashCommand(["SET", `alice:pending:${pendingId}`, JSON.stringify(record), "EX", PENDING_TTL_SECONDS]);
  }
}

export function registerBackgroundPendingTask(pendingId, question, answerPromise) {
  const task = (async () => {
    try {
      const answer = await answerPromise;
      const payload = { question, answer };
      await savePendingResult(pendingId, payload);
      return payload;
    } catch (err) {
      const payload = { question, answer: "", errorMessage: err?.message || "GEMINI_REQUEST_FAILED" };
      await savePendingResult(pendingId, payload);
      return payload;
    } finally {
      inFlightTasks.delete(pendingId);
    }
  })();

  inFlightTasks.set(pendingId, task);
  vercelWaitUntil(task);
  return task;
}

export async function consumePendingResult(pendingId, waitBudgetMs = 2400) {
  if (!pendingId) return { status: "missing" };

  // 1. Check completed memory store
  const mem = pendingMemoryStore.get(pendingId);
  if (mem) {
    if (Date.now() <= mem.expiresAt) {
      pendingMemoryStore.delete(pendingId);
      if (isUpstashConfigured()) {
        upstashCommand(["DEL", `alice:pending:${pendingId}`], 500).catch(() => {});
      }
      return { status: "ready", record: mem.record };
    }
    pendingMemoryStore.delete(pendingId);
  }

  // 2. If still running in the same warm container, wait up to waitBudgetMs
  const running = inFlightTasks.get(pendingId);
  if (running) {
    const waited = await Promise.race([
      running.then(record => ({ done: true, record })),
      new Promise(resolve => setTimeout(() => resolve({ done: false }), Math.max(100, waitBudgetMs)))
    ]);
    if (waited.done) {
      pendingMemoryStore.delete(pendingId);
      return { status: "ready", record: waited.record };
    }
    return { status: "still_running" };
  }

  // 3. Check Upstash Redis across serverless instances
  if (isUpstashConfigured()) {
    const raw = await upstashCommand(["GET", `alice:pending:${pendingId}`], Math.min(1000, Math.max(200, waitBudgetMs)));
    if (typeof raw === "string" && raw) {
      upstashCommand(["DEL", `alice:pending:${pendingId}`], 500).catch(() => {});
      try {
        return { status: "ready", record: JSON.parse(raw) };
      } catch {
        return { status: "missing" };
      }
    }
  }

  return { status: "missing" };
}

/**
 * Registers a background promise with Vercel's Node.js Fluid/Serverless runtime context
 * without requiring the external @vercel/functions package.
 */
export function vercelWaitUntil(promise) {
  try {
    const ctxHolder = globalThis[Symbol.for("@vercel/request-context")];
    const ctx = ctxHolder?.get?.();
    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(promise.catch(err => console.warn("Background task error:", err?.message || err)));
    } else {
      promise.catch(() => {});
    }
  } catch {
    promise.catch(() => {});
  }
}
