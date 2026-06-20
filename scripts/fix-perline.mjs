// Re-translate specific source ranges ONE BLOCK PER REQUEST (guarantees 1:1
// alignment — the model can't merge across blocks), then rebuild the whole
// output from source timestamps/order.
// Usage: node scripts/fix-perline.mjs <srcSrt> <outSrt> <lang> <inputLang> <r1,r2,...>
import { readFile, writeFile } from "node:fs/promises";

const [, , srcPath, outPath, lang, inputLang, rangesArg] = process.argv;
const BASE = "http://localhost:3000";
const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) {
  console.error("Set APP_PASSWORD before running this script.");
  process.exit(1);
}

const wanted = new Set();
for (const r of rangesArg.split(",")) {
  const [a, b] = r.split("-").map(Number);
  for (let i = a; i <= (b ?? a); i++) wanted.add(i);
}

function parseSrt(content) {
  const norm = content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return norm.trim().split(/\n{2,}/).map((blk) => {
    const lines = blk.trim().split("\n");
    if (lines.length < 2) return null;
    const index = parseInt(lines[0], 10);
    const tsLine = lines.find((l) => l.includes("-->"));
    if (isNaN(index) || !tsLine) return null;
    return { index, timestamp: tsLine.trim(), text: lines.slice(lines.indexOf(tsLine) + 1).join("\n").trim() };
  }).filter(Boolean);
}

const srcBlocks = parseSrt(await readFile(srcPath, "utf8"));
const outBlocks = parseSrt(await readFile(outPath, "utf8"));
const outByIdx = new Map(outBlocks.map((b) => [b.index, b.text]));

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
const cookie = login.headers.get("set-cookie").split(";")[0];

async function translateOne(block) {
  const mini = `1\n${block.timestamp}\n${block.text}\n`;
  const form = new FormData();
  form.append("file", new Blob([mini], { type: "text/plain" }), "one.srt");
  form.append("lang", lang);
  form.append("inputLang", inputLang);
  form.append("model", "gpt-4o");
  const res = await fetch(`${BASE}/api/translate`, { method: "POST", headers: { cookie }, body: form });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", result = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === "done") result = ev;
    }
  }
  const parsed = parseSrt(result.content);
  return parsed[0]?.text ?? block.text;
}

const targets = srcBlocks.filter((b) => wanted.has(b.index));
console.log(`Per-line re-translating ${targets.length} blocks...`);
for (const b of targets) {
  const text = await translateOne(b);
  outByIdx.set(b.index, text);
  console.log(`  ${b.index}: ${text.slice(0, 45)}`);
}

const rebuilt = srcBlocks.map((b, i) => `${i + 1}\n${b.timestamp}\n${outByIdx.get(b.index) ?? b.text}`).join("\n\n") + "\n";
await writeFile(outPath, rebuilt, "utf8");
console.log(`Rebuilt ${srcBlocks.length} blocks → ${outPath}`);
