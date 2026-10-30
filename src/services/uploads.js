const crypto = require("crypto");
const { PUBLIC_BASE_URL, TELEGRAM_BOT_TOKEN } = require("../config/env");
const { col } = require("../state/mongo");
const { publicBase } = require("../utils/url");
const { telegramApi } = require("./telegramApi");
/* ── Built-in Persistent Image Hosting (MongoDB + RAM Cache + ImgBB fallback) ── */
const IMGBB_API_KEY = String(process.env.IMGBB_API_KEY || process.env.IMGBB_KEY || "").trim();
const uploadedImagesMem = new Map(); // id -> { mime, buf, ext }
async function storeUploadedImage(buf, mimeType, req) {
  const mime = String(mimeType || "image/jpeg").toLowerCase();
  const ext = mime.includes("png")
    ? "png"
    : mime.includes("webp")
      ? "webp"
      : mime.includes("gif")
        ? "gif"
        : "jpg";

  // ImgBB credentials are accepted only from server-side environment variables.
  if (IMGBB_API_KEY) {
    try {
      const body = new URLSearchParams();
      body.append("key", IMGBB_API_KEY);
      body.append("image", buf.toString("base64"));
      const r = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json();
      if (j && j.success && j.data && j.data.url) {
        return j.data.url;
      }
    } catch (_) {}
  }

  const id = "img_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
  const doc = {
    id,
    ext,
    mime: `image/${ext === "jpg" ? "jpeg" : ext}`,
    data: buf.toString("base64"),
    size: buf.length,
    created_at: new Date().toISOString(),
  };

  uploadedImagesMem.set(id, { mime: doc.mime, buf, ext });
  if (uploadedImagesMem.size > 150) {
    const oldest = uploadedImagesMem.keys().next().value;
    if (oldest) uploadedImagesMem.delete(oldest);
  }

  if (col.uploads) {
    try {
      await col.uploads.updateOne({ id }, { $set: doc }, { upsert: true });
    } catch (e) {
      console.warn("mongo image save:", e.message);
    }
  }

  // PUBLIC_BASE_URL → request se detect → relative path (koi hardcoded domain nahi)
  const base = PUBLIC_BASE_URL || (req ? publicBase(req) : "");
  return `${base.replace(/\/$/, "")}/uploads/${id}.${ext}`;
}
async function getStoredImageById(rawId) {
  const id = String(rawId || "")
    .trim()
    .replace(/\.(png|jpe?g|webp|gif)$/i, "");
  if (!id) return null;
  if (uploadedImagesMem.has(id)) {
    return uploadedImagesMem.get(id);
  }
  if (col.uploads) {
    try {
      const doc = await col.uploads.findOne({ id });
      if (doc && doc.data) {
        const entry = {
          mime: doc.mime || "image/jpeg",
          buf: Buffer.from(doc.data, "base64"),
          ext: doc.ext || "jpg",
        };
        uploadedImagesMem.set(id, entry);
        return entry;
      }
    } catch (_) {}
  }
  return null;
}
async function sendTelegramPhotoSmart({ chatId, photoUrl, caption, replyMarkup, parseMode, token }) {
  const tk = token || TELEGRAM_BOT_TOKEN;
  if (!tk || !chatId) return null;

  // 1. If photoUrl is one of our /uploads/img_... URLs, send binary buffer directly via FormData
  try {
    const match = String(photoUrl || "").match(/\/uploads\/(img_[A-Za-z0-9_]+)(?:\.[a-z]+)?$/i);
    if (match && match[1]) {
      const stored = await getStoredImageById(match[1]);
      if (stored && stored.buf && typeof FormData !== "undefined" && typeof Blob !== "undefined") {
        const fd = new FormData();
        fd.append("chat_id", String(chatId));
        fd.append(
          "photo",
          new Blob([stored.buf], { type: stored.mime || "image/jpeg" }),
          `${match[1]}.${stored.ext || "jpg"}`
        );
        if (caption) fd.append("caption", String(caption).slice(0, 1024));
        if (parseMode) fd.append("parse_mode", String(parseMode));
        if (replyMarkup) fd.append("reply_markup", JSON.stringify(replyMarkup));

        const res = await fetch(`https://api.telegram.org/bot${tk}/sendPhoto`, {
          method: "POST",
          body: fd,
          signal: AbortSignal.timeout(15000),
        });
        const j = await res.json().catch(() => null);
        if (j && j.ok) return j;
      }
    }
  } catch (e) {
    console.warn("sendTelegramPhotoSmart binary:", e.message);
  }

  // 2. Fallback: send URL to Telegram sendPhoto
  if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
    const payload = {
      chat_id: chatId,
      photo: photoUrl,
      caption: String(caption || "").slice(0, 1024),
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const r = await telegramApi("sendPhoto", payload, tk);
    if (r && r.ok) return r;
  }

  return null;
}
async function imgbbUploadBuffer(buf) {
  return storeUploadedImage(buf, "image/jpeg", null);
}
async function telegramPhotoToImgbb(photoArr) {
  const best = photoArr[photoArr.length - 1];
  const f = await telegramApi("getFile", { file_id: best.file_id });
  if (!f || !f.ok || !f.result || !f.result.file_path) throw new Error("getFile failed");
  const src = await fetch(
    "https://api.telegram.org/file/bot" + TELEGRAM_BOT_TOKEN + "/" + f.result.file_path
  );
  const buf = Buffer.from(await src.arrayBuffer());
  return imgbbUploadBuffer(buf);
}

module.exports = { IMGBB_API_KEY, getStoredImageById, imgbbUploadBuffer, sendTelegramPhotoSmart, storeUploadedImage, telegramPhotoToImgbb, uploadedImagesMem };
