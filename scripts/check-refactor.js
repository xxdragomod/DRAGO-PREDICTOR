#!/usr/bin/env node
/**
 * Static sanity checks — refactor ke baad "silently broken" cheezein pakadta hai:
 *
 *  1. broken imports   — destructured `require` aisa naam maang raha hai jo target
 *                        module export hi nahi karta (runtime pe `undefined` → crash)
 *  2. circular requires — cycle me destructured import `undefined` aata hai
 *  3. disk writes       — server ko JSON files pe likhna hi nahi chahiye
 *
 * Usage: node scripts/check-refactor.js
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const source = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
const rel = (f) => path.relative(path.join(SRC, ".."), f);

function exportsOf(file) {
  const body = source.get(file) || "";
  const m = body.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  if (!m) return new Set();
  return new Set(
    m[1]
      .split(",")
      .map((p) => p.trim().split(":")[0].trim())
      .filter(Boolean)
  );
}

function resolve(from, spec) {
  if (!spec.startsWith(".")) return null;
  let target = path.resolve(path.dirname(from), spec);
  if (!target.endsWith(".js")) target += ".js";
  return fs.existsSync(target) ? target : null;
}

const problems = [];

// 1. broken destructured imports
const REQ = /const\s*\{([^}]+)\}\s*=\s*require\("(\.[^"]+)"\)/g;
for (const file of files) {
  const body = source.get(file);
  let m;
  while ((m = REQ.exec(body))) {
    const names = m[1]
      .split(",")
      .map((x) => x.trim().split(":")[0].trim())
      .filter(Boolean);
    const target = resolve(file, m[2]);
    if (!target) continue;
    const ex = exportsOf(target);
    const missing = names.filter((n) => !ex.has(n));
    if (missing.length) {
      problems.push(
        `broken import: ${rel(file)} ⇐ "${m[2]}"  missing export(s): ${missing.join(", ")}`
      );
    }
  }
}

// 2. circular requires
const graph = new Map();
for (const file of files) {
  const deps = [];
  const RX = /require\("(\.[^"]+)"\)/g;
  let m;
  while ((m = RX.exec(source.get(file)))) {
    const t = resolve(file, m[1]);
    if (t) deps.push(t);
  }
  graph.set(file, deps);
}
const seen = new Set();
const stack = [];
function dfs(node) {
  if (stack.includes(node)) {
    const cyc = stack.slice(stack.indexOf(node)).concat(node).map(rel).join(" → ");
    if (!seen.has(cyc)) {
      seen.add(cyc);
      problems.push(`circular require: ${cyc}`);
    }
    return;
  }
  if (stack.length > 30) return;
  stack.push(node);
  for (const dep of graph.get(node) || []) dfs(dep);
  stack.pop();
}
for (const f of files) dfs(f);

// 3. no disk persistence (legacy importer is the only allowed reader)
for (const file of files) {
  const body = source.get(file);
  if (body.includes("writeFileSync") || body.includes("appendFileSync")) {
    problems.push(`disk write: ${rel(file)} (runtime data MongoDB me hona chahiye)`);
  }
}

if (problems.length) {
  console.error(`❌ ${problems.length} problem(s) found:\n`);
  for (const p of problems) console.error("  • " + p);
  process.exit(1);
}
console.log(`✅ checks passed (${files.length} files, 0 broken imports, 0 cycles, 0 disk writes)`);
