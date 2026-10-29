
const { col } = require("../state/mongo");
async function nextSeq(name) {
  const r = await col.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return r && r.seq != null ? r.seq : 1;
}

module.exports = { nextSeq };
