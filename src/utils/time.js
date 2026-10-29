function formatIstDateShort(isoOrMs) {
  try {
    const d = new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch (_) {
    return "—";
  }
}
function istTimeStr() {
  try {
    return new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch (e) {
    return new Date().toString();
  }
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { formatIstDateShort, istTimeStr, todayKey };
