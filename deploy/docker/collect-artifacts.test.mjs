import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectArtifacts } from './collect-artifacts.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-container-artifacts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = join(root, 'packages/test-plugin')
  mkdirSync(join(pkg, 'lib/types'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'test-plugin', scripts: { build: 'tsc && tsdown' }, main: 'lib/index.js', types: 'lib/types/index.d.ts' }))
  writeFileSync(join(pkg, 'lib/index.js'), 'export const built = true\n')
  writeFileSync(join(pkg, 'lib/types/index.d.ts'), 'export declare const built: true\n')
  return { root, pkg, output: join(root, 'artifacts') }
}

test('exports package libraries, declarations and copied assets without incremental caches or dependencies', (t) => {
  const { root, pkg, output } = fixture(t)
  mkdirSync(join(pkg, 'lib/assets'), { recursive: true })
  mkdirSync(join(pkg, 'node_modules'), { recursive: true })
  writeFileSync(join(pkg, 'lib/assets/mermaid.min.js'), 'var mermaid = {}\n')
  writeFileSync(join(pkg, 'lib/tsconfig.build.tsbuildinfo'), 'incremental cache')
  writeFileSync(join(pkg, 'node_modules/arm-only.node'), 'not an artifact')
  assert.deepEqual(collectArtifacts(root, output), { packages: 1, files: 3 })
  assert.equal(readFileSync(join(output, 'packages/test-plugin/lib/assets/mermaid.min.js'), 'utf8'), 'var mermaid = {}\n')
  assert.equal(existsSync(join(output, 'packages/test-plugin/lib/tsconfig.build.tsbuildinfo')), false)
  assert.equal(existsSync(join(output, 'packages/test-plugin/node_modules')), false)
})

for (const kind of ['dependency-directory', 'symlink', 'native-extension', 'native-magic', 'missing-entry']) {
  test(`rejects ${kind} in the build handoff`, (t) => {
    const { root, pkg, output } = fixture(t)
    if (kind === 'dependency-directory') mkdirSync(join(pkg, 'lib/node_modules'))
    if (kind === 'symlink') symlinkSync('index.js', join(pkg, 'lib/linked.js'))
    if (kind === 'native-extension') writeFileSync(join(pkg, 'lib/addon.node'), 'native')
    if (kind === 'native-magic') writeFileSync(join(pkg, 'lib/hidden.js'), Buffer.from('7f454c4600000000', 'hex'))
    if (kind === 'missing-entry') rmSync(join(pkg, 'lib/types/index.d.ts'))
    assert.throws(() => collectArtifacts(root, output))
    assert.equal(existsSync(output), false)
  })
}
