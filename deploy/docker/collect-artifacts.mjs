import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORTABLE_FILE = /(?:\.[cm]?js|\.d\.[cm]?ts|\.map|\.json|\.css|\.svg|\.wasm)$/
const NATIVE_MAGIC = new Set(['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'])
const REQUIRED_ASSETS = {
  'dsh-diagrams': ['lib/assets/mermaid.min.js'],
  'dsh-web-all': ['lib/shells/package.json', 'lib/shells/shell.js', 'lib/shell.js', 'lib/degraded.js'],
}

/** Export only portable package build outputs; dependency trees stay on their own platform. */
export function collectArtifacts(sourceRoot, outputRoot) {
  sourceRoot = resolve(sourceRoot)
  outputRoot = resolve(outputRoot)
  if (existsSync(outputRoot) && readdirSync(outputRoot).length !== 0) throw new Error('Artifact destination must be empty')
  const files = []
  let packages = 0

  function inspect(path) {
    const stat = lstatSync(path)
    const name = path.split(/[\\/]/).at(-1)
    if (name === 'node_modules' || stat.isSymbolicLink()) throw new Error(`Nonportable artifact: ${path}`)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) inspect(join(path, entry))
      return
    }
    if (name.endsWith('.tsbuildinfo')) return
    if (!stat.isFile() || !PORTABLE_FILE.test(name)) throw new Error(`Unsupported build artifact: ${path}`)
    const header = readFileSync(path).subarray(0, 4)
    if (NATIVE_MAGIC.has(header.toString('hex')) || header.subarray(0, 2).toString() === 'MZ') throw new Error(`Native build artifact: ${path}`)
    files.push(path)
  }

  for (const entry of readdirSync(join(sourceRoot, 'packages'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const root = join(sourceRoot, 'packages', entry.name)
    const manifestPath = join(root, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!manifest.scripts?.build) continue
    for (const required of [manifest.main, manifest.types, existsSync(join(root, 'src/client/index.ts')) ? 'lib/client.js' : undefined, ...(REQUIRED_ASSETS[entry.name] ?? [])].filter(Boolean)) {
      if (!required.startsWith('lib/') || required.split('/').includes('..') || !existsSync(join(root, required))) throw new Error(`Missing portable entry for ${manifest.name}: ${required}`)
    }
    inspect(join(root, 'lib'))
    packages++
  }
  if (!packages) throw new Error('No built workspace packages found')
  for (const source of files) {
    const destination = join(outputRoot, relative(sourceRoot, source))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  return { packages, files: files.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, output] = process.argv.slice(2)
  if (!source || !output) throw new Error('Usage: node collect-artifacts.mjs SOURCE_ROOT OUTPUT_ROOT')
  const result = collectArtifacts(source, output)
  console.log(`Collected ${result.files} portable build artifacts from ${result.packages} workspace packages`)
}
