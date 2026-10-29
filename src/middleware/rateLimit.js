const RL = new Map();
function rateLimitUser(key, max, windowMs) {
  const now = Date.now();
  let rec = RL.get(key);
  if (!rec || now - rec.t > windowMs) {
    rec = { t: now, n: 0, w: windowMs };
  }
  rec.n++;
  RL.set(key, rec);
  if (RL.size > 10000) {
    for (const [k, v] of RL) {
      if (now - v.t > (v.w || windowMs)) RL.delete(k);
      if (RL.size <= 8000) break;
    }
    if (RL.size > 10000) {
      const oldestKey = RL.keys().next().value;
      if (oldestKey) RL.delete(oldestKey);
    }
  }
  return rec.n <= max;
}

module.exports = { RL, rateLimitUser };
