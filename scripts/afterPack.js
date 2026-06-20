// Runs after electron-builder packages the app.
// electron-builder strips node_modules from extraResources (standalone/),
// so we copy them back from the source into the packaged resources folder.
const path = require('path')
const fs = require('fs')

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

exports.default = async function afterPack(context) {
  const { appOutDir } = context
  const src = path.join(__dirname, '..', '.next', 'standalone', 'node_modules')
  const dest = path.join(appOutDir, 'resources', 'standalone', 'node_modules')

  if (!fs.existsSync(src)) {
    console.warn('[afterPack] standalone/node_modules not found — skipping')
    return
  }

  console.log('[afterPack] Copying standalone/node_modules into packaged resources...')
  copyDir(src, dest)
  console.log('[afterPack] Done.')
}
