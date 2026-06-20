// Copies public/ and .next/static/ into .next/standalone/ after next build.
// Required because standalone server.js does not bundle them by default.
const fs = require('fs')
const path = require('path')

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Skipping (not found): ${src}`)
    return
  }
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(srcPath, destPath)
    else fs.copyFileSync(srcPath, destPath)
  }
}

const root = path.join(__dirname, '..')
copyDir(path.join(root, 'public'),        path.join(root, '.next/standalone/public'))
copyDir(path.join(root, '.next/static'),  path.join(root, '.next/standalone/.next/static'))

console.log('✓ Static assets copied to .next/standalone/')
