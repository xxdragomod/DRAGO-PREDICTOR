/**
 * Image upload / storage (memory + Mongo + ImgBB)
 *
 * Auto-split from the original monolithic server.js — behaviour unchanged.
 * Original lines: 238-272, 1633-1718
 */

const crypto = require("crypto");

const { col } = require("./db/index");
const { publicBase } = require("./lib/utils");
const { IMGBB_API_KEY, PUBLIC_BASE_URL } = require("./config");

function hasValidImageMagicBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return true;
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return true;
  }
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}


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

  const base =
    PUBLIC_BASE_URL ||
    (req ? publicBase(req) : "") ||
    "https://dragopredictor.onrender.com";
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

module.exports = {
  getStoredImageById,
  hasValidImageMagicBytes,
  storeUploadedImage,
  uploadedImagesMem,
};

require("./lib/lazy").register(module.exports);
