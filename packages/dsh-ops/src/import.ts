/**
 * Server repository import: CSV paste and the standard OpenSSH config.
 *
 * CSV rows become dsh-ssh host entries through the transport's `createHost`;
 * a row that fails validation is counted as skipped with its reason instead of
 * aborting the batch. The `group` column maps onto the host entry's
 * `environment` field, which is what the picker groups by.
 */

import type { ImportStats } from './protocol.ts'
import type { OpsTransport, TransportHostPayload } from './transport.ts'

/** Column names a CSV header may use. */
const COLUMNS = [
  'alias',
  'host',
  'port',
  'user',
  'password',
  'keyPath',
  'group',
  'tags',
  'description',
] as const

/** Parse CSV text (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(entry => entry.some(cell => cell.trim() !== ''))
}

/** Map one data row onto a host payload. */
function rowToHost(row: string[], lookup: (name: string) => number): TransportHostPayload & { group?: string } {
  const alias = row[lookup('alias')]?.trim() ?? ''
  const host = row[lookup('host')]?.trim() ?? ''
  const user = row[lookup('user')]?.trim() ?? ''
  if (alias === '') throw new Error('alias is required')
  if (host === '') throw new Error('host is required')
  if (user === '') throw new Error('user is required')
  const portText = row[lookup('port')]?.trim() ?? ''
  const port = portText === '' ? 22 : Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port '${portText}'`)
  const password = row[lookup('password')] ?? ''
  const keyPath = row[lookup('keyPath')]?.trim() ?? ''
  const auth: TransportHostPayload['auth'] = keyPath !== ''
    ? { kind: 'key', keyPath }
    : { kind: 'password', password }
  const tags = (row[lookup('tags')] ?? '')
    .split(/[;|]/)
    .map(tag => tag.trim())
    .filter(tag => tag !== '')
  return {
    alias,
    host,
    port,
    user,
    auth,
    group: row[lookup('group')]?.trim() || undefined,
    tags,
    description: row[lookup('description')]?.trim() || undefined,
  }
}

/**
 * Import hosts from CSV text.
 *
 * Accepted header (case-insensitive, any order): `alias,host,port,user,password,
 * keyPath,group,tags,description`. Without a header the columns are read in
 * that same order. `tags` is separated by `;` or `|`.
 * @param text - CSV body.
 * @param transport - repository transport (createHost).
 * @returns parsed/added/skipped statistics.
 */
export function importHostsCsv(text: string, transport: OpsTransport): ImportStats {
  const rows = parseCsv(text)
  if (rows.length === 0) return { parsed: 0, added: 0, skipped: 0, skippedBlocks: [] }
  const header = rows[0].map(cell => cell.trim().toLowerCase())
  const hasHeader = header.includes('alias') && header.includes('host')
  const data = hasHeader ? rows.slice(1) : rows
  const columnIndex = (name: string): number => {
    if (hasHeader) {
      const at = header.indexOf(name.toLowerCase())
      return at < 0 ? -1 : at
    }
    return COLUMNS.indexOf(name as typeof COLUMNS[number])
  }
  const index = (name: string): number => {
    const at = columnIndex(name)
    return at < 0 ? -1 : at
  }

  let added = 0
  const skippedBlocks: Array<{ name: string; reason: string }> = []
  for (const row of data) {
    let alias = ''
    try {
      const payload = rowToHost(row, index)
      alias = String(payload.alias)
      transport.createHost({
        ...payload,
        environment: payload.group,
      })
      added += 1
    } catch (error) {
      skippedBlocks.push({
        name: alias !== '' ? alias : row[0]?.trim() ?? '(empty row)',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { parsed: data.length, added, skipped: skippedBlocks.length, skippedBlocks }
}
