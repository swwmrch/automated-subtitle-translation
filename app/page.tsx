"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import EyeIcon from "@/app/components/EyeIcon";

type Lang = "EN" | "TC";
type InputLang = "KO" | "EN";
type Status = "idle" | "translating" | "done" | "error";
type SettingsStep = "locked" | "unlocked" | "saved";

interface TranslateResult {
  lang: Lang;
  content: string;
  blocks: number;
  warnings: string[];
}

interface FileResult {
  fileName: string;
  results: TranslateResult[];
  error?: string;
}

export default function HomePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [inputLangs, setInputLangs] = useState<InputLang[]>([]);
  const [dragging, setDragging] = useState(false);
  const [langs, setLangs] = useState<Lang[]>(["EN"]);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState({ fileIndex: 0, fileCount: 0, batch: 0, of: 0, lang: "" });
  const [prepass, setPrepass] = useState(false);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [notes, setNotes] = useState("");
  const [glossary, setGlossary] = useState("");

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false);
  const [settingsStep, setSettingsStep] = useState<SettingsStep>("locked");
  const [settingsPassword, setSettingsPassword] = useState("");
  const [showSettingsPassword, setShowSettingsPassword] = useState(false);
  const [settingsPasswordError, setSettingsPasswordError] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  function openSettings() {
    setSettingsStep("locked");
    setSettingsPassword("");
    setShowSettingsPassword(false);
    setSettingsPasswordError("");
    setApiKey("");
    setShowApiKey(false);
    setShowSettings(true);
  }

  function closeSettings() {
    setShowSettings(false);
  }

  async function handleSettingsUnlock(e: React.FormEvent) {
    e.preventDefault();
    setSettingsPasswordError("");
    setUnlocking(true);
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: settingsPassword }),
    });
    if (res.ok) {
      const data = await res.json();
      setApiKey(data.apiKey ?? "");
      setSettingsStep("unlocked");
    } else {
      setSettingsPasswordError("Incorrect password.");
    }
    setUnlocking(false);
  }

  async function handleSettingsSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveError("");
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: settingsPassword, apiKey }),
      });
      if (res.ok) {
        setSettingsStep("saved");
      } else {
        setSaveError("Could not save. Please try again.");
      }
    } catch {
      setSaveError("Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function toggleLang(lang: Lang) {
    setLangs((prev) =>
      prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang]
    );
  }

  // Auto-detect source language per file: Korean if any Hangul is present,
  // otherwise English. Each file can be overridden individually below.
  function detectInputLang(text: string): InputLang {
    return /[가-힣]/.test(text) ? "KO" : "EN";
  }

  async function handleFilesSelect(selected: File[]) {
    setFiles(selected);
    const detected = await Promise.all(
      selected.map(async (f) => detectInputLang(await f.text()))
    );
    setInputLangs(detected);
    // If every file is English, the default "EN" output target is a no-op
    // (EN→EN), so switch the still-default selection to Traditional Chinese.
    if (detected.length > 0 && detected.every((l) => l === "EN")) {
      setLangs((prev) => (prev.length === 1 && prev[0] === "EN" ? ["TC"] : prev));
    }
  }

  function setFileInputLang(index: number, lang: InputLang) {
    setInputLangs((prev) => prev.map((l, i) => (i === index ? lang : l)));
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setInputLangs((prev) => prev.filter((_, i) => i !== index));
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const dropped = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.toLowerCase().endsWith(".srt")
    );
    if (dropped.length > 0) handleFilesSelect(dropped);
  }

  async function runTranslation(fileToTranslate: File, fileInputLang: InputLang, lang: Lang): Promise<TranslateResult> {
    const formData = new FormData();
    formData.append("file", fileToTranslate);
    formData.append("lang", lang);
    formData.append("inputLang", fileInputLang);
    formData.append("model", "gpt-4o");
    if (notes.trim()) formData.append("notes", notes.trim());
    if (glossary.trim()) formData.append("glossary", glossary.trim());

    const res = await fetch("/api/translate", { method: "POST", body: formData });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let event: any;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        if (event.type === "prepass") {
          setPrepass(true);
        } else if (event.type === "progress") {
          setPrepass(false);
          setProgress((prev) => ({ ...prev, batch: event.batch, of: event.of, lang }));
        } else if (event.type === "done") {
          return { lang, content: event.content, blocks: event.blocks, warnings: event.warnings ?? [] };
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    }

    throw new Error("Stream ended without a result");
  }

  async function handleTranslate() {
    if (files.length === 0 || langs.length === 0) return;

    setStatus("translating");
    setFileResults([]);

    const allFileResults: FileResult[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setProgress({ fileIndex: i + 1, fileCount: files.length, batch: 0, of: 0, lang: "" });
      setPrepass(false);

      const fileResult: FileResult = { fileName: f.name, results: [] };
      const src = inputLangs[i] ?? "KO";
      // Skip targets identical to the source language (e.g. EN→EN).
      const targets = langs.filter((l) => l !== src);

      if (targets.length === 0) {
        fileResult.error = "Nothing to translate — the source language matches the only selected output. Pick a different output language.";
      } else {
        try {
          for (const lang of targets) {
            const result = await runTranslation(f, src, lang);
            fileResult.results.push(result);
          }
        } catch (err) {
          fileResult.error = String(err);
        }
      }

      allFileResults.push(fileResult);
      setFileResults([...allFileResults]);
    }

    setStatus(allFileResults.some((fr) => fr.error) ? "error" : "done");
  }

  function handleClear() {
    setFiles([]);
    setInputLangs([]);
    setLangs(["EN"]);
    setStatus("idle");
    setFileResults([]);
    setProgress({ fileIndex: 0, fileCount: 0, batch: 0, of: 0, lang: "" });
    setPrepass(false);
    setNotes("");
    setGlossary("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function downloadResult(fileName: string, result: TranslateResult) {
    const baseName = fileName.replace(/_KO\.srt$/i, "").replace(/\.srt$/i, "");
    const blob = new Blob([result.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}_${result.lang}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const isTranslating = status === "translating";
  const progressPct = progress.of > 0 ? Math.round((progress.batch / progress.of) * 100) : 0;

  const langLabel = (lang: Lang) =>
    lang === "EN" ? "English" : "Traditional Chinese";

  // Per-file source-language toggle (Korean / English).
  const renderSourceToggle = (index: number, justify: "center" | "end" = "center") => (
    <div className={`flex gap-1.5 ${justify === "center" ? "justify-center" : "justify-end"}`}>
      {(["KO", "EN"] as InputLang[]).map((il) => (
        <button
          key={il}
          onClick={(e) => { e.stopPropagation(); setFileInputLang(index, il); }}
          disabled={isTranslating}
          className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:cursor-not-allowed ${
            inputLangs[index] === il
              ? "bg-blue-50 border-blue-300 text-blue-600"
              : "bg-white border-gray-200 text-gray-500 hover:border-gray-300 disabled:opacity-50"
          }`}
        >
          {il === "KO" ? "Korean" : "English"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* Settings Modal */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) closeSettings(); }}
        >
          <div className="bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-sm mx-4 p-6">

            {/* Modal header */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <p className="text-sm font-semibold text-gray-900">API Key</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {settingsStep === "locked"
                    ? "Enter the team password to continue"
                    : settingsStep === "unlocked"
                    ? "View or change the OpenAI API key"
                    : "API key saved"}
                </p>
              </div>
              <button
                onClick={closeSettings}
                className="text-gray-300 hover:text-gray-500 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Step 1 — Password */}
            {settingsStep === "locked" && (
              <form onSubmit={handleSettingsUnlock} className="space-y-4">
                <div>
                  <label htmlFor="s-password" className="block text-xs font-medium text-gray-600 mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="s-password"
                      type={showSettingsPassword ? "text" : "password"}
                      value={settingsPassword}
                      onChange={(e) => { setSettingsPassword(e.target.value); setSettingsPasswordError(""); }}
                      className={`w-full px-3 py-2 pr-10 border rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:border-transparent transition-colors ${
                        settingsPasswordError ? "border-red-400 focus:ring-red-400" : "border-gray-300 focus:ring-blue-400"
                      }`}
                      placeholder="Team password"
                      autoFocus
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSettingsPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                      tabIndex={-1}
                    >
                      <EyeIcon open={showSettingsPassword} />
                    </button>
                  </div>
                  {settingsPasswordError && <p className="text-xs text-red-600 mt-1">{settingsPasswordError}</p>}
                </div>
                <button
                  type="submit"
                  disabled={unlocking || !settingsPassword}
                  className="w-full bg-blue-400 hover:bg-blue-500 disabled:bg-gray-200 disabled:cursor-not-allowed text-white font-medium py-2 rounded-lg text-sm transition-colors"
                >
                  {unlocking ? "Checking…" : "Unlock"}
                </button>
              </form>
            )}

            {/* Step 2 — API Key */}
            {settingsStep === "unlocked" && (
              <form onSubmit={handleSettingsSave} className="space-y-4">
                <div>
                  <label htmlFor="s-apikey" className="block text-xs font-medium text-gray-600 mb-1">
                    OpenAI API Key
                  </label>
                  <div className="relative">
                    <input
                      id="s-apikey"
                      type={showApiKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent font-mono"
                      placeholder="sk-proj-..."
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                      tabIndex={-1}
                    >
                      <EyeIcon open={showApiKey} />
                    </button>
                  </div>
                </div>
                {saveError && <p className="text-xs text-red-600">{saveError}</p>}
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full bg-gray-900 hover:bg-gray-700 disabled:bg-gray-200 disabled:cursor-not-allowed text-white font-medium py-2 rounded-lg text-sm transition-colors"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </form>
            )}

            {/* Step 3 — Saved */}
            {settingsStep === "saved" && (
              <div className="text-center space-y-4 py-2">
                <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm text-gray-600">API key saved.</p>
                <button
                  onClick={closeSettings}
                  className="w-full bg-gray-900 hover:bg-gray-700 text-white font-medium py-2 rounded-lg text-sm transition-colors"
                >
                  Done
                </button>
              </div>
            )}

          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="bg-blue-400 text-white text-xs font-bold px-2 py-0.5 rounded">
              KMTV
            </span>
            <span className="text-sm font-medium text-gray-700">Subtitle Translator</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={openSettings}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Settings
            </button>
            <span className="text-gray-200">|</span>
            <button
              onClick={handleLogout}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* 3-column layout */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6 md:px-6 md:py-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

          {/* LEFT — Input */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-col gap-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Source</p>

            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`
                flex-1 border-2 border-dashed rounded-xl cursor-pointer transition-colors
                flex flex-col items-center justify-center min-h-48 md:min-h-72 p-6 text-center
                ${dragging
                  ? "border-blue-400 bg-blue-50"
                  : "border-gray-200 hover:border-gray-300 bg-gray-50 hover:bg-white"}
              `}
            >
              {files.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-5xl text-gray-200">↑</p>
                  <p className="text-sm text-gray-500">
                    Drop your <span className="font-semibold text-gray-700">.srt</span> files here
                  </p>
                  <p className="text-xs text-gray-400">or click to browse</p>
                  <p className="text-xs text-gray-300 mt-3">Korean & English · auto-detected · Max 500 KB per file</p>
                </div>
              ) : (
                <div className="space-y-3 w-full">
                  {files.length === 1 ? (
                    <div className="text-center space-y-2" onClick={(e) => e.stopPropagation()}>
                      <div className="text-4xl">📄</div>
                      <p className="text-sm font-medium text-gray-800 break-all leading-snug">{files[0].name}</p>
                      <p className="text-xs text-gray-400">{(files[0].size / 1024).toFixed(1)} KB</p>
                      <div className="pt-2">
                        <p className="text-xs text-gray-400 mb-1.5">Source language</p>
                        {renderSourceToggle(0, "center")}
                      </div>
                    </div>
                  ) : (
                    <div onClick={(e) => e.stopPropagation()}>
                      <p className="text-sm font-medium text-gray-700 mb-2 text-center">{files.length} files queued</p>
                      <p className="text-xs text-gray-400 mb-2 text-center">Source language is auto-detected per file — adjust any that are wrong.</p>
                      <div className="space-y-1.5 max-h-64 overflow-y-auto">
                        {files.map((f, i) => (
                          <div key={i} className="bg-gray-100 rounded-lg px-2.5 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs text-gray-600 truncate min-w-0">{f.name}</span>
                              <button
                                onClick={() => removeFile(i)}
                                disabled={isTranslating}
                                className="shrink-0 text-gray-300 hover:text-gray-500 disabled:cursor-not-allowed transition-colors text-base leading-none"
                              >
                                ×
                              </button>
                            </div>
                            <div className="mt-1.5">{renderSourceToggle(i, "end")}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-gray-300 text-center">Click to replace</p>
                </div>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".srt"
              multiple
              className="hidden"
              onChange={(e) => {
                const selected = Array.from(e.target.files ?? []).filter((f) =>
                  f.name.toLowerCase().endsWith(".srt")
                );
                if (selected.length > 0) handleFilesSelect(selected);
              }}
            />
          </div>

          {/* CENTER — Settings */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-col gap-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Settings</p>

            {/* Language */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Translate to</label>
              <div className="flex flex-col gap-2">
                {(["EN", "TC"] as Lang[]).map((lang) => (
                  <button
                    key={lang}
                    onClick={() => toggleLang(lang)}
                    disabled={isTranslating}
                    className={`
                      w-full px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors text-left
                      disabled:cursor-not-allowed
                      ${langs.includes(lang)
                        ? "bg-blue-50 border-blue-300 text-blue-600"
                        : "bg-white border-gray-200 text-gray-600 hover:border-gray-300 disabled:opacity-50"}
                    `}
                  >
                    {langLabel(lang)}
                  </button>
                ))}
              </div>
              {langs.includes("EN") && inputLangs.includes("EN") && (
                <p className="text-xs text-gray-400">English-source files skip the English output automatically.</p>
              )}
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">
                Translator notes{" "}
                <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={isTranslating}
                rows={3}
                placeholder="e.g. Romantic K-drama, formal speech between colleagues"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent resize-none disabled:bg-gray-50 disabled:text-gray-400"
              />
              <p className="text-xs text-gray-400">Describe the genre or tone so the translator can adapt.</p>
            </div>

            {/* Glossary */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">
                Glossary{" "}
                <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={glossary}
                onChange={(e) => setGlossary(e.target.value)}
                disabled={isTranslating}
                rows={4}
                placeholder={"이준혁 = Lee Joon-hyuk\n김태리 = Kim Tae-ri"}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent resize-none disabled:bg-gray-50 disabled:text-gray-400 font-mono"
              />
              <p className="text-xs text-gray-400">One term per line: source = translation. Use it to lock character-name spellings or fix recurring terms. Applied to every file.</p>
            </div>

            <div className="flex-1" />

            <button
              onClick={handleTranslate}
              disabled={files.length === 0 || langs.length === 0 || isTranslating}
              className="w-full bg-gray-900 hover:bg-gray-700 disabled:bg-gray-200 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-xl text-sm transition-colors"
            >
              {isTranslating
                ? `Translating… (${progress.fileIndex} of ${progress.fileCount})`
                : files.length > 1
                ? `Translate ${files.length} files`
                : "Translate"}
            </button>

            {(files.length > 0 || fileResults.length > 0) && !isTranslating && (
              <button
                onClick={handleClear}
                className="w-full border border-gray-200 hover:border-gray-300 text-gray-400 hover:text-gray-600 font-medium py-2 rounded-xl text-sm transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* RIGHT — Output */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-col gap-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Output</p>

            {!isTranslating && fileResults.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                  <span className="text-gray-300 text-lg">↓</span>
                </div>
                <p className="text-sm text-gray-400">Translated files will appear here</p>
              </div>
            )}

            {isTranslating && (
              <div className="space-y-3">
                {progress.fileCount > 1 && (
                  <p className="text-xs text-gray-400 font-medium">
                    File {progress.fileIndex} of {progress.fileCount}
                  </p>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">
                    {prepass
                      ? "Detecting names…"
                      : progress.of === 0
                      ? "Starting…"
                      : `${langLabel(progress.lang as Lang)} — Batch ${progress.batch} of ${progress.of}`}
                  </span>
                  <span className="text-gray-400">{prepass || progress.of === 0 ? "" : `${progressPct}%`}</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full bg-blue-400 rounded-full transition-all duration-300 ${prepass || progress.of === 0 ? "w-0" : ""}`}
                    style={prepass || progress.of === 0 ? undefined : { width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {fileResults.length > 0 && (
              <div className="space-y-3">
                {!isTranslating && (
                  <p className="text-xs text-gray-400">
                    {status === "done" ? "Ready to download" : "Completed"}
                  </p>
                )}
                {isTranslating && fileResults.length > 0 && (
                  <p className="text-xs text-gray-400">
                    Completed ({fileResults.length} of {progress.fileCount})
                  </p>
                )}
                {fileResults.map((fr, fi) => (
                  <div key={fi} className="border border-gray-200 rounded-xl overflow-hidden">
                    <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5">
                      <p className="text-xs font-medium text-gray-600 truncate">{fr.fileName}</p>
                    </div>
                    {fr.error ? (
                      <div className="px-4 py-3 text-xs text-red-600 bg-red-50 break-words">{fr.error}</div>
                    ) : (
                      fr.results.map((r) => (
                        <div key={r.lang}>
                          <div className="p-4 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-800 truncate">{langLabel(r.lang)}</p>
                              <p className="text-xs text-gray-400">{r.blocks} blocks</p>
                            </div>
                            <button
                              onClick={() => downloadResult(fr.fileName, r)}
                              className="shrink-0 bg-gray-900 hover:bg-gray-700 text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors"
                            >
                              Download .srt
                            </button>
                          </div>
                          {r.warnings.length > 0 && (
                            <div className="border-t border-amber-100 bg-amber-50 px-4 py-3 space-y-1">
                              {r.warnings.map((w, i) => (
                                <p key={i} className="text-xs text-amber-700 break-words">⚠ {w}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  );
}
