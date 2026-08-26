import { readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { databaseSchemaVersion } from './schema'
import { SqliteCalendarRepository } from './sqlite-repository'

export interface DatabaseRuntimeStatus {
  status: 'healthy' | 'recovered' | 'memory'
  schemaVersion: number
  quickCheck: 'ok'
  recoveryCopyCreated: boolean
  error: string | null
}

export interface OpenedCalendarDatabase {
  repository: SqliteCalendarRepository
  status: DatabaseRuntimeStatus
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The local calendar database could not open.'
}

function canRecover(error: unknown): boolean {
  return /(?:malformed|not a database|encrypted|corrupt|quick check failed)/iu.test(
    errorMessage(error)
  )
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function moveIfPresent(source: string, destination: string): Promise<void> {
  if (await regularFileExists(source)) await rename(source, destination)
}

export async function deleteCalendarRecoveryCopies(databasePath: string): Promise<number> {
  if (databasePath === ':memory:') return 0
  const directory = dirname(databasePath)
  const prefix = `${basename(databasePath)}.recovery-`
  let deleted = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
    try {
      await unlink(join(directory, entry.name))
      deleted += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return deleted
}

export async function openCalendarDatabase(databasePath: string): Promise<OpenedCalendarDatabase> {
  if (databasePath === ':memory:') {
    const repository = new SqliteCalendarRepository(databasePath)
    return {
      repository,
      status: {
        status: 'memory',
        schemaVersion: repository.getSchemaVersion(),
        quickCheck: repository.quickCheck(),
        recoveryCopyCreated: false,
        error: null
      }
    }
  }

  try {
    const repository = new SqliteCalendarRepository(databasePath)
    return {
      repository,
      status: {
        status: 'healthy',
        schemaVersion: repository.getSchemaVersion(),
        quickCheck: repository.quickCheck(),
        recoveryCopyCreated: false,
        error: null
      }
    }
  } catch (error) {
    if (!(await regularFileExists(databasePath)) || !canRecover(error)) throw error
    const originalError = errorMessage(error)
    const suffix = new Date().toISOString().replace(/[:.]/gu, '-')
    const recoveryPath = `${databasePath}.recovery-${suffix}`
    await moveIfPresent(databasePath, recoveryPath)
    await moveIfPresent(`${databasePath}-wal`, `${recoveryPath}-wal`)
    await moveIfPresent(`${databasePath}-shm`, `${recoveryPath}-shm`)
    const repository = new SqliteCalendarRepository(databasePath)
    if (repository.getSchemaVersion() !== databaseSchemaVersion) {
      repository.close()
      throw new Error('The recovered database did not reach the current schema version', {
        cause: error
      })
    }
    return {
      repository,
      status: {
        status: 'recovered',
        schemaVersion: repository.getSchemaVersion(),
        quickCheck: repository.quickCheck(),
        recoveryCopyCreated: true,
        error: `A damaged local database was preserved and a clean calendar was opened. ${originalError}`
      }
    }
  }
}
