// Structural-accuracy harness for the ID-based translation workflow.
// Imports the REAL parseIdBlocks from lib/srt.ts and replays the route's
// translateBatch algorithm against adversarial mock-model outputs (cross-block
// merges, dropped IDs, fences, multi-line, total failure). No OpenAI calls.
// Run: node scripts/accuracy-test.mjs

import { parseIdBlocks, stripTcPeriods } from "../lib/srt.ts";

// --- replay of route.ts translateBatch (ID alignment + per-line fallback) ---
function replayBatch(batchBlocks, mockBatch, mockOne) {
  const items = batchBlocks.map((b, i) => ({ id: i + 1, text: b.text }));
  // up to 2 full-batch attempts requiring the exact ID set 1..N
  for (let attempt = 1; attempt <= 2; attempt++) {
    const map = parseIdBlocks(mockBatch(items, attempt));
    if (map.size === items.length && items.every((it) => map.has(it.id))) {
      return { texts: items.map((it) => map.get(it.id)), failed: false, recovered: false };
    }
  }
  // per-line fallback
  const texts = [];
  let failed = false;
  for (const b of batchBlocks) {
    const map = parseIdBlocks(mockOne(b));
    const t = map.get(1);
    if (!t) { texts.push(b.text); failed = true; } else texts.push(t);
  }
  return { texts, failed, recovered: true };
}

function runWorkflow(blocks, mockBatch, mockOne, BATCH_SIZE = 10) {
  const all = [];
  const failedBatches = [], recoveredBatches = [];
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batchBlocks = blocks.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const { texts, failed, recovered } = replayBatch(batchBlocks, mockBatch, mockOne);
    if (failed) failedBatches.push(batchNum);
    else if (recovered) recoveredBatches.push(batchNum);
    batchBlocks.forEach((orig, j) => all.push(`${orig.index}\n${orig.timestamp}\n${texts[j] ?? orig.text}`));
  }
  return { out: all, failedBatches, recoveredBatches };
}

function makeBlocks(n) {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const sec = String(i).padStart(2, "0");
    return { index: i, timestamp: `00:00:${sec},000 --> 00:00:${sec},500`, text: `line ${i}` };
  });
}

let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const tag = (items) => items.map((it) => `<<${it.id}>> TL ${it.text}`).join("\n\n");

const blocks = makeBlocks(25); // 3 batches
const origTs = blocks.map((b) => b.timestamp);

console.log("\nTest 1 — real parseIdBlocks: ordering, multi-line, fences, smart quotes");
{
  const raw = "```\n<<2>> 第二\n行二\n\n<<1>> It’s one\n```";
  const m = parseIdBlocks(raw);
  assert("parses both ids regardless of order", m.size === 2 && m.has(1) && m.has(2));
  assert("multi-line text preserved", m.get(2) === "第二\n行二");
  assert("fences stripped & smart quote normalized", m.get(1) === "It's one");
}

console.log("\nTest 2 — clean batches align 1:1, timestamps from source");
{
  const { out, recoveredBatches, failedBatches } = runWorkflow(blocks, (items) => tag(items), () => "");
  assert("no recovery needed", recoveredBatches.length === 0 && failedBatches.length === 0);
  assert("text aligned to each block", out[0].endsWith("TL line 1") && out[24].endsWith("TL line 25"));
  assert("all source timestamps preserved", JSON.stringify(out.map((b) => b.split("\n")[1])) === JSON.stringify(origTs));
}

console.log("\nTest 3 — model corrupts timestamps: ignored (only text is used)");
{
  const mock = (items) => items.map((it) => `<<${it.id}>> 99:99 TL ${it.text}`).join("\n\n");
  const { out } = runWorkflow(blocks, mock, () => "");
  assert("timestamps still from source", JSON.stringify(out.map((b) => b.split("\n")[1])) === JSON.stringify(origTs));
}

console.log("\nTest 4 — deterministic cross-block MERGE in batch 2 → per-line recovery (the key fix)");
{
  // Batch 2 = local ids 1..10 (blocks 11..20). Model merges id1+id2 → drops id2.
  const mockBatch = (items) => {
    const isB2 = items[0].text === "line 11";
    const emit = isB2 ? items.filter((it) => it.id !== 2) : items;
    return emit.map((it) => `<<${it.id}>> TL ${it.text}`).join("\n\n");
  };
  const mockOne = (b) => `<<1>> TL ${b.text}`;
  const { out, recoveredBatches, failedBatches } = runWorkflow(blocks, mockBatch, mockOne);
  assert("batch 2 flagged as recovered (not failed)", recoveredBatches.length === 1 && recoveredBatches[0] === 2 && failedBatches.length === 0);
  assert("dropped block 12 translated correctly (no loss)", out[11] === "12\n" + origTs[11] + "\nTL line 12");
  assert("no shift — block 13 still its own text", out[12].endsWith("TL line 13"));
  assert("no duplication across 11/12", out[10].endsWith("TL line 11") && out[11].endsWith("TL line 12") && out[10] !== out[11]);
  assert("block count intact", out.length === 25);
  assert("timestamps intact through recovery", JSON.stringify(out.map((b) => b.split("\n")[1])) === JSON.stringify(origTs));
}

console.log("\nTest 5 — transient miscount fixed on 2nd full attempt (no per-line needed)");
{
  const mockBatch = (items, attempt) => {
    const emit = attempt === 1 ? items.slice(0, -1) : items; // first attempt drops last id
    return emit.map((it) => `<<${it.id}>> TL ${it.text}`).join("\n\n");
  };
  const { out, recoveredBatches } = runWorkflow(blocks, mockBatch, () => "");
  assert("recovered on retry, no per-line", recoveredBatches.length === 0);
  assert("all aligned", out.every((b, i) => b.endsWith(`TL line ${i + 1}`)));
}

console.log("\nTest 6 — total failure (per-line also fails) → source kept, flagged failed");
{
  const { out, failedBatches, recoveredBatches } = runWorkflow(blocks, () => "garbage", () => "garbage");
  assert("all 3 batches flagged failed", failedBatches.length === 3);
  assert("not counted as recovered", recoveredBatches.length === 0);
  assert("source text kept everywhere", out.every((b, i) => b.split("\n")[2] === `line ${i + 1}`));
  assert("timestamps intact", JSON.stringify(out.map((b) => b.split("\n")[1])) === JSON.stringify(origTs));
}

console.log("\nTest 7 — stripTcPeriods (NO PERIOD rule for TC)");
{
  assert("trailing period removed", stripTcPeriods("總是準時。") === "總是準時");
  assert("period before closing bracket removed", stripTcPeriods("（失去了全世界。）") === "（失去了全世界）");
  assert("internal period → full-width space", stripTcPeriods("他來了。我走了。") === "他來了　我走了");
  assert("ellipsis (half-width dots) untouched", stripTcPeriods("我聽到「小偷」...") === "我聽到「小偷」...");
  assert("other punctuation kept", stripTcPeriods("真的嗎？太好了！") === "真的嗎？太好了！");
  assert("multi-line each cleaned", stripTcPeriods("第一行。\n第二行。") === "第一行\n第二行");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
