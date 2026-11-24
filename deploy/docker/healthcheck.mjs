const base = process.env.DSH_INTERNAL_URL || 'http://127.0.0.1:3080'

async function read(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(3000) })
  if (response.status !== 200) throw new Error(`${path} returned ${response.status}`)
  return response.json()
}

try {
  const root = await fetch(base + '/', { signal: AbortSignal.timeout(3000) })
  if (![200, 401].includes(root.status)) throw new Error(`Web entry returned ${root.status}`)
  const degraded = await read('/api/dsh-web-all/degraded')
  if (degraded.ok !== true || !Array.isArray(degraded.degraded) || degraded.degraded.length > 0) {
    throw new Error('One or more family plugins are degraded')
  }
  const tree = await read('/api/dsh-ops/tree')
  if (!tree.tree || typeof tree.tree !== 'object') throw new Error('The operations tree is unavailable')
  const ssh = await read('/api/dsh-ssh/hosts')
  if (!Array.isArray(ssh.hosts)) throw new Error('The SSH host repository is unavailable')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
