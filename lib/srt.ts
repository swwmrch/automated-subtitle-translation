export interface SrtBlock {
  index: number;
  timestamp: string;
  text: string;
}

export function parseSrt(content: string): SrtBlock[] {
  const normalized = content
    .replace(/^﻿/, "") // strip UTF-8 BOM
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const rawBlocks = normalized.trim().split(/\n{2,}/);
  const result: SrtBlock[] = [];

  for (const block of rawBlocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;

    const index = parseInt(lines[0].trim(), 10);
    const timestamp = lines[1].trim();
    const text = lines.slice(2).join("\n").trim();

    if (isNaN(index) || !timestamp.includes("-->") || !text) continue;
    result.push({ index, timestamp, text });
  }

  return result;
}

export function blocksToRawStrings(blocks: SrtBlock[]): string[] {
  return blocks.map((b) => `${b.index}\n${b.timestamp}\n${b.text}`);
}

// Strip LLM code fences and normalize smart quotes introduced by the model.
export function cleanRawResponse(raw: string): string {
  let clean = raw.replace(/^```[^\n]*$/gm, "");
  clean = clean.replace(/‘/g, "'").replace(/’/g, "'");
  clean = clean.replace(/“/g, '"').replace(/”/g, '"');
  return clean;
}

// Parse an ID-tagged model response (<<id>> text ... per record) into an
// id→text map. Records may span multiple lines; a record runs until the next
// <<id>> marker or end of input. This aligns output to source by ID rather
// than by position, so a merged/dropped line can be detected and retried
// individually instead of silently shifting the whole batch.
export function parseIdBlocks(raw: string): Map<number, string> {
  const clean = cleanRawResponse(raw);
  const map = new Map<number, string>();
  const re = /<<\s*(\d+)\s*>>\s*([\s\S]*?)(?=<<\s*\d+\s*>>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const id = parseInt(m[1], 10);
    const text = m[2].trim();
    if (!isNaN(id) && text) map.set(id, text);
  }
  return map;
}

// Re-number blocks and strip bare integer artifacts that leak from LLM output.
export function fixSrtNumbering(blocks: string[]): string[] {
  const fixed: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const num = i + 1;
    const lines = block.split("\n");
    if (!lines.length) continue;

    lines[0] = String(num);

    if (lines.length >= 3 && lines[1].includes("-->")) {
      const ts = lines[1].trim();
      const textLines = lines.slice(2).filter((ln) => !/^\d+$/.test(ln.trim()));
      if (textLines.length) fixed.push(`${num}\n${ts}\n${textLines.join("\n")}`);
    } else if (lines.length >= 2 && lines.some((ln) => ln.includes("-->"))) {
      const ts = lines.find((ln) => ln.includes("-->"))?.trim() ?? "";
      const textLines = lines.filter(
        (ln) => !ln.includes("-->") && !/^\d+$/.test(ln.trim())
      );
      if (ts && textLines.length) fixed.push(`${num}\n${ts}\n${textLines.join("\n")}`);
    }
  }

  return fixed;
}

// Remove full-width Chinese periods (。) from Traditional-Chinese subtitles —
// subtitle convention omits sentence-ending periods. A 。 at end of line or
// before a closing bracket/quote is dropped; a 。 between two sentences becomes
// a full-width space so the sentences don't run together. The half-width "."
// is left alone so ellipses (...) survive.
const TC_CLOSERS = "）】」』〉》＞)]}";
export function stripTcPeriods(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "。") {
          const next = line[i + 1];
          if (next === undefined || TC_CLOSERS.includes(next)) continue; // drop
          out += "　"; // internal → full-width space
        } else {
          out += ch;
        }
      }
      return out.replace(/[　\s]+$/, "");
    })
    .join("\n");
}

// On-screen captions/narration are wrapped in ( ) in the source. The model
// sometimes drops the brackets on the translation, blurring captions vs spoken
// dialogue. When the source block is a fully-bracketed caption, re-wrap the
// translated text in full-width （ ） — deterministic, like stripTcPeriods.
export function preserveCaptionBrackets(srcText: string, tcText: string): string {
  const src = srcText.trim();
  if (!(src.startsWith("(") && src.endsWith(")"))) return tcText; // source isn't a caption
  const tc = tcText.trim();
  if (!tc) return tcText;
  const hasOpen = tc.startsWith("（") || tc.startsWith("(");
  const hasClose = tc.endsWith("）") || tc.endsWith(")");
  if (hasOpen && hasClose) return tcText; // already wrapped — leave it
  let inner = tc;
  if (hasOpen) inner = inner.slice(1); // fix a stray one-sided bracket
  if (hasClose) inner = inner.slice(0, -1);
  return "（" + inner.trim() + "）";
}

export interface SrtWarning {
  type: string;
  message: string;
}

// Post-translation validation — returns warnings for known LLM output errors.
export function validateSrt(content: string, expectedBlocks: number): SrtWarning[] {
  const warnings: SrtWarning[] = [];
  const tsRe = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;
  const smartQuoteRe = /[‘’“”]/u;
  const koreanRe = /[가-힣ᄀ-ᇿ㄰-㆏]/u;

  const blocks = content
    .trim()
    .split(/\n\n+/)
    .filter((b) => b.trim());

  if (blocks.length !== expectedBlocks) {
    warnings.push({
      type: "block_count",
      message: `block count mismatch: expected ${expectedBlocks}, got ${blocks.length}`,
    });
  }

  const fenceLines: string[] = [];
  const leakedNumbers: string[] = [];
  const smartQuotes: string[] = [];
  const tsTrailing: string[] = [];
  const koreanLines: string[] = [];

  for (const b of blocks) {
    const lines = b.split("\n");
    if (!lines.length) continue;
    const idxStr = lines[0];

    lines.forEach((ln, j) => {
      if (ln.includes("`"))
        fenceLines.push(`#${idxStr} line ${j + 1}`);
      if (j >= 2 && /^\d+$/.test(ln.trim()))
        leakedNumbers.push(`#${idxStr} line ${j + 1}`);
      if (smartQuoteRe.test(ln))
        smartQuotes.push(`#${idxStr} line ${j + 1}`);
      if (j >= 2 && koreanRe.test(ln))
        koreanLines.push(`#${idxStr}`);
    });

    if (lines.length >= 2 && tsRe.test(lines[1]) && lines[1] !== lines[1].trimEnd()) {
      tsTrailing.push(`#${idxStr}`);
    }
  }

  if (fenceLines.length)
    warnings.push({ type: "fence", message: `code fence artifacts (${fenceLines.length}): ${fenceLines.slice(0, 3).join(", ")}` });
  if (leakedNumbers.length)
    warnings.push({ type: "leaked_numbers", message: `bare numbers in text (${leakedNumbers.length}): ${leakedNumbers.slice(0, 3).join(", ")}` });
  if (smartQuotes.length)
    warnings.push({ type: "smart_quotes", message: `smart quotes (${smartQuotes.length}): ${smartQuotes.slice(0, 3).join(", ")}` });
  if (tsTrailing.length)
    warnings.push({ type: "ts_trailing", message: `timestamp trailing spaces (${tsTrailing.length}): ${tsTrailing.slice(0, 3).join(", ")}` });
  if (koreanLines.length)
    warnings.push({ type: "untranslated", message: `untranslated Korean text (${koreanLines.length} blocks — batch fallback): ${koreanLines.slice(0, 5).join(", ")}` });

  return warnings;
}
