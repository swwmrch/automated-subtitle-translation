import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session";
import { parseSrt, blocksToRawStrings, parseIdBlocks, stripTcPeriods, preserveCaptionBrackets, fixSrtNumbering, validateSrt, type SrtBlock } from "@/lib/srt";
import OpenAI from "openai";

export const maxDuration = 300;

const BATCH_SIZE = 25;
const MAX_RETRIES = 3;
const RETRY_SLEEP_MS = 5000;
const BATCH_SLEEP_MS = 1500;
const MAX_FILE_SIZE = 512 * 1024; // 500 KB
const ALLOWED_MODELS = ["gpt-4o"] as const;
const MAX_CONTEXT_BLOCKS = 2; // trailing blocks carried into the next batch for consistency
const PERLINE_SLEEP_MS = 400; // throttle between per-line fallback calls
const OPENAI_REQUEST_TIMEOUT_MS = 60_000;

const enc = new TextEncoder();
type GptModel = (typeof ALLOWED_MODELS)[number];
type InputLang = "KO" | "EN";

const MAX_NOTES_LENGTH = 300;
const MAX_GLOSSARY_LENGTH = 1000;
// Whole-episode proper-noun scan budget (text only). ~30k tokens on gpt-4o-mini
// — a full episode's text is ~15k tokens, so most files are scanned in full;
// only unusually large files get evenly sampled across the timeline.
const MAX_PREPASS_CHARS = 120_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemPrompt(outputLang: "EN" | "TC", inputLang: InputLang): string {
  const base =
    inputLang === "KO"
      ? "You are a professional Korean subtitle translator specializing in Korean entertainment — " +
        "K-dramas, variety shows, and TV programmes. " +
        "You preserve the natural emotional tone, conversational rhythm, and cultural nuance of every line. " +
        "You are expert at Korean honorifics, onomatopoeia, and subtitle formatting."
      : "You are a professional subtitle translator. " +
        "You preserve the natural emotional tone, conversational rhythm, and cultural nuance of every line. " +
        "You are expert at subtitle formatting.";

  if (outputLang === "TC") {
    return (
      base +
      " You translate into Traditional Chinese as used in Taiwan (台灣繁體中文/台灣華語). " +
      "Simplified Chinese characters, Mainland Chinese expressions, and Mainland Chinese vocabulary are strictly forbidden, zero exceptions — use Taiwan Mandarin exclusively."
    );
  }
  return base;
}

// Build the proper-noun extraction sample from the WHOLE episode (text only —
// indices/timestamps just waste budget). Characters get introduced throughout a
// show, so scanning only the opening misses most names. Oversized files are
// sampled evenly across the full timeline so late-introduced names are still seen.
function buildPrepassSample(blocks: SrtBlock[]): string {
  const all = blocks.map((b) => b.text).join("\n");
  if (all.length <= MAX_PREPASS_CHARS) return all;
  const step = Math.ceil(all.length / MAX_PREPASS_CHARS);
  return blocks
    .filter((_, i) => i % step === 0)
    .map((b) => b.text)
    .join("\n")
    .slice(0, MAX_PREPASS_CHARS);
}

async function extractAutoGlossary(
  client: OpenAI,
  blocks: SrtBlock[],
  outputLang: "EN" | "TC",
  inputLang: InputLang
): Promise<string> {
  const sample = buildPrepassSample(blocks);
  const srcLabel = inputLang === "KO" ? "Korean" : "English";
  const targetLabel = outputLang === "TC" ? "Traditional Chinese (Taiwan Mandarin)" : "English";
  // The extracted terms are injected into every batch as HIGHEST-PRIORITY glossary
  // entries, so this pre-pass MUST honor the same Traditional-only rule as the main
  // translator — otherwise Simplified renderings here override the main prompt and
  // bleed into the final output for every occurrence of that name.
  const tcRule =
    outputLang === "TC"
      ? " Translate into Traditional Chinese as used in Taiwan (台灣繁體中文/台灣華語); " +
        "Simplified Chinese characters are strictly forbidden, zero exceptions."
      : "";
  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            `You extract proper nouns — specific named entities only — from ${srcLabel} subtitle text and translate them into ${targetLabel}.${tcRule} ` +
            `You never include common words, generic nouns, verbs, or everyday phrases. Output only a plain list, nothing else.`,
        },
        {
          role: "user",
          content:
            `From the ${srcLabel} subtitles below, extract ONLY proper nouns — specific named entities that actually appear in the text:\n` +
            `- People's names (characters, real people)\n` +
            `- Place names (cities, countries, mountains, landmarks)\n` +
            `- Brand, group, and organization names\n` +
            `- Titles of shows, songs, or films, and recurring segment names\n\n` +
            `Do NOT include common words, generic nouns, verbs, adjectives, greetings, or everyday phrases ` +
            `(e.g. "hello", "water", "love", "thank you", "let's go"). When in doubt, leave it out.\n\n` +
            `List each unique term only once. Do not repeat entries. Output at most 40 lines. Translate each into ${targetLabel}.\n\n` +
            `Return ONLY a plain list, one per line, in this exact format:\n` +
            `source term → Translation\n\n` +
            `No headings, no explanations, nothing else.\n\n---\n\n${sample}`,
        },
      ],
      temperature: 0,
    });
    return res.choices[0].message.content?.trim() ?? "";
  } catch {
    return "";
  }
}

function mergeGlossaries(auto: string, manual: string): string {
  const parse = (raw: string): Map<string, string> => {
    const map = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const t = line.trim();
      // Accept "=" (what users type), plus "→" and "->" (auto-glossary / legacy).
      const sep = t.includes("→") ? "→" : t.includes("->") ? "->" : t.includes("=") ? "=" : null;
      if (!sep) continue;
      const idx = t.indexOf(sep);
      const src = t.slice(0, idx).trim();
      const tgt = t.slice(idx + sep.length).trim();
      if (src && tgt) map.set(src, tgt);
    }
    return map;
  };
  const merged = new Map([...parse(auto), ...parse(manual)]); // manual overrides auto
  if (merged.size === 0) return "";
  return Array.from(merged.entries()).map(([k, v]) => `${k} → ${v}`).join("\n");
}

function formatGlossarySection(glossaryRaw: string, inputLang: InputLang): string {
  const entries = glossaryRaw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("→") || l.includes("->"))
    .map((l) => "  - " + l.replace("->", "→"));
  if (entries.length === 0) return "";
  // Korean attaches particles/suffixes directly to nouns (민준이, 민준은, 민준한테),
  // so a glossary term must match its stem regardless of what follows.
  const stemRule =
    inputLang === "KO"
      ? `\nMatch each source term even when Korean particles or suffixes are attached ` +
        `(e.g. 민준이, 민준은, 민준한테, 민준아 all map to the 민준 entry).`
      : "";
  return (
    `\nGlossary (HIGHEST PRIORITY — these mappings override every other guideline above, ` +
    `including the name romanization/transliteration rules) — apply them exactly, every occurrence:\n` +
    `${entries.join("\n")}${stemRule}\n`
  );
}

function outputRules(count: number, contextLine: string): string {
  return (
    `\nOutput format:\n` +
    `- Tag every translation with its exact ID marker: \`<<id>> translated text\`\n` +
    `- Return exactly ${count} entries — one per ID, using the SAME ID numbers you were given (never renumber)\n` +
    `- CRITICAL: translate each ID separately. NEVER merge two subtitles into one entry or split one into two, ` +
    `even when consecutive lines form a single sentence — keep them as separate entries\n` +
    `- Preserve line breaks inside an entry — a 2-line subtitle stays 2 lines\n` +
    `- Return ONLY the tagged entries — no commentary, no extra text\n` +
    `- Do NOT wrap output in markdown code blocks (no \`\`\` fences)\n` +
    `- Use straight apostrophes (') not curly/smart apostrophes (’)` +
    `${contextLine}`
  );
}

function formatContinuitySection(prevContext: string): string {
  if (!prevContext) return "";
  return (
    `\nContinuity — the immediately preceding lines were already translated as shown below. ` +
    `Keep names, terminology, tone, and pronoun choices consistent with them. ` +
    `Do NOT re-translate these or include them in your output:\n${prevContext}\n`
  );
}

interface IdItem {
  id: number;
  text: string;
}

function buildPrompt(
  items: IdItem[],
  outputLang: "EN" | "TC",
  inputLang: InputLang,
  notes: string,
  glossary: string,
  prevContext: string
): string {
  const count = items.length;
  const body = items.map((it) => `<<${it.id}>> ${it.text}`).join("\n\n");
  const contextLine = notes ? `\nContext from user: ${notes}` : "";
  const srcLabel = inputLang === "KO" ? "Korean" : "English";
  const glossarySection = formatGlossarySection(glossary, inputLang);
  const continuitySection = formatContinuitySection(prevContext);

  if (outputLang === "TC") {
    const koreanLines =
      inputLang === "KO"
        ? `- Render Korean honorifics naturally: 언니→姊姊, 오빠→哥哥/歐巴, 선배→學長/學姐, 아저씨→大叔/叔叔\n` +
          `- Transliterate Korean names using Taiwan phonetic conventions, unless the glossary specifies a different rendering\n`
        : "";
    // Static content (guidelines + glossary + output rules) is placed FIRST so it
    // forms an identical prefix across every batch of a file — OpenAI caches it.
    // The per-batch dynamic content (continuity + the lines) goes LAST.
    return (
      `Translate the ${count} ID-tagged ${srcLabel} subtitle lines below into Traditional Chinese (台灣華語/繁體中文).\n\n` +
      `Guidelines:\n` +
      `- Simplified Chinese characters, Mainland Chinese expressions, and Mainland Chinese vocabulary are strictly forbidden, zero exceptions — use Taiwan Mandarin exclusively\n` +
      `- Taiwan Mandarin vocabulary: 捷運 not 地鐵, 計程車 not 出租車, 機車 not 摩托車, 影片 not 視頻, 軟體 not 軟件\n` +
      `- Do NOT use the full stop 。 — omit sentence-ending periods (subtitle convention); keep other punctuation (，、？！…「」)\n` +
      `- Match the register to the speaker and line type: spoken dialogue reads naturally and colloquially (口語化), on-screen captions/narration in their fitting style — never stiff or textbook-like\n` +
      `- Localize idioms and slang — don't translate them word-for-word; use the natural Taiwanese expression that carries the same meaning and feeling\n` +
      koreanLines +
      `- Keep subtitles concise and screen-readable` +
      glossarySection +
      outputRules(count, contextLine) +
      continuitySection +
      `\n\n---\n\n${body}`
    );
  }

  return (
    `Translate the ${count} ID-tagged Korean subtitle lines below into natural English.\n\n` +
    `Guidelines:\n` +
    `- Render Korean honorifics naturally: 언니→"unnie", 오빠→"oppa", 선배→"sunbae", 아저씨→"mister" (adapt to context)\n` +
    `- Keep Korean names romanized (e.g. 민준→Min-jun, 지수→Ji-su), unless the glossary specifies a different spelling\n` +
    `- Convert Korean onomatopoeia to natural English equivalents (ㅋㅋ→laughter, ㅠㅠ→sadness)\n` +
    `- Keep subtitles concise and screen-readable` +
    glossarySection +
    outputRules(count, contextLine) +
    continuitySection +
    `\n\n---\n\n${body}`
  );
}

interface BatchResult {
  texts: string[]; // translated text per block, aligned to the input batch
  failed: boolean; // true when some block could not be translated (source kept)
  recovered: boolean; // true when alignment was recovered via per-line fallback
}

// Single model round-trip for a set of ID-tagged items; returns id→text.
async function callModel(
  client: OpenAI,
  items: IdItem[],
  outputLang: "EN" | "TC",
  inputLang: InputLang,
  model: GptModel,
  notes: string,
  glossary: string,
  prevContext: string
): Promise<Map<number, string>> {
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(outputLang, inputLang) },
      { role: "user", content: buildPrompt(items, outputLang, inputLang, notes, glossary, prevContext) },
    ],
    temperature: 0.2,
  });
  return parseIdBlocks(res.choices[0].message.content?.trim() ?? "");
}

// Translate one block in isolation — the model cannot merge across blocks here,
// so this guarantees 1:1 alignment. Returns null only on persistent failure.
async function translateOne(
  client: OpenAI,
  block: SrtBlock,
  outputLang: "EN" | "TC",
  inputLang: InputLang,
  model: GptModel,
  notes: string,
  glossary: string
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const map = await callModel(client, [{ id: 1, text: block.text }], outputLang, inputLang, model, notes, glossary, "");
      const t = map.get(1);
      if (t) return t;
    } catch {
      // retry
    }
    if (attempt < MAX_RETRIES) await sleep(RETRY_SLEEP_MS);
  }
  return null;
}

async function translateBatch(
  client: OpenAI,
  batchBlocks: SrtBlock[],
  outputLang: "EN" | "TC",
  inputLang: InputLang,
  model: GptModel,
  notes: string,
  glossary: string,
  prevContext: string
): Promise<BatchResult> {
  // Batch-local IDs 1..N keep numbers small and let us detect exactly which
  // lines the model merged/dropped — alignment is by ID, never by position.
  const items: IdItem[] = batchBlocks.map((b, i) => ({ id: i + 1, text: b.text }));

  // Two full-batch attempts: handles transient errors and the occasional
  // miscount. A clean result requires the exact set of IDs 1..N.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const map = await callModel(client, items, outputLang, inputLang, model, notes, glossary, prevContext);
      if (map.size === items.length && items.every((it) => map.has(it.id))) {
        return { texts: items.map((it) => map.get(it.id)!), failed: false, recovered: false };
      }
    } catch {
      // fall through
    }
    if (attempt < 2) await sleep(RETRY_SLEEP_MS);
  }

  // Per-line fallback — guarantees alignment when the batch couldn't be matched
  // (e.g. the model deterministically merges a sentence split across two lines).
  const texts: string[] = [];
  let failed = false;
  for (let j = 0; j < batchBlocks.length; j++) {
    const t = await translateOne(client, batchBlocks[j], outputLang, inputLang, model, notes, glossary);
    if (t === null) {
      texts.push(batchBlocks[j].text); // keep source text on persistent failure
      failed = true;
    } else {
      texts.push(t);
    }
    if (j < batchBlocks.length - 1) await sleep(PERLINE_SLEEP_MS);
  }
  return { texts, failed, recovered: true };
}

export async function POST(request: NextRequest) {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.isLoggedIn) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const openaiClient = new OpenAI({
    apiKey: session.customApiKey ?? process.env.CUSTOM_API_KEY ?? process.env.OPENAI_API_KEY,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
  });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new NextResponse("Invalid form data", { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const lang = formData.get("lang") as string | null;
  const inputLangParam = (formData.get("inputLang") as string | null) ?? "KO";
  const modelParam = (formData.get("model") as string | null) ?? "gpt-4o";
  const notes = ((formData.get("notes") as string | null)?.trim() ?? "").slice(0, MAX_NOTES_LENGTH);
  const glossary = ((formData.get("glossary") as string | null)?.trim() ?? "").slice(0, MAX_GLOSSARY_LENGTH);

  if (!file) return new NextResponse("No file provided", { status: 400 });
  if (!lang || !["EN", "TC"].includes(lang))
    return new NextResponse("lang must be EN or TC", { status: 400 });
  if (!["KO", "EN"].includes(inputLangParam))
    return new NextResponse("inputLang must be KO or EN", { status: 400 });
  if (inputLangParam === "EN" && lang === "EN")
    return new NextResponse("Cannot translate English to English", { status: 400 });
  const inputLang = inputLangParam as InputLang;
  if (!ALLOWED_MODELS.includes(modelParam as GptModel))
    return new NextResponse("Invalid model", { status: 400 });
  const model = modelParam as GptModel;
  if (!file.name.toLowerCase().endsWith(".srt"))
    return new NextResponse("Only .srt files accepted", { status: 400 });
  if (file.size > MAX_FILE_SIZE)
    return new NextResponse("File too large (max 500 KB)", { status: 413 });

  const content = await file.text();
  const blocks = parseSrt(content);

  if (blocks.length === 0)
    return new NextResponse("No valid SRT blocks found in file", { status: 422 });

  const rawBlocks = blocksToRawStrings(blocks);
  const totalBatches = Math.ceil(rawBlocks.length / BATCH_SIZE);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

      send({ type: "start", total: blocks.length, batches: totalBatches });

      try {
        send({ type: "prepass" });
        const autoGlossary = await extractAutoGlossary(openaiClient, blocks, lang as "EN" | "TC", inputLang);
        const effectiveGlossary = mergeGlossaries(autoGlossary, glossary);

        const allTranslated: string[] = [];
        const failedBatches: number[] = [];
        const recoveredBatches: number[] = [];
        let prevContext = "";

        for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
          const batchBlocks = blocks.slice(i, i + BATCH_SIZE);
          const batchNum = Math.floor(i / BATCH_SIZE) + 1;

          send({ type: "progress", batch: batchNum, of: totalBatches });

          const { texts, failed, recovered } = await translateBatch(
            openaiClient,
            batchBlocks,
            lang as "EN" | "TC",
            inputLang,
            model,
            notes,
            effectiveGlossary,
            prevContext
          );
          if (failed) failedBatches.push(batchNum);
          else if (recovered) recoveredBatches.push(batchNum);

          // TC subtitle convention: drop sentence-ending periods (safety net in
          // case the model ignores the prompt rule). Leave failed (source) text.
          const cleanTexts =
            lang === "TC" && !failed
              ? texts.map((t, j) => preserveCaptionBrackets(batchBlocks[j].text, stripTcPeriods(t)))
              : texts;

          // Re-attach the ORIGINAL timestamps — never trust the model's timing.
          batchBlocks.forEach((orig, j) => {
            allTranslated.push(`${orig.index}\n${orig.timestamp}\n${cleanTexts[j] ?? orig.text}`);
          });

          // Carry the last few source→target pairs into the next batch so
          // names, tone, and terminology stay consistent across batches.
          const ctxCount = Math.min(MAX_CONTEXT_BLOCKS, batchBlocks.length);
          prevContext = batchBlocks
            .slice(-ctxCount)
            .map((b, k) => {
              const tgt = cleanTexts[cleanTexts.length - ctxCount + k] ?? "";
              return `${b.text.replace(/\n/g, " ")} → ${tgt.replace(/\n/g, " ")}`;
            })
            .join("\n");

          if (i + BATCH_SIZE < blocks.length) await sleep(BATCH_SLEEP_MS);
        }

        const fixed = fixSrtNumbering(allTranslated);
        const srtContent = fixed.join("\n\n") + "\n";
        const validationWarnings = validateSrt(srtContent, blocks.length, blocks);
        const warnings = validationWarnings.map((w) => w.message);
        if (recoveredBatches.length) {
          warnings.unshift(
            `${recoveredBatches.length} batch(es) needed line-by-line recovery for alignment ` +
              `(batch ${recoveredBatches.slice(0, 8).join(", ")}${recoveredBatches.length > 8 ? "…" : ""}) — ` +
              `translated and aligned correctly, but worth a quick review.`
          );
        }
        if (failedBatches.length) {
          warnings.unshift(
            `${failedBatches.length} batch(es) could not be translated and kept the original text ` +
              `(batch ${failedBatches.slice(0, 8).join(", ")}${failedBatches.length > 8 ? "…" : ""}). ` +
              `Those lines are NOT translated — re-run or check the API key/quota.`
          );
        }

        send({
          type: "done",
          content: srtContent,
          blocks: fixed.length,
          warnings,
        });
      } catch {
        send({ type: "error", message: "Translation failed. Please try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
