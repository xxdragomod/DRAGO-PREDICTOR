const express = require("express");
const router = express.Router();


const { RUPAYEX_API_BASE, RUPAYEX_API_TOKEN, TELEGRAM_BOT_TOKEN } = require("../config/env");
const { authUser } = require("../services/authService");
const { pingVps } = require("../services/history");
const { expireStaleOrders } = require("../services/payments");
const { telegramApi } = require("../services/telegramApi");
const { adminSettings } = require("../state/adminSettings");
const { dbPing } = require("../state/mongo");
const { SERVER_STARTED_AT, pushHistory, timedFetch } = require("./payment");

const { getAnnouncement } = require("../services/announcement");
router.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "🐉 DRAGO API is running!",
    timestamp: new Date().toISOString(),
  });
});

/**
 * Start Google OAuth — frontend redirects yahan.
 * Client ID/Secret kabhi frontend pe nahi jaate.
 */
router.get("/system-status", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;

  expireStaleOrders();

  const checks = [];
  const nowIso = new Date().toISOString();

  const push = (id, label, ok, detail, pct, extra) => {
    const history = pushHistory(id, ok);
    const upSamples = history.filter(Boolean).length;
    const uptimePct =
      history.length > 0
        ? Math.round((upSamples / history.length) * 100)
        : ok
          ? 100
          : 0;
    checks.push({
      id,
      label,
      ok: Boolean(ok),
      detail: detail || "",
      percent: typeof pct === "number" ? pct : uptimePct,
      latency_ms: extra && extra.latency_ms != null ? extra.latency_ms : null,
      url: (extra && extra.url) || "",
      last_checked: "just now",
      history,
      checked_at: nowIso,
    });
  };

  // API self — never expose real tunnel / host URL to clients
  push("api", "API Server", true, "Online", 100, {
    latency_ms: 1,
    url: "",
  });

  // DB — hide path
  try {
    const t0 = Date.now();
    await dbPing();
    push("db", "Database", true, "Connected (MongoDB)", 100, {
      latency_ms: Date.now() - t0,
      url: "",
    });
  } catch (e) {
    push("db", "Database", false, "Error", 0, { url: "" });
  }

  // Payment Gateway — hide URL
  if (!RUPAYEX_API_TOKEN) {
    push("gateway", "Payment Gateway", false, "Not configured", 0, {
      url: "",
    });
  } else {
    try {
      const { response: r, latency_ms } = await timedFetch(
        `${RUPAYEX_API_BASE}/`,
        { method: "GET", signal: AbortSignal.timeout(8000) }
      );
      push(
        "gateway",
        "Payment Gateway",
        r.status < 500,
        r.status < 500 ? "Online" : `HTTP ${r.status}`,
        r.status < 500 ? 100 : 30,
        { latency_ms, url: "" }
      );
    } catch (e) {
      push("gateway", "Payment Gateway", false, "Unreachable", 0, {
        url: "",
      });
    }
  }

  // Help Support (was Telegram Bot) — hide username / URL
  if (!TELEGRAM_BOT_TOKEN) {
    push("telegram", "Help Support", false, "Not configured", 0, {
      url: "",
    });
  } else {
    try {
      const t0 = Date.now();
      const me = await telegramApi("getMe", {});
      push(
        "telegram",
        "Help Support",
        me && me.ok,
        me && me.ok ? "Online" : "Auth failed",
        me && me.ok ? 100 : 0,
        {
          latency_ms: Date.now() - t0,
          url: "",
        }
      );
    } catch (e) {
      push("telegram", "Help Support", false, "Error", 0, {
        url: "",
      });
    }
  }

  // Orihost VPS — prediction + history (no local store on Render)
  try {
    const predPing = await pingVps("prediction");
    push(
      "wingo_prediction",
      "Prediction Source (VPS)",
      predPing.ok,
      predPing.detail,
      predPing.ok ? 100 : 0,
      { latency_ms: predPing.latency_ms, url: "" }
    );
  } catch (_) {
    push("wingo_prediction", "Prediction Source (VPS)", false, "Error", 0, {
      url: "",
    });
  }
  try {
    const histPing = await pingVps("history");
    push(
      "wingo_history",
      "History Source (VPS)",
      histPing.ok,
      histPing.detail,
      histPing.ok ? 100 : 0,
      { latency_ms: histPing.latency_ms, url: "" }
    );
  } catch (_) {
    push("wingo_history", "History Source (VPS)", false, "Error", 0, {
      url: "",
    });
  }

  const uptimeSec = Math.floor((Date.now() - SERVER_STARTED_AT) / 1000);
  const avg =
    checks.length > 0
      ? Math.round(
          checks.reduce((s, c) => s + (c.percent || 0), 0) / checks.length
        )
      : 0;

  res.json({
    success: true,
    uptime_sec: uptimeSec,
    health_percent: avg,
    checks,
    timestamp: nowIso,
  });
});

/**
 * Public games list for game.html
 * GET /games
 * GET /games/:id
 */
/** Public: frontend guard reads this to honour Telegram on/off toggle. */
router.get("/guard-status", (req, res) => {
  res.json({ success: true, enabled: adminSettings.guard_enabled !== false });
});

/** Public: feedback popup force mode ("Bug in app" admin toggle) */
router.get("/feedback-status", (req, res) => {
  res.json({
    success: true,
    force: adminSettings.force_feedback === true,
    rate: adminSettings.force_rate === true,
    winfb: adminSettings.force_winfb === true,
  });
});
/** Current announcement (app popup — ek baar per user) */
router.get("/announcement", (req, res) => {
  const current = typeof getAnnouncement === "function" ? getAnnouncement() : null;
  res.json(current ? { success: true, announcement: current } : { success: true, announcement: null });
});

module.exports = { router };
