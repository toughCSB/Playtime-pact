import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

class SqliteD1Statement {
  constructor(owner, sql, values = []) {
    this.owner = owner
    this.sql = sql
    this.values = values
  }

  bind(...values) {
    return new SqliteD1Statement(this.owner, this.sql, values)
  }

  async all() {
    return this.owner.execute(this)
  }
}

export class SqliteD1Database {
  constructor(schemaUrl) {
    this.sqlite = new DatabaseSync(':memory:')
    this.sqlite.exec(readFileSync(schemaUrl, 'utf8'))
  }

  prepare(sql) {
    return new SqliteD1Statement(this, sql)
  }

  execute(statement) {
    const prepared = this.sqlite.prepare(statement.sql)
    const results = prepared.all(...statement.values)
    return { results, success: true }
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => this.execute(statement))
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.sqlite.close()
  }
}
