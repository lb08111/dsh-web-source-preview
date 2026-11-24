/**
 * The ops workspace panel: a free-form tree on the left (system → service →
 * server → shared task) and the selected node's workspace on the right.
 *
 * AI authoring intentionally has no chat surface here: the "AI 写脚本" hint
 * points at the native DSH conversation, where the agent uses the ops tools
 * plus dsh-ssh's ssh_exec. The panel only owns the tree, task editing, runs and
 * logs.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { OpsApi } from '../api.ts'
import { tt } from '../locales.ts'
import type { OpsController, OpsNodeKind, OpsSelection } from './controller.ts'
import { publishScript } from '../../templates.ts'
import { isValidCron, nextRunAtMs } from '../../schedule.ts'
import type {
  FlowFailure,
  FlowStep,
  OpsRun,
  OpsServer,
  OpsService,
  OpsSystem,
  OpsTask,
  RepoHost,
  RunSummary,
  RuntimeKind,
  ServerInput,
  TaskInput,
  TaskParam,
  TaskParamType,
  TaskRisk,
  TreeSnapshot,
} from '../../protocol.ts'
import css from './panel.module.css'

/** Error text from anything thrown. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stable key for one selection. */
export function selectionKey(selection: OpsSelection): string {
  return `${selection.kind}:${selection.id ?? ''}`
}

const ACCENT_PRESETS = ['#22d3ee', '#818cf8', '#34d399', '#f59e0b', '#f472b6', '#60a5fa', '#a78bfa', '#f87171']

const DEFAULT_ACCENTS = {
  system: '#22d3ee',
  service: '#818cf8',
  server: '#34d399',
  task: '#f59e0b',
} as const

/** Where "back one level" goes for the current selection. */
function parentOf(
  selection: OpsSelection,
  tree: TreeSnapshot,
  runs: RunSummary[],
): { kind: OpsNodeKind; id?: string; label: string } | undefined {
  const root = { kind: 'root' as const, label: tt('root.allSystems') }
  if (selection.kind === 'system') return root
  if (selection.kind === 'service') {
    const service = tree.services.find(entry => entry.id === selection.id)
    const system = service === undefined ? undefined : tree.systems.find(entry => entry.id === service.systemId)
    return system === undefined ? root : { kind: 'system', id: system.id, label: system.name }
  }
  if (selection.kind === 'server') {
    const server = tree.servers.find(entry => entry.id === selection.id)
    const service = server === undefined ? undefined : tree.services.find(entry => entry.id === server.serviceId)
    return service === undefined ? root : { kind: 'service', id: service.id, label: service.name }
  }
  if (selection.kind === 'task') {
    const task = tree.tasks.find(entry => entry.id === selection.id)
    if (task === undefined) return root
    if (task.owner.kind === 'system') {
      const system = tree.systems.find(entry => entry.id === task.owner.id)
      return system === undefined ? root : { kind: 'system', id: system.id, label: system.name }
    }
    const service = tree.services.find(entry => entry.id === task.owner.id)
    return service === undefined ? root : { kind: 'service', id: service.id, label: service.name }
  }
  if (selection.kind === 'run') {
    const run = runs.find(entry => entry.id === selection.id)
    const task = run === undefined ? undefined : tree.tasks.find(entry => entry.id === run.taskId)
    return task === undefined ? root : { kind: 'task', id: task.id, label: task.name }
  }
  return undefined
}

/** Dialog state owned by the panel. */
type Dialog =
  | { kind: 'system' }
  | { kind: 'service'; systemId: string }
  | { kind: 'add-server'; serviceId: string }
  | { kind: 'task'; serviceId: string }
  | { kind: 'run'; taskId: string; serverId?: string }
  | { kind: 'edit-system'; systemId: string }
  | { kind: 'edit-service'; serviceId: string }
  | { kind: 'edit-server'; serverId: string }

interface OpsPanelProps {
  controller: OpsController
  api: OpsApi
}

/** Panel root: data loading + card workspace + dialogs. */
export function OpsPanel({ controller, api }: OpsPanelProps) {
  const { selection, refreshToken } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [tree, setTree] = useState<TreeSnapshot>()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [error, setError] = useState<string>()
  const [dialog, setDialog] = useState<Dialog>()
  const [search, setSearch] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [nextTree, nextRuns] = await Promise.all([api.tree(), api.runs(30)])
      setTree(nextTree)
      setRuns(nextRuns)
      setError(undefined)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [api])

  useEffect(() => { void reload() }, [reload])

  // Host-issued commands bump refreshToken; reload without touching selection.
  const refreshSeen = useRef(refreshToken)
  useEffect(() => {
    if (refreshSeen.current === refreshToken) return
    refreshSeen.current = refreshToken
    void reload()
  }, [refreshToken, reload])

  const select = (kind: OpsNodeKind, id?: string): void => {
    controller.select({ kind, id })
  }

  const taskTargets = (task: OpsTask): OpsServer[] => {
    const targetsOf = (candidate: OpsTask): OpsServer[] => {
      if (candidate.scope === 'single') {
        const server = tree?.servers.find(entry => entry.id === candidate.serverId)
        return server === undefined ? [] : [server]
      }
      if (candidate.owner.kind === 'service') {
        return tree?.servers.filter(server => server.serviceId === candidate.owner.id) ?? []
      }
      const serviceIds = new Set(tree?.services.filter(service => service.systemId === candidate.owner.id).map(service => service.id) ?? [])
      return tree?.servers.filter(server => serviceIds.has(server.serviceId)) ?? []
    }
    if (task.kind !== 'flow') return targetsOf(task)
    const reachable = new Set<string>()
    for (const step of task.steps ?? []) {
      const referenced = tree?.tasks.find(entry => entry.id === step.taskId && entry.kind === 'script')
      if (referenced === undefined) continue
      for (const server of targetsOf(referenced)) {
        if (step.serverIds === undefined || step.serverIds.includes(server.id)) reachable.add(server.id)
      }
    }
    return tree?.servers.filter(server => reachable.has(server.id)) ?? []
  }

  const editingSystem = dialog?.kind === 'edit-system'
    ? tree?.systems.find(entry => entry.id === dialog.systemId)
    : undefined
  const editingService = dialog?.kind === 'edit-service'
    ? tree?.services.find(entry => entry.id === dialog.serviceId)
    : undefined
  const editingServer = dialog?.kind === 'edit-server'
    ? tree?.servers.find(entry => entry.id === dialog.serverId)
    : undefined
  const parent = tree === undefined ? undefined : parentOf(selection, tree, runs)

  return (
    <div className={css.panel} data-dsh-plugin="ops">
      <header className={css.header}>
        <button type="button" className={css.back} onClick={() => { controller.close() }}>‹ {tt('panel.back')}</button>
        {parent !== undefined && (
          <button
            type="button"
            className={css.backLevel}
            title={parent.label}
            onClick={() => { select(parent.kind, parent.id) }}
          >
            ‹ {tt('panel.backLevel')}
            <em>{parent.label}</em>
          </button>
        )}
        <h2 className={css.title}>{tt('panel.title')}</h2>
        <input
          className={css.headerSearch}
          placeholder={tt('tree.search')}
          value={search}
          onChange={(event) => { setSearch(event.target.value) }}
        />
        <button type="button" className={css.btn} onClick={() => { void reload() }}>{tt('action.refresh')}</button>
        <button type="button" className={css.btnPrimary} onClick={() => { setDialog({ kind: 'system' }) }}>+ {tt('tree.newSystem')}</button>
      </header>

      {error !== undefined && (
        <div className={css.error}>{tt('error.title')}: {error}</div>
      )}

      <div className={css.body}>
        {tree === undefined && <div className={css.empty}>{tt('common.loading')}</div>}
        {tree !== undefined && (
          <main className={css.content}>
            {search.trim() === '' ? (
              <Content
                tree={tree}
                runs={runs}
                selection={selection}
                api={api}
                controller={controller}
                reload={reload}
                openDialog={setDialog}
                select={select}
              />
            ) : (
              <div className={css.workspace}>
                <Breadcrumbs items={[{ label: tt('root.searchResults') }, { label: search.trim() }]} />
                <SearchResults
                  tree={tree}
                  query={search.trim()}
                  onSelect={(kind, id) => { setSearch(''); select(kind, id) }}
                />
              </div>
            )}
          </main>
        )}
      </div>

      {dialog?.kind === 'system' && (
        <TextDialog
          title={tt('tree.newSystem')}
          label={tt('common.name')}
          submitLabel={tt('action.create')}
          onSubmit={async (name) => {
            const system = await api.createSystem(name)
            await reload()
            select('system', system.id)
            setDialog(undefined)
          }}
          onClose={() => { setDialog(undefined) }}
        />
      )}
      {dialog?.kind === 'service' && (
        <TextDialog
          title={tt('tree.addService')}
          label={tt('common.name')}
          submitLabel={tt('action.create')}
          onSubmit={async (name) => {
            const service = await api.createService(dialog.systemId, name)
            await reload()
            select('service', service.id)
            setDialog(undefined)
          }}
          onClose={() => { setDialog(undefined) }}
        />
      )}
      {dialog?.kind === 'add-server' && (
        <AddServerDialog
          api={api}
          serviceId={dialog.serviceId}
          onClose={() => { setDialog(undefined) }}
          onDone={async (server) => {
            await reload()
            select('server', server.id)
            setDialog(undefined)
          }}
        />
      )}
      {dialog?.kind === 'task' && (
        <NewTaskDialog
          api={api}
          serviceId={dialog.serviceId}
          onClose={() => { setDialog(undefined) }}
          onDone={async (task) => {
            await reload()
            select('task', task.id)
            setDialog(undefined)
          }}
        />
      )}
      {dialog?.kind === 'run' && tree !== undefined && (() => {
        const task = tree.tasks.find(entry => entry.id === dialog.taskId)
        if (task === undefined) return null
        return (
          <RunDialog
            api={api}
            task={task}
            servers={taskTargets(task)}
            preselected={dialog.serverId}
            onClose={() => { setDialog(undefined) }}
            onStarted={(run) => {
              setDialog(undefined)
              select('run', run.id)
              void reload()
            }}
          />
        )
      })()}
      {editingSystem !== undefined && (
        <EditSystemDialog
          api={api}
          system={editingSystem}
          onClose={() => { setDialog(undefined) }}
          onDone={async () => { await reload(); setDialog(undefined) }}
        />
      )}
      {editingService !== undefined && (
        <EditServiceDialog
          api={api}
          service={editingService}
          onClose={() => { setDialog(undefined) }}
          onDone={async () => { await reload(); setDialog(undefined) }}
        />
      )}
      {editingServer !== undefined && (
        <EditServerDialog
          api={api}
          server={editingServer}
          onClose={() => { setDialog(undefined) }}
          onDone={async () => { await reload(); setDialog(undefined) }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- search

/** Card-based global search results. */
function SearchResults({ tree, query, onSelect }: {
  tree: TreeSnapshot
  query: string
  onSelect: (kind: OpsNodeKind, id?: string) => void
}) {
  const needle = query.toLowerCase()
  const systems = tree.systems.filter(system => system.name.toLowerCase().includes(needle))
  const services = tree.services.filter(service => service.name.toLowerCase().includes(needle))
  const servers = tree.servers.filter(server => server.sshAlias.toLowerCase().includes(needle) || server.name.toLowerCase().includes(needle))
  const tasks = tree.tasks.filter(task => task.name.toLowerCase().includes(needle))
  if (systems.length + services.length + servers.length + tasks.length === 0) {
    return <div className={css.empty}>{tt('common.none')}</div>
  }
  return (
    <div className={css.resultGrid}>
      {systems.map(system => (
        <button key={system.id} type="button" className={css.resultCard} onClick={() => { onSelect('system', system.id) }}>
          <span className={css.cardGlyph}>◈</span><b>{system.name}</b><em>{tt('system.services')}</em>
        </button>
      ))}
      {services.map(service => (
        <button key={service.id} type="button" className={css.resultCard} onClick={() => { onSelect('service', service.id) }}>
          <span className={css.cardGlyph}>◇</span><b>{service.name}</b><em>{tt('service.servers')}</em>
        </button>
      ))}
      {servers.map(server => (
        <button key={server.id} type="button" className={css.resultCard} onClick={() => { onSelect('server', server.id) }}>
          <span className={css.cardGlyph}>▣</span><b>{server.sshAlias}</b><em>{tt('server.runtime')}</em>
        </button>
      ))}
      {tasks.map(task => (
        <button key={task.id} type="button" className={css.resultCard} onClick={() => { onSelect('task', task.id) }}>
          <span className={css.cardGlyph}>{task.kind === 'flow' ? '⇉' : '⌁'}</span><b>{task.name}</b>
          <em>{task.kind === 'flow' ? tt('task.flow') : tt('service.tasks')}</em>
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- content

interface ContentProps {
  tree: TreeSnapshot
  runs: RunSummary[]
  selection: OpsSelection
  api: OpsApi
  controller: OpsController
  reload: () => Promise<void>
  openDialog: (dialog: Dialog) => void
  select: (kind: OpsNodeKind, id?: string) => void
}

/** One breadcrumb step. */
interface Crumb {
  label: string
  onClick?: () => void
}

/** Breadcrumb trail for a drill-down. */
function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className={css.crumbs}>
      {items.map((item, index) => (
        <span key={`${item.label}:${index}`} className={css.crumb}>
          {index > 0 && <span className={css.crumbSep}>/</span>}
          {item.onClick === undefined
            ? <span className={css.crumbCurrent}>{item.label}</span>
            : <button type="button" className={css.crumbLink} onClick={item.onClick}>{item.label}</button>}
        </span>
      ))}
    </nav>
  )
}

/** Page frame: breadcrumbs above the selected view. */
function Workspace({ crumbs, children }: { crumbs: Crumb[]; children: ReactNode }) {
  return (
    <div className={css.workspace}>
      <Breadcrumbs items={crumbs} />
      {children}
    </div>
  )
}

/** Resolve the selected node into one card workspace. */
function Content(props: ContentProps) {
  const { tree, selection, select } = props
  const root: Crumb = { label: tt('root.allSystems'), onClick: () => { select('root') } }

  if (selection.kind === 'system') {
    const system = tree.systems.find(entry => entry.id === selection.id)
    if (system !== undefined) {
      return <Workspace crumbs={[root, { label: system.name }]}><SystemView {...props} system={system} /></Workspace>
    }
  }
  if (selection.kind === 'service') {
    const service = tree.services.find(entry => entry.id === selection.id)
    if (service !== undefined) {
      const system = tree.systems.find(entry => entry.id === service.systemId)
      const crumbs: Crumb[] = [root]
      if (system !== undefined) crumbs.push({ label: system.name, onClick: () => { select('system', system.id) } })
      crumbs.push({ label: service.name })
      return <Workspace crumbs={crumbs}><ServiceView {...props} service={service} /></Workspace>
    }
  }
  if (selection.kind === 'server') {
    const server = tree.servers.find(entry => entry.id === selection.id)
    if (server !== undefined) {
      const service = tree.services.find(entry => entry.id === server.serviceId)
      const system = service === undefined ? undefined : tree.systems.find(entry => entry.id === service.systemId)
      const crumbs: Crumb[] = [root]
      if (system !== undefined) crumbs.push({ label: system.name, onClick: () => { select('system', system.id) } })
      if (service !== undefined) crumbs.push({ label: service.name, onClick: () => { select('service', service.id) } })
      crumbs.push({ label: server.sshAlias })
      return <Workspace crumbs={crumbs}><ServerView {...props} server={server} /></Workspace>
    }
  }
  if (selection.kind === 'task') {
    const task = tree.tasks.find(entry => entry.id === selection.id)
    if (task !== undefined) {
      const service = tree.services.find(entry => entry.id === task.owner.id)
      const system = service === undefined ? undefined : tree.systems.find(entry => entry.id === service.systemId)
      const crumbs: Crumb[] = [root]
      if (system !== undefined) crumbs.push({ label: system.name, onClick: () => { select('system', system.id) } })
      if (service !== undefined) crumbs.push({ label: service.name, onClick: () => { select('service', service.id) } })
      crumbs.push({ label: task.name })
      return <Workspace crumbs={crumbs}><TaskView {...props} task={task} key={task.id} /></Workspace>
    }
  }
  if (selection.kind === 'run' && selection.id !== undefined) {
    const crumbs: Crumb[] = [root, { label: tt('run.breadcrumb'), onClick: () => { select('root') } }, { label: selection.id }]
    return <Workspace crumbs={crumbs}><RunView api={props.api} runId={selection.id} select={props.select} onRefresh={props.reload} /></Workspace>
  }
  return <Workspace crumbs={[root]}><RootView {...props} /></Workspace>
}

/** How many servers a task targets by default. */
function taskTargetCount(task: OpsTask, tree: TreeSnapshot): number {
  if (task.kind === 'flow') return 0
  if (task.scope === 'single') {
    return task.serverId === undefined ? 0 : tree.servers.filter(server => server.id === task.serverId).length
  }
  if (task.owner.kind === 'service') {
    return tree.servers.filter(server => server.serviceId === task.owner.id).length
  }
  const serviceIds = new Set(tree.services.filter(service => service.systemId === task.owner.id).map(service => service.id))
  return tree.servers.filter(server => serviceIds.has(server.serviceId)).length
}

/** Landing overview: one card per system. */
function RootView({ tree, runs, openDialog, select, api }: ContentProps) {
  const systemServers = (systemId: string): number => {
    const serviceIds = new Set(tree.services.filter(service => service.systemId === systemId).map(service => service.id))
    return tree.servers.filter(server => serviceIds.has(server.serviceId)).length
  }
  return (
    <div className={css.stack}>
      <div className={css.head}>
        <div>
          <h1 className={css.h1}>{tt('panel.title')}</h1>
          <p className={css.sub}>{tt('system.stats', {
            services: tree.services.length,
            servers: tree.servers.length,
            tasks: tree.tasks.length,
          })}</p>
        </div>
        <div className={css.actions}>
          <button type="button" className={css.btnPrimary} onClick={() => { openDialog({ kind: 'system' }) }}>+ {tt('tree.newSystem')}</button>
        </div>
      </div>

      {tree.systems.length === 0 && (
        <div className={css.emptyHero}>
          <b>{tt('tree.empty')}</b>
          <span>{tt('tree.emptyHint')}</span>
          <button type="button" className={css.btnPrimary} onClick={() => { openDialog({ kind: 'system' }) }}>+ {tt('tree.newSystem')}</button>
        </div>
      )}

      {tree.systems.length > 0 && (
        <div className={css.cardGrid}>
          {tree.systems.map(system => {
            const services = tree.services.filter(service => service.systemId === system.id)
            const tasks = tree.tasks.filter(task => services.some(service => service.id === task.owner.id))
            return (
              <EntityCard
                key={system.id}
                accent={system.color ?? DEFAULT_ACCENTS.system}
                tag="SYS"
                glyph="◈"
                title={system.name}
                description={system.description}
                stats={[
                  { value: services.length, label: tt('system.services') },
                  { value: systemServers(system.id), label: tt('service.servers') },
                  { value: tasks.length, label: tt('service.tasks') },
                ]}
                chips={services.slice(0, 4).map(service => service.name)}
                moreChips={services.length > 4 ? `+${services.length - 4}` : undefined}
                onOpen={() => { select('system', system.id) }}
                onEdit={() => { openDialog({ kind: 'edit-system', systemId: system.id }) }}
                actions={[
                  { label: `+ ${tt('system.newServiceCard')}`, onClick: () => { openDialog({ kind: 'service', systemId: system.id }) } },
                ]}
              />
            )
          })}
          <button type="button" className={css.cardAdd} onClick={() => { openDialog({ kind: 'system' }) }}>
            <b>+ {tt('tree.newSystem')}</b>
          </button>
        </div>
      )}

      <div className={css.card}>
        <div className={css.cardHead}><h3 className={css.cardTitle}>{tt('task.history')}</h3></div>
        <RunTable runs={runs} onSelect={(runId) => { select('run', runId) }} />
      </div>
      <WebhookSettings api={api} />
    </div>
  )
}

/** Shared card body: title, description, stats, chips and an action row. */
function EntityCard(props: {
  accent: string
  tag: string
  glyph: string
  title: string
  description?: string
  stats: Array<{ value: number; label: string }>
  chips: string[]
  moreChips?: string
  onOpen: () => void
  onEdit: () => void
  actions: Array<{ label: string; onClick: () => void }>
}) {
  return (
    <div
      className={css.entityCard}
      style={{ '--accent': props.accent } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter') props.onOpen() }}
    >
      <div className={css.cardTop}>
        <span className={css.cardGlyph}>{props.glyph}</span>
        <b className={css.cardName}>{props.title}</b>
        <span className={css.cardTag}>{props.tag}</span>
        <span className={css.chevron}>›</span>
      </div>
      {props.description !== undefined && props.description !== '' && <p className={css.cardDesc}>{props.description}</p>}
      <div className={css.cardStats}>
        {props.stats.map(stat => (
          <span key={stat.label}><b>{stat.value}</b> {stat.label}</span>
        ))}
      </div>
      <div className={css.cardChips}>
        {props.chips.map(chip => <span key={chip} className={css.chip}>{chip}</span>)}
        {props.moreChips !== undefined && <span className={css.chip}>{props.moreChips}</span>}
        {props.chips.length === 0 && <span className={css.muted}>{tt('common.none')}</span>}
      </div>
      <div className={css.cardActions} onClick={(event) => { event.stopPropagation() }}>
        <button type="button" className={css.btnSmall} onClick={props.onEdit}>{tt('action.edit')}</button>
        {props.actions.map(action => (
          <button key={action.label} type="button" className={css.btnSmall} onClick={action.onClick}>{action.label}</button>
        ))}
      </div>
    </div>
  )
}

/** One system: services as cards. */
function SystemView(props: ContentProps & { system: OpsSystem }) {
  const { tree, system, openDialog, select, reload, api, controller } = props
  const services = tree.services.filter(service => service.systemId === system.id)
  const serverCount = tree.servers.filter(server => services.some(service => service.id === server.serviceId)).length
  const taskCount = tree.tasks.filter(task => services.some(service => service.id === task.owner.id)).length
  const systemAccent = system.color ?? DEFAULT_ACCENTS.system
  async function remove(): Promise<void> {
    if (!window.confirm(tt('system.deleteConfirm', { name: system.name }))) return
    await api.deleteSystem(system.id)
    await reload()
    controller.select({ kind: 'root' })
  }
  return (
    <div className={css.stack}>
      <div className={css.head}>
        <div>
          <h1 className={css.h1}>{system.name}</h1>
          <p className={css.sub}>
            {system.description === undefined || system.description === '' ? '' : `${system.description} · `}
            {tt('system.stats', { services: services.length, servers: serverCount, tasks: taskCount })}
          </p>
        </div>
        <div className={css.actions}>
          <button type="button" className={css.btn} onClick={() => { openDialog({ kind: 'edit-system', systemId: system.id }) }}>{tt('action.edit')}</button>
          <button type="button" className={css.btnDanger} onClick={() => { void remove() }}>{tt('action.delete')}</button>
          <button type="button" className={css.btnPrimary} onClick={() => { openDialog({ kind: 'service', systemId: system.id }) }}>+ {tt('tree.addService')}</button>
        </div>
      </div>

      <div className={css.cardGrid}>
        {services.map(service => {
          const servers = tree.servers.filter(server => server.serviceId === service.id)
          const tasks = tree.tasks.filter(task => task.owner.kind === 'service' && task.owner.id === service.id)
          return (
            <EntityCard
              key={service.id}
              accent={service.color ?? systemAccent}
              tag="SVC"
              glyph="◇"
              title={service.name}
              description={service.description}
              stats={[
                { value: servers.length, label: tt('service.servers') },
                { value: tasks.length, label: tt('service.tasks') },
              ]}
              chips={servers.slice(0, 5).map(server => server.sshAlias)}
              moreChips={servers.length > 5 ? `+${servers.length - 5}` : undefined}
              onOpen={() => { select('service', service.id) }}
              onEdit={() => { openDialog({ kind: 'edit-service', serviceId: service.id }) }}
              actions={[
                { label: `+ ${tt('service.addServerCard')}`, onClick: () => { openDialog({ kind: 'add-server', serviceId: service.id }) } },
                { label: `+ ${tt('service.addTaskCard')}`, onClick: () => { openDialog({ kind: 'task', serviceId: service.id }) } },
              ]}
            />
          )
        })}
        <button type="button" className={css.cardAdd} onClick={() => { openDialog({ kind: 'service', systemId: system.id }) }}>
          <b>+ {tt('system.newServiceCard')}</b>
        </button>
      </div>
    </div>
  )
}

/** One service: server cards and task cards. */
function ServiceView(props: ContentProps & { service: OpsService }) {
  const { tree, service, openDialog, select, reload, api, controller } = props
  const servers = tree.servers.filter(server => server.serviceId === service.id)
  const tasks = tree.tasks.filter(task => task.owner.kind === 'service' && task.owner.id === service.id)
  const system = tree.systems.find(entry => entry.id === service.systemId)
  const serviceAccent = service.color ?? system?.color ?? DEFAULT_ACCENTS.service
  async function remove(): Promise<void> {
    if (!window.confirm(tt('service.deleteConfirm', { name: service.name }))) return
    await api.deleteService(service.id)
    await reload()
    controller.select({ kind: 'system', id: service.systemId })
  }
  return (
    <div className={css.stack}>
      <div className={css.head}>
        <div>
          <h1 className={css.h1}>{service.name}</h1>
          <p className={css.sub}>
            {service.description === undefined || service.description === '' ? '' : `${service.description} · `}
            {tt('system.stats', { services: 1, servers: servers.length, tasks: tasks.length })}
          </p>
        </div>
        <div className={css.actions}>
          <button type="button" className={css.btn} onClick={() => { openDialog({ kind: 'edit-service', serviceId: service.id }) }}>{tt('action.edit')}</button>
          <button type="button" className={css.btnDanger} onClick={() => { void remove() }}>{tt('action.delete')}</button>
          <button type="button" className={css.btn} onClick={() => { openDialog({ kind: 'task', serviceId: service.id }) }}>+ {tt('tree.addTask')}</button>
          <button type="button" className={css.btnPrimary} onClick={() => { openDialog({ kind: 'add-server', serviceId: service.id }) }}>+ {tt('tree.addServer')}</button>
        </div>
      </div>

      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{tt('service.servers')}</h3>
        <span className={css.sectionCount}>{servers.length}</span>
      </div>
      <div className={css.cardGrid}>
        {servers.map(server => (
          <ServerCard
            key={server.id}
            server={server}
            tree={tree}
            api={api}
            accent={server.color ?? serviceAccent}
            onOpen={() => { select('server', server.id) }}
            onEdit={() => { openDialog({ kind: 'edit-server', serverId: server.id }) }}
            onAddTask={() => { openDialog({ kind: 'task', serviceId: service.id }) }}
          />
        ))}
        <button type="button" className={css.cardAdd} onClick={() => { openDialog({ kind: 'add-server', serviceId: service.id }) }}>
          <b>+ {tt('service.addServerCard')}</b>
        </button>
      </div>

      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{tt('service.tasks')}</h3>
        <span className={css.sectionCount}>{tasks.length}</span>
      </div>
      <div className={css.cardGrid}>
        {tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            tree={tree}
            accent={serviceAccent}
            onOpen={() => { select('task', task.id) }}
            onRun={() => { openDialog({ kind: 'run', taskId: task.id }) }}
          />
        ))}
        <button type="button" className={css.cardAdd} onClick={() => { openDialog({ kind: 'task', serviceId: service.id }) }}>
          <b>+ {tt('service.addTaskCard')}</b>
        </button>
      </div>
    </div>
  )
}

/** One server card: runtime chips, task count, test/edit. */
function ServerCard({ server, tree, api, accent, onOpen, onEdit, onAddTask }: {
  server: OpsServer
  tree: TreeSnapshot
  api: OpsApi
  accent: string
  onOpen: () => void
  onEdit: () => void
  onAddTask: () => void
}) {
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const tasks = tree.tasks.filter(task => task.kind === 'script'
    && task.owner.kind === 'service' && task.owner.id === server.serviceId
    && (task.scope === 'all' || task.serverId === server.id))
  return (
    <div
      className={css.entityCard}
      style={{ '--accent': accent } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen() }}
    >
      <div className={css.cardTop}>
        <span className={css.cardGlyph}>▣</span>
        <b className={`${css.cardName} ${css.mono}`}>{server.sshAlias}</b>
        <span className={css.cardTag}>SRV</span>
        <span className={css.chevron}>›</span>
      </div>
      <div className={css.cardChips}>
        <span className={css.chip}>{server.runtime.kind}</span>
        {server.runtime.unit !== undefined && <span className={css.chip}>{server.runtime.unit}</span>}
        {server.runtime.port !== undefined && <span className={css.chip}>:{server.runtime.port}</span>}
        {server.environment !== undefined && <span className={css.chip}>{server.environment}</span>}
      </div>
      <p className={css.cardDesc}>{server.runtime.workdir ?? '—'} · {tasks.length} {tt('service.tasks')}</p>
      {notice !== undefined && <p className={css.hint}>{notice}</p>}
      {error !== undefined && <p className={css.hintError}>{error}</p>}
      <div className={css.cardActions} onClick={(event) => { event.stopPropagation() }}>
        <button type="button" className={css.btnSmall} onClick={() => {
          setNotice(undefined)
          setError(undefined)
          void api.testHost(server.sshAlias)
            .then((result) => {
              if (result.ok) setNotice(`${tt('server.tested')} · ${result.latencyMs ?? 0}ms`)
              else setError(tt('server.testFailed', { error: result.error ?? '' }))
            })
            .catch((failure: unknown) => { setError(errorText(failure)) })
        }}>{tt('server.test')}</button>
        <button type="button" className={css.btnSmall} onClick={onEdit}>{tt('action.edit')}</button>
        <button type="button" className={css.btnSmall} onClick={onAddTask}>+ {tt('service.tasks')}</button>
      </div>
    </div>
  )
}

/** One task card: kind, risk, target count, schedule and run/edit. */
function TaskCard({ task, tree, accent, onOpen, onRun }: {
  task: OpsTask
  tree: TreeSnapshot
  accent: string
  onOpen: () => void
  onRun: () => void
}) {
  const schedule = task.schedule?.enabled === true ? `${tt('task.scheduledBadge')} ${task.schedule.cron}` : undefined
  return (
    <div
      className={css.entityCard}
      style={{ '--accent': accent } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen() }}
    >
      <div className={css.cardTop}>
        <span className={css.cardGlyph}>{task.kind === 'flow' ? '⇉' : '⌁'}</span>
        <b className={css.cardName}>{task.name}</b>
        {task.kind === 'flow' && <span className={css.badge}>{tt('task.flow')}</span>}
        <span className={css.cardTag}>{task.kind === 'flow' ? 'FLOW' : 'TASK'}</span>
        <span className={css.chevron}>›</span>
      </div>
      <div className={css.cardChips}>
        <span className={css.riskBadge} data-risk={task.risk}>{task.risk}</span>
        <span className={css.chip}>
          {task.kind === 'flow'
            ? tt('tree.stepCount', { count: (task.steps ?? []).length })
            : task.scope === 'all'
              ? tt('tree.allServers', { count: taskTargetCount(task, tree) })
              : tt('task.singleServer')}
        </span>
        {schedule !== undefined && <span className={css.chip}>{schedule}</span>}
      </div>
      {task.description !== undefined && task.description !== '' && <p className={css.cardDesc}>{task.description}</p>}
      <div className={css.cardActions} onClick={(event) => { event.stopPropagation() }}>
        <button type="button" className={css.btnSmall} onClick={onRun}>{tt('action.run')}</button>
        <button type="button" className={css.btnSmall} onClick={onOpen}>{tt('action.edit')}</button>
      </div>
    </div>
  )
}

/** One server: runtime facts and the tasks inherited from its service. */
function ServerView(props: ContentProps & { server: OpsServer }) {
  const { tree, server, openDialog, select, reload, api, controller } = props
  const [notice, setNotice] = useState<string>()
  const [testError, setTestError] = useState<string>()
  const service = tree.services.find(entry => entry.id === server.serviceId)
  const system = service === undefined ? undefined : tree.systems.find(entry => entry.id === service.systemId)
  const serverAccent = server.color ?? service?.color ?? system?.color ?? DEFAULT_ACCENTS.server
  const tasks = tree.tasks.filter(task => task.kind === 'script'
    && task.owner.kind === 'service' && task.owner.id === server.serviceId
    && (task.scope === 'all' || task.serverId === server.id))
  async function remove(): Promise<void> {
    if (!window.confirm(tt('server.deleteConfirm', { name: server.sshAlias }))) return
    await api.deleteServer(server.id)
    await reload()
    if (service !== undefined) controller.select({ kind: 'service', id: service.id })
  }
  return (
    <div className={css.stack}>
      <div className={css.head}>
        <div>
          <h1 className={`${css.h1} ${css.mono}`}>{server.sshAlias}</h1>
          <p className={css.sub}>
            {service?.name ?? ''} · {server.runtime.kind}
            {server.environment === undefined ? '' : ` · ${server.environment}`}
          </p>
        </div>
        <div className={css.actions}>
          <button type="button" className={css.btn} onClick={() => { openDialog({ kind: 'edit-server', serverId: server.id }) }}>{tt('action.edit')}</button>
          <button type="button" className={css.btnDanger} onClick={() => { void remove() }}>{tt('action.delete')}</button>
          <button type="button" className={css.btn} onClick={() => {
            setNotice(undefined)
            setTestError(undefined)
            void api.testHost(server.sshAlias)
              .then((result) => { if (result.ok) setNotice(`${tt('server.tested')} · ${result.latencyMs ?? 0}ms`); else setTestError(tt('server.testFailed', { error: result.error ?? '' })) })
              .catch((failure: unknown) => { setTestError(errorText(failure)) })
          }}>{tt('server.test')}</button>
          <button type="button" className={css.btnPrimary} onClick={() => { openDialog({ kind: 'task', serviceId: server.serviceId }) }}>+ {tt('tree.addTask')}</button>
        </div>
      </div>

      {notice !== undefined && <p className={css.hint}>{notice}</p>}
      {testError !== undefined && <div className={css.error}>{testError}</div>}

      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>{tt('server.runtime')}</h3>
          <button type="button" className={css.btnSmall} onClick={() => { openDialog({ kind: 'edit-server', serverId: server.id }) }}>{tt('action.edit')}</button>
        </div>
        <div className={css.gridInfo}>
          <Info label={tt('server.alias')} value={server.sshAlias} mono />
          <Info label={tt('server.name')} value={server.name} />
          <Info label={tt('server.runtime')} value={server.runtime.kind} />
          <Info label={tt('server.unit')} value={server.runtime.unit ?? '—'} mono />
          <Info label={tt('server.workdir')} value={server.runtime.workdir ?? '—'} mono />
          <Info label={tt('server.port')} value={server.runtime.port === undefined ? '—' : String(server.runtime.port)} />
        </div>
      </div>

      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{tt('server.tasks')}</h3>
        <span className={css.sectionCount}>{tasks.length}</span>
      </div>
      <div className={css.cardGrid}>
        {tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            tree={tree}
            accent={serverAccent}
            onOpen={() => { select('task', task.id) }}
            onRun={() => { openDialog({ kind: 'run', taskId: task.id, serverId: server.id }) }}
          />
        ))}
        <button type="button" className={css.cardAdd} onClick={() => { openDialog({ kind: 'task', serviceId: server.serviceId }) }}>
          <b>+ {tt('service.addTaskCard')}</b>
        </button>
      </div>

      <p className={css.hint}>{tt('server.aiHint', { alias: server.sshAlias })}</p>
    </div>
  )
}

/** One task: script editor + parameters + run history. */
function TaskView(props: ContentProps & { task: OpsTask }) {
  const { task, tree, api, reload, openDialog, select } = props
  const [name, setName] = useState(task.name)
  const [script, setScript] = useState(task.script)
  const [params, setParams] = useState<TaskParam[]>(task.params)
  const [timeoutMs, setTimeoutMs] = useState(String(task.timeoutMs))
  const [risk, setRisk] = useState<TaskRisk>(task.risk)
  const [scope, setScope] = useState<'all' | 'single'>(task.scope)
  const [serverId, setServerId] = useState(task.serverId ?? '')
  const [failure, setFailure] = useState<FlowFailure>(task.failure ?? 'stop')
  const [steps, setSteps] = useState<FlowStep[]>(task.steps ?? [])
  const [scheduleEnabled, setScheduleEnabled] = useState(task.schedule?.enabled === true)
  const [cron, setCron] = useState(task.schedule?.cron ?? '0 2 * * *')
  const [timeZone, setTimeZone] = useState(task.schedule?.timeZone ?? '')
  const [overrides, setOverrides] = useState<Record<string, Record<string, string>>>(() => {
    const initial: Record<string, Record<string, string>> = {}
    for (const [serverId, override] of Object.entries(task.serverOverrides ?? {})) {
      if (override.params !== undefined && Object.keys(override.params).length > 0) {
        initial[serverId] = { ...override.params }
      }
    }
    return initial
  })
  const [saved, setSaved] = useState(true)
  const [error, setError] = useState<string>()
  const servers = tree.servers.filter(server => task.owner.kind === 'service' && server.serviceId === task.owner.id)
  const scriptTasks = tree.tasks.filter(entry => entry.kind === 'script')
  const history = props.runs.filter(row => row.taskId === task.id).slice(0, 8)

  const mark = (): void => { setSaved(false) }

  async function save(): Promise<void> {
    setError(undefined)
    try {
      const schedule = (scheduleEnabled || task.schedule !== undefined) && cron.trim() !== ''
        ? {
            enabled: scheduleEnabled,
            cron: cron.trim(),
            ...(timeZone.trim() === '' ? {} : { timeZone: timeZone.trim() }),
          }
        : undefined
      const serverOverrides = buildOverrides(overrides)
      const patch: Partial<TaskInput> = task.kind === 'flow'
        ? { kind: 'flow', name, failure, steps, timeoutMs: Number(timeoutMs), risk, ...(schedule === undefined ? {} : { schedule }) }
        : {
            name, script, params, timeoutMs: Number(timeoutMs), risk, scope,
            ...(scope === 'single' ? { serverId } : {}),
            ...(schedule === undefined ? {} : { schedule }),
            ...(serverOverrides === undefined ? {} : { serverOverrides }),
          }
      await api.updateTask(task.id, patch)
      setSaved(true)
      await reload()
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(tt('task.deleteConfirm', { name: task.name }))) return
    await api.deleteTask(task.id)
    await reload()
    select('service', task.owner.id)
  }

  function updateParam(index: number, patch: Partial<TaskParam>): void {
    setParams(current => current.map((param, at) => at === index ? { ...param, ...patch } : param))
    mark()
  }

  function addStep(): void {
    const first = scriptTasks[0]
    if (first === undefined) return
    setSteps(current => [...current, {
      id: `step-${Date.now().toString(36)}-${current.length}`,
      taskId: first.id,
      mode: 'serial',
    }])
    mark()
  }

  function updateStep(index: number, patch: Partial<FlowStep>): void {
    setSteps(current => current.map((step, at) => at === index ? { ...step, ...patch } : step))
    mark()
  }

  function moveStep(index: number, delta: number): void {
    setSteps(current => {
      const next = [...current]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      const moved = next[index]
      next[index] = next[target]
      next[target] = moved
      return next
    })
    mark()
  }

  function removeStep(index: number): void {
    setSteps(current => current.filter((_entry, at) => at !== index))
    mark()
  }

  function setOverride(serverId: string, name: string, value: string): void {
    setOverrides((current) => {
      const next = { ...current, [serverId]: { ...(current[serverId] ?? {}) } }
      if (value === '') delete next[serverId][name]
      else next[serverId][name] = value
      if (Object.keys(next[serverId]).length === 0) delete next[serverId]
      return next
    })
    mark()
  }

  async function duplicate(): Promise<void> {
    setError(undefined)
    try {
      const created = await api.createTask({
        owner: { ...task.owner },
        name: tt('task.copyName', { name: task.name }),
        description: task.description,
        kind: task.kind,
        script: task.script,
        params: task.params,
        env: task.env,
        cwd: task.cwd,
        timeoutMs: task.timeoutMs,
        risk: task.risk,
        scope: task.scope,
        serverId: task.serverId,
        serverOverrides: task.serverOverrides,
        steps: task.steps,
        failure: task.failure,
      })
      await reload()
      select('task', created.id)
    } catch (failureValue) {
      setError(errorText(failureValue))
    }
  }

  const scheduleValid = !scheduleEnabled || isValidCron(cron)
  const nextRun = scheduleEnabled && scheduleValid
    ? nextRunAtMs(cron, Date.now(), timeZone.trim() === '' ? undefined : timeZone.trim())
    : undefined
  const nextRunLabel = scheduleEnabled
    ? (scheduleValid ? (nextRun === undefined ? '—' : new Date(nextRun).toLocaleString()) : tt('task.invalidCron'))
    : '—'

  return (
    <div className={css.stack}>
      <div className={css.head}>
        <div>
          <h1 className={css.h1}>{task.name} {task.kind === 'flow' && <span className={css.badge}>{tt('task.flow')}</span>}</h1>
          <p className={css.sub}>{saved ? tt('task.saved') : tt('task.unsaved')}</p>
        </div>
        <div className={css.actions}>
          <button type="button" className={css.btnDanger} onClick={() => { void remove() }}>{tt('action.delete')}</button>
          <button type="button" className={css.btn} onClick={() => { void duplicate() }}>{tt('task.duplicate')}</button>
          <button type="button" className={css.btn} onClick={() => { openDialog({ kind: 'run', taskId: task.id }) }}>{tt('action.run')}</button>
          <button type="button" className={css.btnPrimary} onClick={() => { void save() }}>{tt('action.save')}</button>
        </div>
      </div>

      {error !== undefined && <div className={css.error}>{error}</div>}

      <div className={css.card}>
        <div className={css.fieldRow}>
          <label className={css.field}>
            <span>{tt('task.name')}</span>
            <input className={css.input} value={name} onChange={(event) => { setName(event.target.value); mark() }} />
          </label>
          <label className={css.field}>
            <span>{tt('task.risk')}</span>
            <select className={css.input} value={risk} onChange={(event) => { setRisk(event.target.value as TaskRisk); mark() }}>
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="destructive">destructive</option>
            </select>
          </label>
          <label className={css.field}>
            <span>{tt('task.timeout')}</span>
            <input className={css.input} value={timeoutMs} onChange={(event) => { setTimeoutMs(event.target.value); mark() }} />
          </label>
          {task.kind === 'flow' ? (
            <label className={css.field}>
              <span>{tt('task.failure')}</span>
              <select className={css.input} value={failure} onChange={(event) => { setFailure(event.target.value as FlowFailure); mark() }}>
                <option value="stop">{tt('task.failureStop')}</option>
                <option value="continue">{tt('task.failureContinue')}</option>
              </select>
            </label>
          ) : (
            <label className={css.field}>
              <span>{tt('task.scope')}</span>
              <select className={css.input} value={scope} onChange={(event) => { setScope(event.target.value as 'all' | 'single'); mark() }}>
                <option value="all">{tt('task.scopeAll')}</option>
                <option value="single">{tt('task.scopeSingle')}</option>
              </select>
            </label>
          )}
          {task.kind === 'script' && scope === 'single' && (
            <label className={css.field}>
              <span>{tt('tree.servers')}</span>
              <select className={css.input} value={serverId} onChange={(event) => { setServerId(event.target.value); mark() }}>
                <option value="">—</option>
                {servers.map(server => <option key={server.id} value={server.id}>{server.sshAlias}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      {task.kind === 'script' && (<>
      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>{tt('task.script')}</h3>
          <span className={css.muted}>{servers.length} · {task.scope === 'all' ? tt('task.scopeAll') : tt('task.scopeSingle')}</span>
        </div>
        <textarea
          className={css.code}
          value={script}
          spellCheck={false}
          onChange={(event) => { setScript(event.target.value); mark() }}
        />
      </div>

      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>{tt('task.params')}</h3>
          <button type="button" className={css.btnSmall} onClick={() => {
            setParams(current => [...current, { name: 'PARAM', type: 'text', required: false }])
            mark()
          }}>+ {tt('task.addParam')}</button>
        </div>
        {params.length === 0 && <div className={css.empty}>{tt('common.none')}</div>}
        {params.map((param, index) => (
          <div className={css.paramRow} key={`${param.name}-${index}`}>
            <input className={css.input} value={param.name} placeholder={tt('task.paramName')} onChange={(event) => { updateParam(index, { name: event.target.value }) }} />
            <select className={css.input} value={param.type} onChange={(event) => { updateParam(index, { type: event.target.value as TaskParamType }) }}>
              <option value="text">text</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="select">select</option>
              <option value="file">file</option>
            </select>
            <input className={css.input} value={param.default ?? ''} placeholder={tt('task.paramDefault')} onChange={(event) => { updateParam(index, { default: event.target.value }) }} />
            <label className={css.check}>
              <input type="checkbox" checked={param.required === true} onChange={(event) => { updateParam(index, { required: event.target.checked }) }} />
              {tt('task.paramRequired')}
            </label>
            <button type="button" className={css.btnSmall} onClick={() => {
              setParams(current => current.filter((_entry, at) => at !== index))
              mark()
            }}>×</button>
          </div>
        ))}
      </div>
      </>)}

      {task.kind === 'flow' && (
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{tt('task.steps')}</h3>
            <button type="button" className={css.btnSmall} onClick={addStep} disabled={scriptTasks.length === 0}>+ {tt('task.addStep')}</button>
          </div>
          {scriptTasks.length === 0 && <div className={css.empty}>{tt('task.noScriptTasks')}</div>}
          {steps.length === 0 && <div className={css.empty}>{tt('task.noSteps')}</div>}
          {steps.map((step, index) => (
            <div className={css.stepRow} key={step.id}>
              <span className={css.stepIndex}>{index + 1}</span>
              <select
                className={css.input}
                value={step.taskId}
                onChange={(event) => { updateStep(index, { taskId: event.target.value }) }}
              >
                {scriptTasks.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </select>
              <select
                className={css.input}
                style={{ maxWidth: 120 }}
                value={step.mode}
                onChange={(event) => { updateStep(index, { mode: event.target.value as FlowStep['mode'] }) }}
              >
                <option value="serial">{tt('task.stepSerial')}</option>
                <option value="parallel">{tt('task.stepParallel')}</option>
              </select>
              <button type="button" className={css.btnSmall} onClick={() => { moveStep(index, -1) }} disabled={index === 0}>↑</button>
              <button type="button" className={css.btnSmall} onClick={() => { moveStep(index, 1) }} disabled={index === steps.length - 1}>↓</button>
              <button type="button" className={css.btnSmall} onClick={() => { removeStep(index) }}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className={css.card}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle}>{tt('task.schedule')}</h3>
          <span className={css.muted}>{tt('task.nextRun')}: {nextRunLabel}</span>
        </div>
        <div className={css.fieldRow}>
          <label className={css.check}>
            <input type="checkbox" checked={scheduleEnabled} onChange={(event) => { setScheduleEnabled(event.target.checked); mark() }} />
            {tt('task.scheduleEnabled')}
          </label>
          <label className={css.field}>
            <span>{tt('task.cron')}</span>
            <input className={css.input} value={cron} disabled={!scheduleEnabled} onChange={(event) => { setCron(event.target.value); mark() }} />
          </label>
          <label className={css.field}>
            <span>{tt('task.timeZone')}</span>
            <input className={css.input} value={timeZone} disabled={!scheduleEnabled} onChange={(event) => { setTimeZone(event.target.value); mark() }} />
          </label>
        </div>
        <p className={css.hint} style={{ marginTop: 8 }}>
          {tt('task.lastRun')}: {task.schedule?.lastRunAt === undefined ? '—' : new Date(task.schedule.lastRunAt).toLocaleString()}
        </p>
      </div>

      {task.kind === 'script' && scope === 'all' && params.length > 0 && servers.length > 0 && (
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{tt('task.overrides')}</h3>
            <span className={css.muted}>{tt('task.overridesHint')}</span>
          </div>
          {servers.map(server => (
            <div className={css.overrideRow} key={server.id}>
              <span className={css.overrideServer}>{server.sshAlias}</span>
              {params.map(param => (
                <input
                  key={param.name}
                  className={css.input}
                  placeholder={param.name}
                  value={overrides[server.id]?.[param.name] ?? ''}
                  onChange={(event) => { setOverride(server.id, param.name, event.target.value) }}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      <div className={css.card}>
        <div className={css.cardHead}><h3 className={css.cardTitle}>{tt('task.history')}</h3></div>
        <RunTable runs={history} onSelect={(runId) => { select('run', runId) }} />
      </div>
    </div>
  )
}

/** One run: status, targets, log tail. */
function RunView({ api, runId, select, onRefresh }: {
  api: OpsApi
  runId: string
  select: (kind: OpsNodeKind, id?: string) => void
  onRefresh: () => void
}) {
  const [run, setRun] = useState<OpsRun>()
  const [target, setTarget] = useState<string>()
  const [log, setLog] = useState('')
  const [error, setError] = useState<string>()
  const logRef = useRef<HTMLPreElement>(null)
  const settled = useRef(false)

  useEffect(() => {
    // Switching from a flow run to one of its child runs reuses this component:
    // reset the settled latch and the previous run's view state first.
    settled.current = false
    setRun(undefined)
    setTarget(undefined)
    setLog('')
    let alive = true
    const tick = async (): Promise<void> => {
      if (settled.current) return
      try {
        const detail = await api.runDetail(runId)
        if (!alive) return
        setRun(detail)
        setTarget(current => current ?? (detail.children !== undefined ? 'flow' : detail.targets[0]?.serverId))
        setError(undefined)
        if (detail.status !== 'running' && detail.status !== 'queued') {
          settled.current = true
          onRefresh()
        }
      } catch (failure) {
        if (alive) setError(errorText(failure))
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1200)
    return () => { alive = false; window.clearInterval(timer) }
  }, [api, runId, onRefresh])

  useEffect(() => {
    if (target === undefined) return
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const text = await api.runLog(runId, target)
        if (alive) setLog(text)
      } catch { /* log not ready yet */ }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1200)
    return () => { alive = false; window.clearInterval(timer) }
  }, [api, runId, target])

  useEffect(() => {
    if (logRef.current !== null) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const running = run?.status === 'running' || run?.status === 'queued'
  const activeTarget = run?.targets.find(entry => entry.serverId === target)

  return (
    <div className={css.stack}>
      <div className={css.head}>
        <div>
          <h1 className={css.h1}>{run?.taskName ?? runId}</h1>
          <p className={css.sub}>{runId} · {run?.status ?? tt('common.loading')}</p>
        </div>
        <div className={css.actions}>
          {run !== undefined && <button type="button" className={css.btn} onClick={() => { select('task', run.taskId) }}>{tt('run.back')}</button>}
          {running && <button type="button" className={css.btnDanger} onClick={() => { void api.cancelRun(runId) }}>{tt('run.cancel')}</button>}
        </div>
      </div>

      {error !== undefined && <div className={css.error}>{error}</div>}

      {run?.children !== undefined && run.children.length > 0 && (
        <div className={css.card}>
          <div className={css.cardHead}><h3 className={css.cardTitle}>{tt('task.steps')}</h3></div>
          <table className={css.table}>
            <thead><tr><th>#</th><th>{tt('task.name')}</th><th>{tt('run.status')}</th><th>{tt('run.title')}</th></tr></thead>
            <tbody>
              {run.children.map((child, index) => (
                <tr
                  key={child.stepId}
                  className={child.runId === undefined ? undefined : css.clickRow}
                  onClick={() => { if (child.runId !== undefined) select('run', child.runId) }}
                >
                  <td>{index + 1}</td>
                  <td>{child.taskName}</td>
                  <td><span className={css.status} data-status={child.status}>{child.status}</span></td>
                  <td className={css.mono}>{child.runId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {run?.children === undefined && (
      <div className={css.card}>
        <div className={css.cardHead}><h3 className={css.cardTitle}>{tt('run.target')}</h3></div>
        <table className={css.table}>
          <thead><tr><th>{tt('server.alias')}</th><th>{tt('run.status')}</th><th>{tt('run.exit')}</th><th>{tt('run.duration')}</th></tr></thead>
          <tbody>
            {run?.targets.map(entry => (
              <tr
                key={entry.serverId}
                className={entry.serverId === target ? css.clickRow : undefined}
                onClick={() => { setTarget(entry.serverId) }}
                title={entry.error}
              >
                <td className={css.mono}>{entry.alias}</td>
                <td><span className={css.status} data-status={entry.status}>{entry.status}</span></td>
                <td>{entry.exitCode ?? '—'}</td>
                <td>{entry.durationMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
        {activeTarget?.error !== undefined && <div className={css.error}>{activeTarget.error}</div>}
      </div>
      )}
      {run?.error !== undefined && <div className={css.error}>{run.error}</div>}

      <div className={css.card}>
        <div className={css.cardHead}><h3 className={css.cardTitle}>{tt('run.log')}</h3></div>
        <pre className={css.runLog} ref={logRef}>{log === '' ? tt('run.noLog') : log}</pre>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- shared

/** Build the stored per-server override map from the matrix state. */
function buildOverrides(source: Record<string, Record<string, string>>): Record<string, { params?: Record<string, string> }> | undefined {
  const result: Record<string, { params?: Record<string, string> }> = {}
  for (const [serverId, values] of Object.entries(source)) {
    const params = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''))
    if (Object.keys(params).length > 0) result[serverId] = { params }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={css.info}>
      <span className={css.infoLabel}>{label}</span>
      <span className={`${css.infoValue} ${mono === true ? css.mono : ''}`}>{value}</span>
    </div>
  )
}

function RunTable({ runs, onSelect }: { runs: RunSummary[]; onSelect: (runId: string) => void }) {
  if (runs.length === 0) return <div className={css.empty}>{tt('common.none')}</div>
  return (
    <table className={css.table}>
      <thead><tr><th>{tt('run.title')}</th><th>{tt('run.status')}</th><th>{tt('run.target')}</th><th>{tt('task.name')}</th></tr></thead>
      <tbody>
        {runs.map(run => (
          <tr key={run.id} className={css.clickRow} onClick={() => { onSelect(run.id) }}>
            <td className={css.mono}>{run.id}</td>
            <td><span className={css.status} data-status={run.status}>{run.status}</span></td>
            <td>{run.okCount}/{run.targetCount}</td>
            <td>{run.taskName}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className={css.mask} onClick={onClose}>
      <div className={css.modal} onClick={(event) => { event.stopPropagation() }}>
        <div className={css.modalHead}>
          <h3 className={css.modalTitle}>{title}</h3>
          <button type="button" className={css.btnSmall} onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function TextDialog({ title, label, submitLabel, onSubmit, onClose }: {
  title: string
  label: string
  submitLabel: string
  onSubmit: (value: string) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string>()
  return (
    <Modal title={title} onClose={onClose}>
      <div className={css.modalBody}>
        <label className={css.field}>
          <span>{label}</span>
          <input className={css.input} autoFocus value={value} onChange={(event) => { setValue(event.target.value) }} />
        </label>
        {error !== undefined && <div className={css.error}>{error}</div>}
      </div>
      <div className={css.modalFoot}>
        <button type="button" className={css.btn} onClick={onClose}>{tt('action.cancel')}</button>
        <button type="button" className={css.btnPrimary} onClick={() => {
          setError(undefined)
          void onSubmit(value.trim()).catch((failure: unknown) => { setError(errorText(failure)) })
        }}>{submitLabel}</button>
      </div>
    </Modal>
  )
}

/** Workspace webhook notification settings. */
function WebhookSettings({ api }: { api: OpsApi }) {
  const [url, setUrl] = useState('')
  const [on, setOn] = useState<'always' | 'failure'>('failure')
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true
    void api.settings()
      .then((settings) => {
        if (!alive) return
        setUrl(settings.webhookUrl ?? '')
        setOn(settings.webhookOn)
      })
      .catch((failure: unknown) => { if (alive) setError(errorText(failure)) })
    return () => { alive = false }
  }, [api])

  return (
    <div className={css.card}>
      <div className={css.cardHead}><h3 className={css.cardTitle}>{tt('settings.title')}</h3></div>
      <div className={css.fieldRow}>
        <label className={css.field}>
          <span>{tt('settings.webhookUrl')}</span>
          <input className={css.input} value={url} placeholder="https://…" onChange={(event) => { setUrl(event.target.value); setNotice(undefined) }} />
        </label>
        <label className={css.field} style={{ maxWidth: 180 }}>
          <span>{tt('settings.webhookOn')}</span>
          <select className={css.input} value={on} onChange={(event) => { setOn(event.target.value as 'always' | 'failure'); setNotice(undefined) }}>
            <option value="failure">{tt('settings.onFailure')}</option>
            <option value="always">{tt('settings.onAlways')}</option>
          </select>
        </label>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button type="button" className={css.btnPrimary} onClick={() => {
            setError(undefined)
            void api.updateSettings({ webhookUrl: url.trim(), webhookOn: on })
              .then((settings) => { setUrl(settings.webhookUrl ?? ''); setNotice(tt('settings.saved')) })
              .catch((failure: unknown) => { setError(errorText(failure)) })
          }}>{tt('settings.save')}</button>
        </div>
      </div>
      {notice !== undefined && <p className={css.hint} style={{ marginTop: 6 }}>{notice}</p>}
      {error !== undefined && <div className={css.error}>{error}</div>}
    </div>
  )
}

/** Accent color picker: inherit, presets, or a native color input. */
function ColorField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className={css.field}>
      <span>{tt('common.color')}</span>
      <div className={css.swatches}>
        <button
          type="button"
          className={css.swatchAuto}
          data-active={value === ''}
          onClick={() => { onChange('') }}
        >
          {tt('common.inherit')}
        </button>
        {ACCENT_PRESETS.map(color => (
          <button
            key={color}
            type="button"
            className={css.swatch}
            data-active={value.toLowerCase() === color}
            style={{ background: color }}
            aria-label={color}
            onClick={() => { onChange(color) }}
          />
        ))}
        <input
          type="color"
          className={css.colorInput}
          value={value === '' ? '#22d3ee' : value}
          onChange={(event) => { onChange(event.target.value) }}
        />
      </div>
    </div>
  )
}

/** Dialog shell with a cancel/save footer. */
function FormDialog({ title, children, saving, onSave, onClose }: {
  title: string
  children: ReactNode
  saving?: boolean
  onSave: () => Promise<void>
  onClose: () => void
}) {
  const [error, setError] = useState<string>()
  return (
    <Modal title={title} onClose={onClose}>
      <div className={css.modalBody}>{children}</div>
      {error !== undefined && <div className={css.error}>{error}</div>}
      <div className={css.modalFoot}>
        <button type="button" className={css.btn} onClick={onClose}>{tt('action.cancel')}</button>
        <button type="button" className={css.btnPrimary} disabled={saving === true} onClick={() => {
          setError(undefined)
          void onSave().catch((failure: unknown) => { setError(errorText(failure)) })
        }}>{tt('action.save')}</button>
      </div>
    </Modal>
  )
}

/** Edit one system's name and description. */
function EditSystemDialog({ api, system, onClose, onDone }: {
  api: OpsApi
  system: OpsSystem
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [name, setName] = useState(system.name)
  const [description, setDescription] = useState(system.description ?? '')
  const [color, setColor] = useState(system.color ?? '')
  return (
    <FormDialog
      title={tt('system.editTitle')}
      onClose={onClose}
      onSave={async () => {
        await api.updateSystem(system.id, { name: name.trim(), description: description.trim(), color })
        await onDone()
      }}
    >
      <label className={css.field}><span>{tt('common.name')}</span><input className={css.input} autoFocus value={name} onChange={(event) => { setName(event.target.value) }} /></label>
      <label className={css.field}><span>{tt('common.description')}</span><input className={css.input} value={description} onChange={(event) => { setDescription(event.target.value) }} /></label>
      <ColorField value={color} onChange={setColor} />
    </FormDialog>
  )
}

/** Edit one service's name and description. */
function EditServiceDialog({ api, service, onClose, onDone }: {
  api: OpsApi
  service: OpsService
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [name, setName] = useState(service.name)
  const [description, setDescription] = useState(service.description ?? '')
  const [color, setColor] = useState(service.color ?? '')
  return (
    <FormDialog
      title={tt('service.editTitle')}
      onClose={onClose}
      onSave={async () => {
        await api.updateService(service.id, { name: name.trim(), description: description.trim(), color })
        await onDone()
      }}
    >
      <label className={css.field}><span>{tt('common.name')}</span><input className={css.input} autoFocus value={name} onChange={(event) => { setName(event.target.value) }} /></label>
      <label className={css.field}><span>{tt('common.description')}</span><input className={css.input} value={description} onChange={(event) => { setDescription(event.target.value) }} /></label>
      <ColorField value={color} onChange={setColor} />
    </FormDialog>
  )
}

/** Edit one server's display name and runtime spec. */
function EditServerDialog({ api, server, onClose, onDone }: {
  api: OpsApi
  server: OpsServer
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [name, setName] = useState(server.name)
  const [kind, setKind] = useState<RuntimeKind>(server.runtime.kind)
  const [unit, setUnit] = useState(server.runtime.unit ?? '')
  const [workdir, setWorkdir] = useState(server.runtime.workdir ?? '')
  const [port, setPort] = useState(server.runtime.port === undefined ? '' : String(server.runtime.port))
  const [composeFile, setComposeFile] = useState(server.runtime.composeFile ?? '')
  const [color, setColor] = useState(server.color ?? '')
  return (
    <FormDialog
      title={tt('server.editTitle')}
      onClose={onClose}
      onSave={async () => {
        await api.updateServer(server.id, {
          name: name.trim() === '' ? server.sshAlias : name.trim(),
          color,
          runtime: {
            kind,
            ...(unit.trim() === '' ? {} : { unit: unit.trim() }),
            ...(workdir.trim() === '' ? {} : { workdir: workdir.trim() }),
            ...(port.trim() === '' ? {} : { port: Number(port) }),
            ...(composeFile.trim() === '' ? {} : { composeFile: composeFile.trim() }),
          },
        })
        await onDone()
      }}
    >
      <div className={css.inlineInfo}><span>{tt('server.alias')}</span><b className={css.mono}>{server.sshAlias}</b></div>
      <label className={css.field}><span>{tt('server.name')}</span><input className={css.input} autoFocus value={name} onChange={(event) => { setName(event.target.value) }} /></label>
      <label className={css.field}><span>{tt('server.runtime')}</span>
        <select className={css.input} value={kind} onChange={(event) => { setKind(event.target.value as RuntimeKind) }}>
          {(['systemd', 'compose', 'docker', 'supervisor', 'custom'] as RuntimeKind[]).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label className={css.field}><span>{tt('server.unit')}</span><input className={css.input} value={unit} onChange={(event) => { setUnit(event.target.value) }} /></label>
      <label className={css.field}><span>{tt('server.workdir')}</span><input className={css.input} value={workdir} onChange={(event) => { setWorkdir(event.target.value) }} /></label>
      <label className={css.field}><span>{tt('server.port')}</span><input className={css.input} value={port} onChange={(event) => { setPort(event.target.value) }} /></label>
      {kind === 'compose' && (
        <label className={css.field}><span>compose</span><input className={css.input} value={composeFile} onChange={(event) => { setComposeFile(event.target.value) }} /></label>
      )}
      <ColorField value={color} onChange={setColor} />
    </FormDialog>
  )
}

// ------------------------------------------------------------ add server

function AddServerDialog({ api, serviceId, onClose, onDone }: {
  api: OpsApi
  serviceId: string
  onClose: () => void
  onDone: (server: OpsServer) => Promise<void>
}) {
  const [tab, setTab] = useState<'repo' | 'direct'>('repo')
  const [hosts, setHosts] = useState<RepoHost[]>([])
  const [queryText, setQueryText] = useState('')
  const [group, setGroup] = useState('')
  const [selected, setSelected] = useState<string>()
  const [name, setName] = useState('')
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind>('systemd')
  const [unit, setUnit] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [port, setPort] = useState('')
  const [direct, setDirect] = useState({ alias: '', host: '', port: '22', user: 'root', password: '', group: '', tags: '' })
  const [csv, setCsv] = useState('')
  const [showCsv, setShowCsv] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)

  const loadHosts = useCallback(async (): Promise<void> => {
    try {
      setHosts(await api.repo())
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [api])

  useEffect(() => { void loadHosts() }, [loadHosts])

  const groups = Array.from(new Set(hosts.map(host => host.group).filter((value): value is string => value !== undefined && value !== '')))
  const filtered = hosts.filter(host => {
    if (group !== '' && host.group !== group) return false
    const needle = queryText.trim().toLowerCase()
    if (needle === '') return true
    return host.alias.toLowerCase().includes(needle) || host.host.toLowerCase().includes(needle) || host.user.toLowerCase().includes(needle)
  })

  async function submit(): Promise<void> {
    setError(undefined)
    setBusy(true)
    try {
      const runtime = {
        kind: runtimeKind,
        ...(unit.trim() === '' ? {} : { unit: unit.trim() }),
        ...(workdir.trim() === '' ? {} : { workdir: workdir.trim() }),
        ...(port.trim() === '' ? {} : { port: Number(port) }),
      }
      let input: ServerInput
      if (tab === 'repo') {
        if (selected === undefined) throw new Error('pick a repository host first')
        input = { serviceId, sshAlias: selected, runtime, ...(name.trim() === '' ? {} : { name: name.trim() }) }
      } else {
        if (direct.alias.trim() === '' || direct.host.trim() === '' || direct.user.trim() === '') {
          throw new Error('alias, host and user are required')
        }
        input = {
          serviceId,
          newHost: {
            alias: direct.alias.trim(),
            host: direct.host.trim(),
            port: Number(direct.port) || 22,
            user: direct.user.trim(),
            auth: { kind: 'password', password: direct.password },
            group: direct.group.trim() || undefined,
            tags: direct.tags.split(/[;|]/).map(tag => tag.trim()).filter(tag => tag !== ''),
          },
          runtime,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
        }
      }
      const result = await api.createServer(input)
      await onDone(result.server)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={tt('server.dialog.title')} onClose={onClose}>
      <div className={css.modalBody}>
        <div className={css.tabs}>
          <button type="button" className={`${css.tab} ${tab === 'repo' ? css.tabActive : ''}`} onClick={() => { setTab('repo') }}>{tt('server.dialog.repo')}</button>
          <button type="button" className={`${css.tab} ${tab === 'direct' ? css.tabActive : ''}`} onClick={() => { setTab('direct') }}>{tt('server.dialog.direct')}</button>
        </div>

        {tab === 'repo' && (
          <>
            <div className={css.rowInline}>
              <select className={css.input} style={{ maxWidth: 120 }} value={group} onChange={(event) => { setGroup(event.target.value) }}>
                <option value="">{tt('server.dialog.group')}</option>
                {groups.map(value => <option key={value} value={value}>{value}</option>)}
              </select>
              <input className={css.input} placeholder={tt('server.dialog.search')} value={queryText} onChange={(event) => { setQueryText(event.target.value) }} />
              <button type="button" className={css.btnSmall} onClick={() => {
                setBusy(true)
                void api.importSshConfig()
                  .then(async (stats) => { setNotice(tt('import.done', { added: stats.added, skipped: stats.skipped })); await loadHosts() })
                  .catch((failure: unknown) => { setError(errorText(failure)) })
                  .finally(() => { setBusy(false) })
              }}>{tt('import.ssh')}</button>
              <button type="button" className={css.btnSmall} onClick={() => { setShowCsv(value => !value) }}>CSV</button>
            </div>
            {showCsv && (
              <div className={css.rowInline}>
                <textarea className={css.textareaSmall} placeholder={tt('import.csvHint')} value={csv} onChange={(event) => { setCsv(event.target.value) }} />
                <button type="button" className={css.btnSmall} onClick={() => {
                  setBusy(true)
                  void api.importCsv(csv)
                    .then(async (stats) => { setNotice(tt('import.done', { added: stats.added, skipped: stats.skipped })); await loadHosts() })
                    .catch((failure: unknown) => { setError(errorText(failure)) })
                    .finally(() => { setBusy(false) })
                }}>{tt('action.import')}</button>
              </div>
            )}
            {selected !== undefined && (
              <div className={css.rowInline}>
                <button type="button" className={css.btnSmall} onClick={() => {
                  void api.testHost(selected)
                    .then(result => { setNotice(result.ok ? `${tt('server.dialog.tested')} · ${result.latencyMs ?? 0}ms` : tt('server.dialog.testFailed', { error: result.error ?? '' })) })
                    .catch((failure: unknown) => { setError(errorText(failure)) })
                }}>{tt('server.dialog.test')}</button>
                <span className={css.muted}>{selected}</span>
              </div>
            )}
            {filtered.length === 0 && <div className={css.empty}>{tt('server.dialog.emptyRepo')}</div>}
            <div className={css.hostList}>
              {filtered.map(host => (
                <button
                  type="button"
                  key={host.alias}
                  className={`${css.hostItem} ${selected === host.alias ? css.hostItemSel : ''}`}
                  onClick={() => { setSelected(host.alias) }}
                >
                  <span className={css.mono}>{host.alias}</span>
                  <span className={css.muted}>{host.host} · {host.user}</span>
                  {host.group !== undefined && <span className={css.badge}>{host.group}</span>}
                </button>
              ))}
            </div>
          </>
        )}

        {tab === 'direct' && (
          <div className={css.fieldGrid}>
            <label className={css.field}><span>{tt('server.alias')}</span>
              <input className={css.input} value={direct.alias} onChange={(event) => { setDirect({ ...direct, alias: event.target.value }) }} />
            </label>
            <label className={css.field}><span>{tt('server.dialog.host')}</span>
              <input className={css.input} value={direct.host} onChange={(event) => { setDirect({ ...direct, host: event.target.value }) }} />
            </label>
            <label className={css.field}><span>{tt('server.port')}</span>
              <input className={css.input} value={direct.port} onChange={(event) => { setDirect({ ...direct, port: event.target.value }) }} />
            </label>
            <label className={css.field}><span>{tt('server.dialog.user')}</span>
              <input className={css.input} value={direct.user} onChange={(event) => { setDirect({ ...direct, user: event.target.value }) }} />
            </label>
            <label className={css.field}><span>{tt('server.dialog.password')}</span>
              <input className={css.input} type="password" value={direct.password} onChange={(event) => { setDirect({ ...direct, password: event.target.value }) }} />
            </label>
            <label className={css.field}><span>{tt('server.dialog.group')}</span>
              <input className={css.input} value={direct.group} onChange={(event) => { setDirect({ ...direct, group: event.target.value }) }} />
            </label>
            <label className={css.field}><span>{tt('server.dialog.tags')}</span>
              <input className={css.input} value={direct.tags} onChange={(event) => { setDirect({ ...direct, tags: event.target.value }) }} />
            </label>
          </div>
        )}

        <div className={css.divider} />

        <div className={css.fieldGrid}>
          <label className={css.field}><span>{tt('server.dialog.runtime')}</span>
            <select className={css.input} value={runtimeKind} onChange={(event) => { setRuntimeKind(event.target.value as RuntimeKind) }}>
              <option value="systemd">systemd</option>
              <option value="compose">docker compose</option>
              <option value="docker">docker</option>
              <option value="supervisor">supervisor</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <label className={css.field}><span>{tt('server.dialog.units')}</span>
            <input className={css.input} value={unit} onChange={(event) => { setUnit(event.target.value) }} />
          </label>
          <label className={css.field}><span>{tt('server.dialog.workdir')}</span>
            <input className={css.input} value={workdir} onChange={(event) => { setWorkdir(event.target.value) }} />
          </label>
          <label className={css.field}><span>{tt('server.dialog.port')}</span>
            <input className={css.input} value={port} onChange={(event) => { setPort(event.target.value) }} />
          </label>
          <label className={css.field}><span>{tt('common.name')} ({tt('common.optional')})</span>
            <input className={css.input} value={name} onChange={(event) => { setName(event.target.value) }} />
          </label>
        </div>

        {notice !== undefined && <div className={css.notice}>{notice}</div>}
        {error !== undefined && <div className={css.error}>{error}</div>}
        <p className={css.hint}>{tt('server.dialog.hint')}</p>
      </div>
      <div className={css.modalFoot}>
        <button type="button" className={css.btn} onClick={onClose}>{tt('action.cancel')}</button>
        <button type="button" className={css.btnPrimary} disabled={busy} onClick={() => { void submit() }}>{tt('action.create')}</button>
      </div>
    </Modal>
  )
}

// --------------------------------------------------------------- new task

/** Script starters offered by the new-task dialog. */
function template(kind: string): { script: string; params: TaskParam[]; risk: TaskRisk } {
  if (kind === 'publish') {
    return {
      script: publishScript(),
      risk: 'write',
      params: [
        { name: 'VERSION', type: 'text', required: true },
        { name: 'ARTIFACT', type: 'file', required: false },
        { name: 'PORT', type: 'number', required: false },
      ],
    }
  }
  if (kind === 'start') return { script: '#!/bin/bash\nset -euo pipefail\nsystemctl start "${DSH_SERVER_UNIT}"\n', risk: 'write', params: [] }
  if (kind === 'stop') return { script: '#!/bin/bash\nset -euo pipefail\nsystemctl stop "${DSH_SERVER_UNIT}"\n', risk: 'write', params: [] }
  if (kind === 'restart') return { script: '#!/bin/bash\nset -euo pipefail\nsystemctl restart "${DSH_SERVER_UNIT}"\n', risk: 'write', params: [] }
  return { script: '#!/bin/bash\nset -euo pipefail\n\n', risk: 'write', params: [] }
}

function NewTaskDialog({ api, serviceId, onClose, onDone }: {
  api: OpsApi
  serviceId: string
  onClose: () => void
  onDone: (task: OpsTask) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState('blank')
  const [taskKind, setTaskKind] = useState<'script' | 'flow'>('script')
  const [error, setError] = useState<string>()
  return (
    <Modal title={tt('task.dialog.new')} onClose={onClose}>
      <div className={css.modalBody}>
        <label className={css.field}><span>{tt('task.name')}</span>
          <input className={css.input} autoFocus value={name} onChange={(event) => { setName(event.target.value) }} />
        </label>
        <label className={css.field}><span>{tt('task.dialog.kind')}</span>
          <select className={css.input} value={taskKind} onChange={(event) => { setTaskKind(event.target.value as 'script' | 'flow') }}>
            <option value="script">{tt('task.kind.script')}</option>
            <option value="flow">{tt('task.kind.flow')}</option>
          </select>
        </label>
        {taskKind === 'script' && (
          <label className={css.field}><span>{tt('task.dialog.template')}</span>
            <select className={css.input} value={kind} onChange={(event) => { setKind(event.target.value) }}>
              <option value="blank">{tt('task.template.blank')}</option>
              <option value="start">{tt('task.template.start')}</option>
              <option value="stop">{tt('task.template.stop')}</option>
              <option value="restart">{tt('task.template.restart')}</option>
              <option value="publish">{tt('task.template.publish')}</option>
            </select>
          </label>
        )}
        {error !== undefined && <div className={css.error}>{error}</div>}
      </div>
      <div className={css.modalFoot}>
        <button type="button" className={css.btn} onClick={onClose}>{tt('action.cancel')}</button>
        <button type="button" className={css.btnPrimary} onClick={() => {
          setError(undefined)
          const starter = template(kind)
          void api.createTask(taskKind === 'flow'
            ? {
                owner: { kind: 'service', id: serviceId },
                name: name.trim() === '' ? tt('task.dialog.new') : name.trim(),
                kind: 'flow',
                script: '',
                steps: [],
                failure: 'stop',
                risk: 'write',
                scope: 'all',
              }
            : {
                owner: { kind: 'service', id: serviceId },
                name: name.trim() === '' ? tt('task.dialog.new') : name.trim(),
                script: starter.script,
                params: starter.params,
                risk: starter.risk,
                scope: 'all',
              }).then(onDone).catch((failure: unknown) => { setError(errorText(failure)) })
        }}>{tt('action.create')}</button>
      </div>
    </Modal>
  )
}

// -------------------------------------------------------------------- run

function RunDialog({ api, task, servers, preselected, onClose, onStarted }: {
  api: OpsApi
  task: OpsTask
  servers: OpsServer[]
  preselected?: string
  onClose: () => void
  onStarted: (run: OpsRun) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const param of task.params) initial[param.name] = param.default ?? ''
    return initial
  })
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (preselected !== undefined) return new Set([preselected])
    return new Set(servers.map(server => server.id))
  })
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function start(): Promise<void> {
    setError(undefined)
    setBusy(true)
    try {
      const run = await api.run(task.id, values, [...selected])
      onStarted(run)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`${tt('run.dialog.title')} · ${task.name}`} onClose={onClose}>
      <div className={css.modalBody}>
        {task.params.length > 0 && (
          <div className={css.fieldGrid}>
            {task.params.map(param => (
              <label className={css.field} key={param.name}>
                <span>{param.name}{param.required === true ? ` · ${tt('common.required')}` : ''}</span>
                {param.type === 'boolean' ? (
                  <select className={css.input} value={values[param.name] ?? 'false'} onChange={(event) => { setValues({ ...values, [param.name]: event.target.value }) }}>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : param.type === 'select' ? (
                  <select className={css.input} value={values[param.name] ?? ''} onChange={(event) => { setValues({ ...values, [param.name]: event.target.value }) }}>
                    <option value="">—</option>
                    {(param.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <input
                    className={css.input}
                    type="text"
                    placeholder={param.type === 'file' ? '/absolute/path/on/this/machine' : ''}
                    value={values[param.name] ?? ''}
                    onChange={(event) => { setValues({ ...values, [param.name]: event.target.value }) }}
                  />
                )}
              </label>
            ))}
          </div>
        )}

        <div className={css.field}>
          <span>{tt('run.dialog.targets')}</span>
          <div className={css.targetList}>
            {servers.map(server => (
              <label className={css.check} key={server.id}>
                <input
                  type="checkbox"
                  checked={selected.has(server.id)}
                  onChange={(event) => {
                    const next = new Set(selected)
                    if (event.target.checked) next.add(server.id)
                    else next.delete(server.id)
                    setSelected(next)
                  }}
                />
                {server.sshAlias}
              </label>
            ))}
          </div>
        </div>

        {error !== undefined && <div className={css.error}>{error}</div>}
      </div>
      <div className={css.modalFoot}>
        <button type="button" className={css.btn} onClick={onClose}>{tt('action.cancel')}</button>
        <button type="button" className={css.btnPrimary} disabled={busy || selected.size === 0} onClick={() => { void start() }}>{tt('run.dialog.start')}</button>
      </div>
    </Modal>
  )
}
