// Deterministic unit + replay tests for Fix A (fixSrtNumbering keeps numeric
// captions) and Fix B (validateSrt names the missing cue). No API calls.
import { fixSrtNumbering, validateSrt, parseSrt } from "../lib/srt.ts";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL: " + name); }
}

console.log("== Fix A: fixSrtNumbering ==");
// 1. A cue whose only text is a number must survive (the ep243 #978 bug).
{
  const out = fixSrtNumbering(["1\n00:39:18,499 --> 00:39:20,969\n105"]);
  ok("numeric-only caption '105' is kept", out.length === 1 && out[0].endsWith("\n105"));
}
// 2. A stray leaked index is still stripped when real text remains.
{
  const out = fixSrtNumbering(["1\n00:00:01,000 --> 00:00:02,000\n你好\n6"]);
  ok("leaked trailing number stripped, text kept", out.length === 1 && out[0].endsWith("\n你好"));
}
// 3. Normal text is untouched.
{
  const out = fixSrtNumbering(["1\n00:00:01,000 --> 00:00:02,000\nHello there"]);
  ok("normal text untouched", out[0].endsWith("\nHello there"));
}
// 4. Multiple cues renumber sequentially and none drop.
{
  const out = fixSrtNumbering([
    "7\n00:00:01,000 --> 00:00:02,000\nA",
    "8\n00:00:02,000 --> 00:00:03,000\n105",
    "9\n00:00:03,000 --> 00:00:04,000\nB",
  ]);
  ok("3 in -> 3 out (no drop)", out.length === 3);
  ok("renumbered 1,2,3", out.map(b => b.split("\n")[0]).join(",") === "1,2,3");
  ok("middle numeric cue '105' survived", out[1].endsWith("\n105"));
}
// 5. Empty/garbage blocks are ignored (no crash, no phantom cue).
{
  const out = fixSrtNumbering(["", "1\n00:00:01,000 --> 00:00:02,000\nA"]);
  ok("garbage block ignored", out.length === 1);
}

console.log("\n== Fix B: validateSrt missing-cue pinpoint ==");
const src = parseSrt(
  "1\n00:00:01,000 --> 00:00:02,000\nWhat's 100 plus 5?\n\n" +
  "2\n00:00:02,000 --> 00:00:03,000\n105.\n\n" +
  "3\n00:00:03,000 --> 00:00:04,000\nWhat was that?\n"
);
// Output is missing cue #2 (the "105." one).
const outMissing =
  "1\n00:00:01,000 --> 00:00:02,000\n那100加5呢\n\n" +
  "2\n00:00:03,000 --> 00:00:04,000\n剛剛那是什麼\n";
{
  const w = validateSrt(outMissing, 3, src).find(x => x.type === "block_count");
  ok("warns on count mismatch", !!w);
  ok("names the missing source cue #2", !!w && w.message.includes("source #2"));
  ok("includes the missing text snippet", !!w && w.message.includes("105."));
}
{
  // No source blocks -> still works, just no detail (backward compatible).
  const w = validateSrt(outMissing, 3).find(x => x.type === "block_count");
  ok("backward-compatible without sourceBlocks", !!w && !w.message.includes("missing"));
}
{
  // Correct count -> no block_count warning.
  const good =
    "1\n00:00:01,000 --> 00:00:02,000\n那100加5呢\n\n" +
    "2\n00:00:02,000 --> 00:00:03,000\n105\n\n" +
    "3\n00:00:03,000 --> 00:00:04,000\n剛剛那是什麼\n";
  const w = validateSrt(good, 3, src).find(x => x.type === "block_count");
  ok("no warning when counts match", !w);
}

console.log("\n== Replay on real files ==");
const DIR = "/Users/march/KMTV/file/srt/2026_06_22/";
function load(p) { return readFileSync(p, "utf8"); }
const en242 = parseSrt(load(DIR + "Superman 242[EN].srt"));
const en243 = parseSrt(load(DIR + "Superman 243[EN].srt"));
const tc243 = load(DIR + "Superman 243[EN]_TC.srt");
{
  const w = validateSrt(load(DIR + "Superman 242[EN]_TC.srt"), en242.length, en242)
    .find(x => x.type === "block_count");
  ok("ep242 (clean) -> no block_count warning", !w);
}
{
  const w = validateSrt(tc243, en243.length, en243).find(x => x.type === "block_count");
  ok("ep243 (fixed) -> no block_count warning", !w);
}
{
  // Synthesize the original broken output by dropping cue #978 from the real
  // file — the warning must point straight at source #978.
  const broken = tc243
    .replace(/\r/g, "")
    .trim()
    .split(/\n{2,}/)
    .filter((b) => b.split("\n")[0].trim() !== "978")
    .join("\n\n") + "\n";
  const w = validateSrt(broken, en243.length, en243).find(x => x.type === "block_count");
  ok("ep243 with #978 dropped -> warning names source #978", !!w && w.message.includes("source #978"));
  if (w) console.log("    msg: " + w.message);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
