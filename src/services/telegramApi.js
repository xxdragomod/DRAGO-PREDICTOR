
const { TELEGRAM_BOT_TOKEN } = require("../config/env");
async function telegramApi(method, body, token) {
  const tk = token || TELEGRAM_BOT_TOKEN;
  if (!tk) return null;
  const url = `https://api.telegram.org/bot${tk}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return await res.json();
  } catch (err) {
    console.error("telegram:", method, err.message);
    return null;
  }
}

module.exports = { telegramApi };
