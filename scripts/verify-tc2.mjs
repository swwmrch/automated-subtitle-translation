// Reliable TC verification using opencc-js for Simplified detection.
import { readFile } from "node:fs/promises";
import * as OpenCC from "opencc-js";

const srtPath = process.argv[2];
const expected = Number(process.argv[3]);
const content = (await readFile(srtPath, "utf8")).replace(/\r\n/g, "\n").trim();
const blocks = content.split(/\n{2,}/).filter((b) => b.trim());

// Missing index check
const idxSet = new Set(blocks.map((b) => parseInt(b.split("\n")[0], 10)).filter((n) => !isNaN(n)));
const missing = [];
for (let i = 1; i <= expected; i++) if (!idxSet.has(i)) missing.push(i);

// Simplified detection: convert each text S->T; any char that CHANGES was Simplified.
const s2t = OpenCC.Converter({ from: "cn", to: "tw" });
const cjkRe = /[一-鿿]/;
const latinRe = /[A-Za-z]{2,}/;

let simpHits = [], engHits = [];
for (const blk of blocks) {
  const lines = blk.split("\n");
  const idx = lines[0];
  const text = lines.slice(2).join(" ");
  if (!text) continue;
  const converted = s2t(text);
  if (converted !== text) {
    // find which chars changed
    const changed = [];
    for (let i = 0; i < text.length; i++) {
      const a = text[i], b = s2t(a);
      if (b !== a) changed.push(`${a}→${b}`);
    }
    if (changed.length) simpHits.push(`#${idx} [${[...new Set(changed)].join(" ")}]: ${text.slice(0, 45)}`);
  }
  if (latinRe.test(text) && !cjkRe.test(text)) engHits.push(`#${idx}: ${text.slice(0, 50)}`);
}

console.log(`Blocks: ${blocks.length} (expected ${expected}) — ${blocks.length === expected ? "OK" : "MISMATCH"}`);
if (missing.length) console.log(`Missing indices: ${missing.join(", ")}`);
console.log(`\nSimplified-character blocks: ${simpHits.length}`);
simpHits.slice(0, 40).forEach((h) => console.log("  " + h));
console.log(`\nUntranslated/English lines (no CJK): ${engHits.length}`);
engHits.slice(0, 20).forEach((h) => console.log("  " + h));
