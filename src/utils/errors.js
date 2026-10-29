function isDiskFullError(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  return (
    m.includes("database or disk is full") ||
    m.includes("sqlite_full") ||
    m.includes("disk i/o error") ||
    m.includes("no space left") ||
    m.includes("enospc") ||
    m.includes("quota")
  );
}

/** Compatibility wrapper — payments are file-based; just run fn */
function safeDbWrite(fn) {
  return fn();
}

module.exports = { isDiskFullError, safeDbWrite };
