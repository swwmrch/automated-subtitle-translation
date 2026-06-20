# Upgrades

## Tomorrow's Checklist — QA hardening (from Codex re-check, 2026-06-20)

Verified against current code. Only the items below are still real and worth doing.

### In order

- [x] **#1 — Block-count validation can hide dropped blocks** *(High, real)*
  - `route.ts:414` calls `validateSrt(srtContent, fixed.length, lang)`. Using `fixed.length`
    as the *expected* count means if `fixSrtNumbering()` drops a block, expected and actual
    both shrink → no mismatch warning ever fires.
  - Fix: pass the original count `blocks.length` instead of `fixed.length`.

- [x] **#2 — "Smart quote" validator matches straight quotes** *(High, real)*
  - `srt.ts:143` regex codepoints are `0x27 0x27 0x22 0x22` — straight `'` and `"`, NOT
    smart quotes. It fires on every English contraction (that's why we bolted on the
    "safe to ignore" note instead of fixing the root cause).
  - Fix: `const smartQuoteRe = /[‘’“”]/u;` then drop the EN excuse note.

- [x] **#3 — Malformed JSON → 500 instead of 400** *(Medium, real)*
  - `login/route.ts:21` and `settings/route.ts:42` call `await request.json()` with no
    try/catch — bad body throws an unhandled 500.
  - Fix: wrap each in try/catch, return `400 Invalid JSON` (mirror the `formData()` guard
    already in `translate/route.ts:314`).

- [x] **#4 — Settings "Save" reports success even on failure** *(Medium, real)*
  - `app/page.tsx:87` `handleSettingsSave` never checks `res.ok`; line 93 always sets
    `"saved"`. A 401/403/429 still shows "Saved". (The unlock handler at line 74 already
    does this right — copy that pattern.)
  - Fix: check `res.ok`, surface an error state on failure.

- [x] **#5 — Electron saved API key blocked by env validation** *(Medium, real)*
  - `electron/main.js:199` runs `validateEnv()` (requires `OPENAI_API_KEY`, line 77) BEFORE
    `loadConfig()` (line 200), but a user's saved `config.customApiKey` isn't applied until
    `startNextServer` (line 131). A user who only saved a custom key still fails startup.
  - Fix: load config first, then accept `config.customApiKey` / `CUSTOM_API_KEY` as a valid
    key source in `validateEnv()`.

- [ ] **#6 — (optional, trivial) dedupe `copyDir`** *(Low)*
  - Duplicated in `scripts/copy-static.js:6` and `scripts/afterPack.js:7`. Only worth it if
    those scripts keep growing. Skip unless touching them anyway.

### Codex findings we are NOT actioning (and why)
- **Silent untranslated return** — already mitigated: per-line fallback keeps source text but
  now sets `failed=true` and emits a loud warning ("Those lines are NOT translated") at
  `route.ts:423`. Returning partial output on `done` is intentional. (Minor residual: the
  validator's untranslated check only detects Korean residue, not English — the failedBatches
  warning covers it, so leave as-is.)
- **Lint scans `dist/**`** — already fixed; `dist/**` is in `eslint.config.mjs:13` globalIgnores.
- **`test-multifile.mjs` not reproducible** — stale; that script was already deleted.
- **Large files (page.tsx 725 lines, route.ts 453)** — informational only, no behavior bug.

> Note: Codex reviewed the pre-accuracy-fix tree, so several of its findings were already
> addressed by that work. The list above is what survives against the current code.

### Second pass — Codex re-check follow-ups (2026-06-20)
- [x] **Build EPERM on `.next\app-path-routes-manifest.json`** — not a code bug; stale build
  artifact lock. `rm -rf .next && npm run build` succeeds clean. (If it recurs: close any node
  process / antivirus holding the dir, then delete `.next`.)
- [x] **Dead SRT helpers removed** — `parseTranslatedBlocks()` / `extractBlockText()` deleted
  from `lib/srt.ts` (zero callers after ID-tagged workflow; `cleanRawResponse` kept — still used
  by `parseIdBlocks`).
- [x] **`opencc-js` declared** — added to `devDependencies` (was imported by `verify-tc2.mjs`
  but undeclared; fresh installs would break).
- [x] **QA scripts are first-class** — added `qa:accuracy`, `qa:tc`, `translate:file` to
  `package.json`.
- [x] **Hard-coded script passwords removed** — `run-translation.mjs` / `fix-perline.mjs` now
  read `process.env.APP_PASSWORD` and exit with a message if unset.
- [ ] **Split `page.tsx` (726) / `route.ts` (452)** — maintainability only, no behavior bug.
  Deferred — real refactor, do deliberately not as a drive-by.
- [ ] **#6 dedupe `copyDir`** — still skipped (see above).

---

## Archive — 2026-06-19 (accuracy upgrade, shipped)

### Accuracy / correctness
- [x] **ID-based alignment** — every subtitle tagged `<<id>> text`; output matched to source by
  ID, not position. Kills the silent cross-block merge bug (model merging a sentence split
  across two subtitles, padding the batch to keep the count, shifting everything after).
  - 2 full-batch attempts requiring the exact ID set, then per-line fallback that guarantees
    1:1 alignment. Distinct warnings for `recovered` (aligned, review) vs `failed` (kept source).
- [x] **TC: NO PERIOD rule** — drop sentence-ending `。`; internal `。` → full-width space `　`;
  half-width `.` left alone so ellipses survive. Prompt rule + `stripTcPeriods()` safety net.
- [x] **Glossary particle/suffix matching (KO)** — glossary terms match their stem even with
  Korean particles attached (민준이/민준은/민준한테 → 민준).
- [x] **gpt-4o-mini removed from UI** — translation is gpt-4o only; mini kept internally for the
  cost-efficient proper-noun prepass.
- [x] Stronger TC strict rule, EN input language, multi-file input, manual + auto glossary
  (carried from the original day's list below).

### Verification
- 25 deterministic unit tests (`scripts/accuracy-test.mjs`) — ID parse, alignment, timestamp
  protection, merge recovery, transient miscount, total failure, stripTcPeriods. All pass.
- One live smoke test confirmed the ID-format prompt prevents the merge at the source.
- Delivered `superman_TC.srt` (2172 blocks, 0 English, 0 Simplified, 0 periods, aligned).

### Original 2026-06-19 feature list
- [x] #0 Strengthen TC strict rule ("strictly forbidden, zero exceptions")
- [x] #1 English as input language (EN → TC)
- [x] #2 Multiple file input (sequential, per-file progress)
- [x] #3 Glossary — manual + gpt-4o-mini auto-prepass, manual overrides auto, per-session

### Workflow
Upgrade on local → test → zip → send
