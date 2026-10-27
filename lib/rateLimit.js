const WINDOW_MS = 60 * 1000;
const MAX_TRACKED_CLIENTS = 500;

const buckets = new Map();

function pruneBuckets(now) {
  for (const [key, timestamps] of buckets.entries()) {
    const active = timestamps.filter(ts => now - ts < WINDOW_MS);
    if (active.length === 0) {
      buckets.delete(key);
    } else {
      buckets.set(key, active);
    }
  }
  while (buckets.size >= MAX_TRACKED_CLIENTS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

export function extractClientKey(req, body) {
  const userId = body?.session?.user?.user_id || body?.session?.user_id;
  if (typeof userId === "string" && userId.trim()) {
    return `u:${userId.trim().slice(0, 80)}`;
  }

  const appId = body?.session?.application?.application_id;
  if (typeof appId === "string" && appId.trim()) {
    return `a:${appId.trim().slice(0, 80)}`;
  }

  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return `ip:${forwarded.split(",")[0].trim().slice(0, 60)}`;
  }

  return "anonymous";
}

/**
 * Checks per-client sliding-window rate limit for external LLM calls.
 * Set RATE_LIMIT_PER_MINUTE=0 to disable. Default: 25 requests/minute per user.
 */
export function checkRateLimit(clientKey) {
  const rawLimit = process.env.RATE_LIMIT_PER_MINUTE;
  const maxPerMinute = rawLimit !== undefined && rawLimit !== "" ? Number(rawLimit) : 25;
  if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
    return { allowed: true };
  }

  const now = Date.now();
  if (buckets.size > 100) {
    pruneBuckets(now);
  }

  const key = String(clientKey || "anonymous");
  const prev = buckets.get(key) || [];
  const recent = prev.filter(ts => now - ts < WINDOW_MS);

  if (recent.length >= maxPerMinute) {
    buckets.set(key, recent);
    return { allowed: false, limit: maxPerMinute };
  }

  recent.push(now);
  buckets.set(key, recent);
  return { allowed: true, remaining: maxPerMinute - recent.length };
}

export function clearRateLimitForTests() {
  buckets.clear();
}
