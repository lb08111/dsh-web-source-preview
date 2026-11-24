/**
 * Server registration shared by the HTTP route and the agent tool.
 *
 * A server record points at a dsh-ssh host alias. Creation therefore has two
 * modes: reference an existing repository alias, or create the host inline
 * first (the same two paths the add-server dialog offers). Starter tasks for
 * the runtime are generated once per service, never duplicated.
 */

import type { OpsServer, ServerInput } from './protocol.ts'
import type { OpsStore } from './store.ts'
import { starterTasks } from './templates.ts'
import type { OpsTransport } from './transport.ts'

/**
 * Create one server record and (optionally) the service's starter tasks.
 * @param store - definitions ledger.
 * @param transport - dsh-ssh transport (repository + host creation).
 * @param input - server payload.
 * @returns the created server and how many starter tasks were added.
 */
export function addServerWithTemplates(
  store: OpsStore,
  transport: OpsTransport,
  input: ServerInput,
): { server: OpsServer; tasks: number } {
  let sshAlias = input.sshAlias?.trim()
  let group = input.environment
  if (sshAlias === undefined || sshAlias === '') {
    const newHost = input.newHost
    if (newHost === undefined) throw new Error('sshAlias or newHost is required')
    const created = transport.createHost({
      alias: newHost.alias,
      host: newHost.host,
      port: newHost.port,
      user: newHost.user,
      auth: newHost.auth,
      environment: newHost.group,
      tags: newHost.tags,
      description: newHost.description,
    })
    sshAlias = created.alias
    group = group ?? created.environment
  } else {
    const host = transport.list().find(entry => entry.alias === sshAlias)
    if (host === undefined) throw new Error(`host '${sshAlias}' is not in the server repository`)
    group = group ?? host.environment
  }
  const server = store.createServer({
    serviceId: input.serviceId,
    sshAlias,
    name: input.name,
    environment: group,
    runtime: input.runtime,
    color: input.color,
  })
  let created = 0
  if (input.generateTemplates !== false) {
    const existing = new Set(store.tasksOfOwner('service', input.serviceId).map(task => task.name))
    for (const template of starterTasks(input.serviceId, input.runtime)) {
      if (existing.has(template.name)) continue
      store.createTask(template)
      created += 1
    }
  }
  return { server, tasks: created }
}
