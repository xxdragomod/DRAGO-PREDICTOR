function escTgMd(val, maxLen = 200) {
  return String(val == null ? "" : val)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/([_*`\[\]\\])/g, "")
    .trim()
    .slice(0, maxLen);
}

module.exports = { escTgMd };
