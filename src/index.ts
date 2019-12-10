import { SynorError } from '@synor/core'
import { createConnection } from 'mysql'
import { performance } from 'perf_hooks'
import { getQueryStore } from './queries'
import { ensureMigrationRecordTable } from './utils/ensure-migration-record-table'
import { getEngineConfig } from './utils/get-engine-config'
import { getMySQLConfig } from './utils/get-mysql-config'
import { runQuery } from './utils/run-query'

type DatabaseEngine = import('@synor/core').DatabaseEngine
type DatabaseEngineFactory = import('@synor/core').DatabaseEngineFactory
type MigrationSource = import('@synor/core').MigrationSource

type MySQLDatabaseEngine = DatabaseEngine

export const MySQLDatabaseEngine: DatabaseEngineFactory = (
  uri,
  { baseVersion, getAdvisoryLockId, getUserInfo }
): MySQLDatabaseEngine => {
  const engineConfig = getEngineConfig(uri)
  const mysqlConfig = getMySQLConfig(uri)

  const advisoryLockId = getAdvisoryLockId(
    mysqlConfig.database,
    engineConfig.migrationTableName
  ).join(':')

  const connection = createConnection(mysqlConfig)

  const queryStore = getQueryStore(connection, {
    migrationTableName: engineConfig.migrationTableName,
    databaseName: mysqlConfig.database,
    advisoryLockId
  })

  let appliedBy = ''

  const open: MySQLDatabaseEngine['open'] = async () => {
    appliedBy = await getUserInfo()
    await queryStore.openConnection()
    await ensureMigrationRecordTable(queryStore, baseVersion)
  }

  const close: MySQLDatabaseEngine['close'] = async () => {
    await queryStore.closeConnection()
  }

  const lock: MySQLDatabaseEngine['lock'] = async () => {
    const lockResult = await queryStore.getLock()
    if ([0, null].includes(lockResult)) {
      throw new SynorError('Failed to Get Lock', { lockId: advisoryLockId })
    }
  }

  const unlock: MySQLDatabaseEngine['unlock'] = async () => {
    const lockResult = await queryStore.releaseLock()
    if ([0, null].includes(lockResult)) {
      throw new SynorError('Failed to Release Lock', { lockId: advisoryLockId })
    }
  }

  const drop: MySQLDatabaseEngine['drop'] = async () => {
    const tableNames = await queryStore.getTableNames()
    await queryStore.dropTables(tableNames)
  }

  const run: MySQLDatabaseEngine['run'] = async ({
    version,
    type,
    title,
    hash,
    body
  }: MigrationSource) => {
    let dirty = false

    const startTime = performance.now()

    try {
      await runQuery(connection, body)
    } catch (err) {
      dirty = true

      throw err
    } finally {
      const endTime = performance.now()

      await queryStore.addRecord({
        version,
        type,
        title,
        hash,
        appliedAt: new Date(),
        appliedBy,
        executionTime: endTime - startTime,
        dirty
      })
    }
  }

  const repair: MySQLDatabaseEngine['repair'] = async records => {
    await queryStore.deleteDirtyRecords()

    for (const { id, hash } of records) {
      await queryStore.updateRecord(id, { hash })
    }
  }

  const records: MySQLDatabaseEngine['records'] = async startId => {
    return queryStore.getRecords(startId)
  }

  return {
    open,
    close,
    lock,
    unlock,
    drop,
    run,
    repair,
    records
  }
}
