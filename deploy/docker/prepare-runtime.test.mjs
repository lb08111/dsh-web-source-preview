import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('pins the pnpm hoisted SDK scope to the same runtime module instance', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sdk-hoist-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plugins = join(root, 'plugins')
  const runtime = join(root, 'runtime')
  function pkg(directory, name) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, main: 'index.cjs' }))
    writeFileSync(join(directory, 'index.cjs'), 'module.exports = { identity: Symbol() }\n')
    return directory
  }
  pkg(plugins, '@linxin666/dsh-web-all')
  pkg(join(plugins, 'node_modules/@linxin666/dsh-ops'), '@linxin666/dsh-ops')
  const host = pkg(join(runtime, 'node_modules/@deepseek-ai/cordis'), '@deepseek-ai/cordis')
  const hoisted = pkg(join(plugins, 'node_modules/.pnpm/node_modules/@deepseek-ai/cordis'), '@deepseek-ai/cordis')
  const absent = pkg(join(plugins, 'node_modules/.pnpm/node_modules/@deepseek-ai/host-absent'), '@deepseek-ai/host-absent')
  const consumer = pkg(join(plugins, 'node_modules/.pnpm/node_modules/consumer'), 'consumer')
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'prepare-runtime.mjs')
  const result = spawnSync(process.execPath, [helper, plugins, runtime], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(realpathSync(hoisted), realpathSync(host))
  const require = createRequire(join(consumer, 'index.cjs'))
  assert.equal(require('@deepseek-ai/cordis'), require(host))
  assert.equal(require.resolve('@deepseek-ai/host-absent'), join(absent, 'index.cjs'))
})
