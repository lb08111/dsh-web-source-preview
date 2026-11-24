import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function bootstrap({ pluginsRoot = '/opt/dsh/plugins' } = {}) {
  const home = process.env.DSH_HOME || '/data'
  const profile = join(home, 'profiles/web')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(process.env.HOME || join(home, 'home'), { recursive: true, mode: 0o700 })
  const previousEntry = join(home, '.browser-entry')
  if (existsSync(previousEntry)) unlinkSync(previousEntry)
  const family = JSON.parse(readFileSync(join(pluginsRoot, 'container-family.json'), 'utf8'))
  for (const entry of family) {
    const path = join(home, 'profiles/node_modules', entry.name)
    mkdirSync(dirname(path), { recursive: true })
    let current
    try {
      current = lstatSync(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (current && !current.isSymbolicLink()) continue
    if (current && readlinkSync(path) === entry.path) continue
    const temporary = `${path}.container-${randomUUID()}.tmp`
    try {
      symlinkSync(entry.path, temporary)
      renameSync(temporary, path)
    } finally {
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  const manifestPath = join(profile, 'package.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  for (const bundle of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@linxin666/dsh-web-all']) {
    if (!manifest.dsh.profile.bundles.includes(bundle)) manifest.dsh.profile.bundles.push(bundle)
  }
  writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  renameSync(manifestPath + '.tmp', manifestPath)
  const patch = join(profile, 'cordis.patch.yml')
  if (!existsSync(patch)) {
    writeFileSync(patch, [
      '- id: web-ui-ssh',
      '  disabled: false',
      '  config:',
      '    announceToAgent: true',
      '- id: session-log-deepseek',
      '  config:',
      '    enabled: false',
      '',
    ].join('\n'), { mode: 0o600 })
  }
}
