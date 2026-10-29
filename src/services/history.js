
const { WINGO_HISTORY_URL, WINGO_PREDICTION_URL } = require("../config/env");
const { WINGO_HISTORY_MAX } = require("./payments");
const { vpsHeaders } = require("./prediction");
function extractHistoryList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.list)) return payload.data.list;
  if (payload.data && Array.isArray(payload.data.records))
    return payload.data.records;
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

/** Fetch history from orihost — never write to disk on Render */
async function fetchWingoHistoryFromVps(limit) {
  if (!WINGO_HISTORY_URL) {
    const err = new Error("History source not configured");
    err.status = 503;
    throw err;
  }
  const url = new URL(WINGO_HISTORY_URL);
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    url.searchParams.set("limit", String(Math.min(WINGO_HISTORY_MAX, limit)));
  }
  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(12000),
    headers: vpsHeaders(),
  });
  if (!response.ok) {
    const err = new Error(`Upstream history error: ${response.status}`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  let items = extractHistoryList(data);
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    items = items.slice(0, Math.min(WINGO_HISTORY_MAX, limit));
  } else if (items.length > WINGO_HISTORY_MAX) {
    items = items.slice(0, WINGO_HISTORY_MAX);
  }
  return {
    items,
    updated_at:
      (data && (data.updated_at || data.updatedAt)) ||
      new Date().toISOString(),
    raw: data,
  };
}

/** Lightweight VPS health for status page (no data stored) */
async function pingVps(kind) {
  const target =
    kind === "history" ? WINGO_HISTORY_URL : WINGO_PREDICTION_URL;
  if (!target) return { ok: false, detail: "Not configured", latency_ms: null };
  const t0 = Date.now();
  try {
    const r = await fetch(target, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      headers: vpsHeaders(),
    });
    return {
      ok: r.status < 500,
      detail: r.status < 500 ? "Online (VPS)" : `HTTP ${r.status}`,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      detail: "Unreachable",
      latency_ms: Date.now() - t0,
    };
  }
}

module.exports = { extractHistoryList, fetchWingoHistoryFromVps, pingVps };
