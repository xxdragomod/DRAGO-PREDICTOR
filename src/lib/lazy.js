/**
 * Lazy dependency registry — circular require break karne ke liye.
 *
 * Do modules ek doosre ko dono direction me use karte hain (jaise
 * models/users ↔ telegram/admin-bot). CommonJS me direct destructured import
 * aise cycle pe `undefined` de deta hai. Yahan har module load hote hi apne
 * exports register kar deta hai, aur consumer ko ek chhota stub milta hai jo
 * pehli baar CALL hone par asli function resolve karta hai — tab tak saare
 * modules load ho chuke hote hain.
 *
 * Ye module khud kisi ko require nahi karta, isliye kabhi cycle ka hissa nahi banta.
 */
const registry = new Map();

/** Apne exports register karo (module ke end me call hota hai). */
function register(map) {
  for (const [name, fn] of Object.entries(map)) registry.set(name, fn);
}

/** Ek naam ka lazy stub. Pehli call pe resolve + cache. */
function lazy(name) {
  let resolved;
  return function lazyBound(...args) {
    if (resolved === undefined) {
      resolved = registry.get(name);
      if (resolved === undefined) {
        throw new Error(`[lazy] "${name}" abhi register nahi hua — module load order dekho`);
      }
    }
    return resolved.apply(this, args);
  };
}

module.exports = { register, lazy };
