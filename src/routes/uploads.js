const express = require("express");
const router = express.Router();


const { rateLimitUser } = require("../middleware/rateLimit");
const { authUser } = require("../services/authService");
const { getStoredImageById, storeUploadedImage } = require("../services/uploads");
const { hasValidImageMagicBytes } = require("../utils/images");
router.get("/uploads/:filename", async (req, res) => {
  try {
    const entry = await getStoredImageById(req.params.filename);
    if (!entry || !entry.buf) {
      return res.status(404).send("Image not found");
    }
    res.setHeader("Content-Type", entry.mime || "image/jpeg");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(entry.buf);
  } catch (e) {
    return res.status(500).send("Error loading image");
  }
});
router.post("/upload-image", async (req, res) => {
  const decoded = authUser(req, res);
  if (!decoded) return;
  if (!rateLimitUser("up:" + decoded.id, 25, 3600000))
    return res.status(429).json({ success: false, message: "Too many uploads. Try later." });
  const b64 = String((req.body && req.body.image) || "");
  const m = b64.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if (!m) return res.status(400).json({ success: false, message: "Only PNG/JPG/WEBP/GIF allowed." });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 6 * 1024 * 1024)
    return res.status(413).json({ success: false, message: "Image too large (max 6MB)." });
  if (!hasValidImageMagicBytes(buf)) {
    return res.status(400).json({ success: false, message: "Invalid image file contents." });
  }
  try {
    const url = await storeUploadedImage(buf, "image/" + m[1].toLowerCase(), req);
    return res.json({ success: true, url });
  } catch (e) {
    return res.status(502).json({ success: false, message: "Upload failed." });
  }
});

module.exports = { router };
