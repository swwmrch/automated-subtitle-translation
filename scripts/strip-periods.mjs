// Apply the TC no-period rule to an existing SRT file (no API calls).
// Usage: node scripts/strip-periods.mjs <srtPath>
import { readFile, writeFile } from "node:fs/promises";
import { stripTcPeriods } from "../lib/srt.ts";

const path = process.argv[2];
const content = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
const blocks = content.trim().split(/\n{2,}/);
let periodsBefore = (content.match(/。/g) || []).length;

const out = blocks.map((blk) => {
  const lines = blk.split("\n");
  const tsPos = lines.findIndex((l) => l.includes("-->"));
  if (tsPos < 0) return blk;
  const head = lines.slice(0, tsPos + 1).join("\n");
  const text = stripTcPeriods(lines.slice(tsPos + 1).join("\n"));
  return `${head}\n${text}`;
}).join("\n\n") + "\n";

let periodsAfter = (out.match(/。/g) || []).length;
await writeFile(path, out, "utf8");
console.log(`${path}: removed ${periodsBefore - periodsAfter} periods (${periodsBefore} → ${periodsAfter})`);
