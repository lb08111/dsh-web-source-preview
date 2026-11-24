import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [pluginsArgument, runtimeArgument] = process.argv.slice(2)
if (!pluginsArgument || !runtimeArgument) throw new Error('Usage: prepare-runtime.mjs <plugins> <runtime>')
const plugins = realpathSync(resolve(pluginsArgument))
const runtime = realpathSync(resolve(runtimeArgument))
const hostScope = join(runtime, 'node_modules/@deepseek-ai')
const visited = new Set()

function link(target, destination) {
  let present = false
  try {
    present = lstatSync(destination) !== undefined
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (present && existsSync(destination) && realpathSync(destination) === realpathSync(target)) return
  if (present) rmSync(destination, { recursive: true, force: true })
  mkdirSync(resolve(destination, '..'), { recursive: true })
  symlinkSync(target, destination)
}

function pinDependencies(directory, isModulesDirectory = false) {
  const actual = realpathSync(directory)
  if (visited.has(actual) || (actual !== plugins && !actual.startsWith(plugins + '/'))) return
  visited.add(actual)
  const modules = isModulesDirectory ? directory : join(directory, 'node_modules')
  if (!existsSync(modules)) return
  const scope = join(modules, '@deepseek-ai')
  if (existsSync(scope)) {
    for (const name of readdirSync(scope)) {
      const target = join(hostScope, name)
      if (existsSync(target)) link(target, join(scope, name))
    }
  }
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '@deepseek-ai') continue
    const path = join(modules, entry.name)
    if (entry.name === '.pnpm') {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (child.isDirectory()) pinDependencies(join(path, child.name), child.name === 'node_modules')
      }
    } else if (entry.name.startsWith('@')) {
      for (const child of readdirSync(path)) pinDependencies(join(path, child))
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      pinDependencies(path)
    }
  }
}

// Legacy pnpm deploy leaves the package's self-reference at the build tree.
link(plugins, join(plugins, 'node_modules/@linxin666/dsh-web-all'))
const rootScope = join(plugins, 'node_modules/@deepseek-ai')
mkdirSync(rootScope, { recursive: true })
for (const name of readdirSync(hostScope)) link(join(hostScope, name), join(rootScope, name))
pinDependencies(plugins)

const family = [{ name: '@linxin666/dsh-web-all', path: plugins }]
const scope = join(plugins, 'node_modules/@linxin666')
for (const name of readdirSync(scope)) {
  if (name === 'dsh-web-all') continue
  const path = join(scope, name)
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  family.push({ name: manifest.name, path: realpathSync(path) })
}
if (!family.some(entry => entry.name === '@linxin666/dsh-ops')) throw new Error('The production bundle must include dsh-ops')
for (const entry of family) {
  if (!entry.path.startsWith(plugins)) throw new Error(`Dependency escapes the production bundle: ${entry.name}`)
}
writeFileSync(join(plugins, 'container-family.json'), JSON.stringify(family, null, 2) + '\n')
console.log(`Prepared ${family.length} family packages with the official host SDK`)
