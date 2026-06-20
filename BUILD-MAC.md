# Build the macOS local app — runbook for Claude on a Mac

You are Claude Code running on a **macOS** machine. Your job: produce a working,
zipped macOS build of the KMTV Subtitle Translator — the Mac equivalent of the
Windows `kmtv-translator.zip` that was already shipped.

The Windows build was made on Windows; **the Mac build must be made on this Mac**
(a `.app` bundle uses symlinks + executable permissions that Windows can't
produce). All the config you need is already in the repo. Follow the steps in
order. Stop and report if a step fails in a way the fallbacks don't cover.

---

## What you're producing

`dist/kmtv-translator-mac.zip` — a zipped `KMTV Subtitle Translator.app`. The end
user unzips it and double-clicks the app. No installer, no DMG. The app starts a
local Next.js server and opens a window (same behavior as the Windows build).

---

## 0. Prerequisites (verify first)

```bash
sw_vers              # macOS
node --version       # need Node 20+
git --version
```

Make sure you're in the repo and on the right branch:

```bash
git fetch origin
git checkout qa-hardening-2026-06-20
git pull --ff-only origin qa-hardening-2026-06-20
```

---

## 1. Create `.env.local` (REQUIRED — it is gitignored)

The app's Electron launcher validates the environment at startup and bakes
`.env.local` into the package. **Without it the build copies nothing and the app
refuses to start.** It is NOT in git (it holds secrets), so you must create it.

Ask the user for the values if you don't have them. Minimum required:

```bash
cat > .env.local <<'EOF'
OPENAI_API_KEY=sk-...        # the real OpenAI key (same as the Windows build)
APP_PASSWORD=...             # the team login password
EOF
```

Notes:
- `SESSION_SECRET` is auto-generated on first launch (`electron/main.js`), so you
  don't need to set it.
- A user can alternatively save a key in-app via Settings, but `APP_PASSWORD` is
  always required, so this file must exist at build time regardless.

---

## 2. Install dependencies

```bash
npm ci
```

(If `npm ci` complains about the lockfile, use `npm install`.)

---

## 3. Generate the macOS app icon (`build/icon.icns`)

`package.json` points the Mac build at `build/icon.icns`, but the repo only ships
`build/icon.ico` (Windows). Convert it using native Mac tools:

```bash
cd build
# ico -> png (sips on recent macOS reads .ico; if it fails, see fallback below)
sips -s format png icon.ico --out icon-1024.png
sips -z 1024 1024 icon-1024.png --out icon-1024.png

mkdir -p icon.iconset
for s in 16 32 64 128 256 512 1024; do
  sips -z $s $s icon-1024.png --out icon.iconset/icon_${s}x${s}.png
done
# retina (@2x) variants Apple expects
cp icon.iconset/icon_32x32.png   icon.iconset/icon_16x16@2x.png
cp icon.iconset/icon_64x64.png   icon.iconset/icon_32x32@2x.png
cp icon.iconset/icon_256x256.png icon.iconset/icon_128x128@2x.png
cp icon.iconset/icon_512x512.png icon.iconset/icon_256x256@2x.png
cp icon.iconset/icon_1024x1024.png icon.iconset/icon_512x512@2x.png

iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset icon-1024.png icon_64x64.png 2>/dev/null
cd ..
ls -la build/icon.icns      # confirm it exists
```

**Fallback if icon generation fails** (e.g. `sips` can't read the `.ico`): just
build without a custom icon — open `package.json`, delete the `"icon":
"build/icon.icns",` line inside the `"mac"` block, and continue. The app still
works; it just shows the default Electron icon. Do NOT let the icon block the build.

---

## 4. Build the unpacked app

Disable code-signing auto-discovery so the build doesn't fail on a Mac without a
developer certificate (an unsigned local app is fine):

```bash
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run package:mac
```

This runs: `next build` → copy static assets → `electron-builder --mac --dir`,
then the `afterPack` hook copies `standalone/node_modules` into the app bundle's
`Contents/Resources` (this path was fixed to be Mac-aware — verify the log line
`[afterPack] Done.` appears).

Output lands in one of:
- `dist/mac-arm64/KMTV Subtitle Translator.app`  (Apple Silicon)
- `dist/mac/KMTV Subtitle Translator.app`        (Intel)

Find it:

```bash
APP=$(find dist -maxdepth 2 -name "KMTV Subtitle Translator.app" | head -1)
echo "$APP"
```

---

## 5. Sanity-check the bundle BEFORE zipping

Confirm the standalone server and its node_modules made it inside (this is the
thing most likely to be wrong):

```bash
ls "$APP/Contents/Resources/standalone/server.js"
ls "$APP/Contents/Resources/standalone/node_modules" | head
ls "$APP/Contents/Resources/.env.local"
```

All three must exist. If `node_modules` is missing, the `afterPack` hook didn't
run or pointed at the wrong path — stop and report.

Optional smoke test (launches the app):

```bash
open "$APP"
```

It should open a window with the login screen. Quit it before zipping.

---

## 6. Zip it (preserve the bundle correctly)

Use `ditto`, NOT `zip -r` and NOT Finder's "Compress" if you want to be safe —
`ditto` preserves symlinks and permissions inside the `.app`:

```bash
ditto -c -k --sequesterRsrc --keepParent "$APP" dist/kmtv-translator-mac.zip
ls -lh dist/kmtv-translator-mac.zip
```

`--keepParent` makes the zip extract to `KMTV Subtitle Translator.app` directly.

---

## 7. Report back

Tell the user:
- the final path `dist/kmtv-translator-mac.zip` and its size,
- which arch it is (arm64 / Apple Silicon, or x64 / Intel) — it matches THIS Mac,
  so if their target Macs are a different chip, rebuild there or build the other
  arch with `electron-builder --mac --dir --<arch>`,
- whether you used the real icon or the fallback default icon,
- the Gatekeeper note below.

### Gatekeeper note for the end user (unsigned app)

The app is **not code-signed**, so on first launch macOS will warn. To open it:
- Right-click the app → **Open** → **Open** (only needed once), OR
- after unzipping: `xattr -dr com.apple.quarantine "KMTV Subtitle Translator.app"`

### Security note
The zip bundles `.env.local` with the real OpenAI API key and team password.
Keep it internal — do not post it anywhere public.
