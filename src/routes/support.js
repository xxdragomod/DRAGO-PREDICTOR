/**
 * Support messaging routes
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 7703-7830
 */


const { app } = require("../app");
const { authUser } = require("../auth/token");
const { col } = require("../db/index");
const { timingSafeEqualStr } = require("../middleware/signature");
const { dbFindUserById } = require("../models/users");
const { pushNotification } = require("../notifications");
const { TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_BOT_TOKEN } = require("../plans");
const { telegramApi } = require("../telegram/api");
const { ADMIN_PANEL_KEY } = require("../config");

// ─── Support Messaging System ───────────────────────────────────────────────
app.post("/support/send", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ success: false, message: "Message required" });
  }
  
  if (message.length > 2000) {
    return res.status(400).json({ success: false, message: "Message too long (max 2000 chars)" });
  }
  
  const user = await dbFindUserById(decoded.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  
  const msgDoc = {
    id: Date.now(),
    user_id: user.id,
    user_name: user.name || user.email || `User #${user.id}`,
    user_email: user.email || "",
    message: message.trim(),
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  
  await col.support_messages.insertOne(msgDoc);
  
  // Send to admin via Telegram
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_CHAT_ID) {
    const adminMsg = 
      `📩 *New Support Message*\n\n` +
      `👤 User: ${msgDoc.user_name}\n` +
      `🆔 ID: #${user.id}\n` +
      `📧 Email: ${msgDoc.user_email}\n\n` +
      `💬 Message:\n${message}`;
    
    telegramApi("sendMessage", {
      chat_id: TELEGRAM_ADMIN_CHAT_ID,
      text: adminMsg,
      parse_mode: "Markdown",
    }).catch(e => console.warn("Support TG notify:", e.message));
  }
  
  res.json({ success: true, message: "Message sent to support team" });
});

app.get("/support/messages", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  
  const messages = await col.support_messages
    .find({ user_id: Number(decoded.id) })
    .sort({ created_at: -1 })
    .limit(50)
    .toArray();
  
  res.json({ success: true, messages });
});

// Admin endpoints (require ADMIN_PANEL_KEY)
app.get("/admin/support/list", async (req, res) => {
  const key = req.get("x-admin-key");
  if (!key || !timingSafeEqualStr(key, ADMIN_PANEL_KEY)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const status = req.query.status || "all";
  
  const query = status === "all" ? {} : { status };
  const messages = await col.support_messages
    .find(query)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
  
  res.json({ success: true, messages, count: messages.length });
});

app.post("/admin/support/reply", async (req, res) => {
  const key = req.get("x-admin-key");
  if (!key || !timingSafeEqualStr(key, ADMIN_PANEL_KEY)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  
  const { message_id, reply } = req.body;
  if (!message_id || !reply || typeof reply !== "string") {
    return res.status(400).json({ success: false, message: "message_id and reply required" });
  }
  
  const msg = await col.support_messages.findOne({ id: Number(message_id) });
  if (!msg) {
    return res.status(404).json({ success: false, message: "Message not found" });
  }
  
  await col.support_messages.updateOne(
    { id: Number(message_id) },
    { 
      $set: { 
        status: "replied",
        admin_reply: reply.trim(),
        replied_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    }
  );
  
  // Notify user
  pushNotification({
    target: "user",
    user_id: msg.user_id,
    user_name: msg.user_name,
    type: "support_reply",
    title: "💬 Support Reply",
    message: `Hi ${msg.user_name}, your support message has been replied!`,
    action_url: "/profile/",
    action_label: "VIEW REPLY →",
  });
  
  res.json({ success: true, message: "Reply sent" });
});

// 404

module.exports = {};
