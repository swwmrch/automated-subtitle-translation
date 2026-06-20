// Drives the REAL /api/translate endpoint end-to-end (login → upload → stream).
// Usage: node scripts/run-translation.mjs <srtPath> <lang> <inputLang> <outPath>
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const [, , srcPath, lang, inputLang, outPath] = process.argv;
const BASE = "http://localhost:3000";
const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) {
  console.error("Set APP_PASSWORD before running this script.");
  process.exit(1);
}

function getCookie(res) {
  const sc = res.headers.get("set-cookie");
  return sc ? sc.split(";")[0] : null;
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
if (!login.ok) { console.error("Login failed", login.status, await login.text()); process.exit(1); }
const cookie = getCookie(login);
console.log("Logged in.");

const buf = await readFile(srcPath);
const form = new FormData();
form.append("file", new Blob([buf], { type: "text/plain" }), basename(srcPath));
form.append("lang", lang);
form.append("inputLang", inputLang);
form.append("model", "gpt-4o");

console.log(`Translating ${basename(srcPath)} → ${lang} (source ${inputLang})...`);
const t0 = Date.now();
const res = await fetch(`${BASE}/api/translate`, { method: "POST", headers: { cookie }, body: form });
if (!res.ok) { console.error("Translate failed", res.status, await res.text()); process.exit(1); }

const reader = res.body.getReader();
const dec = new TextDecoder();
let buffer = "";
let result = null;
let lastBatch = 0;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += dec.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    let ev;
    try { ev = JSON.parse(line.slice(6)); } catch { continue; }
    if (ev.type === "start") console.log(`  blocks=${ev.total} batches=${ev.batches}`);
    else if (ev.type === "prepass") console.log("  pre-pass: extracting proper nouns...");
    else if (ev.type === "progress") {
      if (ev.batch === 1 || ev.batch % 20 === 0 || ev.batch === ev.of) {
        const pct = Math.round((ev.batch / ev.of) * 100);
        console.log(`  batch ${ev.batch}/${ev.of} (${pct}%) — ${Math.round((Date.now()-t0)/1000)}s`);
      }
      lastBatch = ev.batch;
    } else if (ev.type === "done") { result = ev; }
    else if (ev.type === "error") { console.error("  ERROR:", ev.message); process.exit(1); }
  }
}

if (!result) { console.error("No result received. Last batch:", lastBatch); process.exit(1); }

await writeFile(outPath, result.content, "utf8");
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`\nDONE in ${secs}s — ${result.blocks} blocks → ${outPath}`);
if (result.warnings?.length) {
  console.log("WARNINGS:");
  for (const w of result.warnings) console.log("  ⚠ " + w);
} else {
  console.log("No warnings.");
}
