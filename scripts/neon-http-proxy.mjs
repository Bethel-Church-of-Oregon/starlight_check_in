#!/usr/bin/env node
/**
 * Local stand-in for Neon's HTTP SQL endpoint — development and testing only.
 *
 * The app talks to Neon over HTTP (`@neondatabase/serverless`), which means it
 * cannot talk to a plain Postgres. This translates that HTTP protocol into
 * ordinary libpq queries so the whole app can be run and tested against a
 * throwaway local database:
 *
 *   docker run -d --name starlight-pg -e POSTGRES_PASSWORD=dev \
 *     -e POSTGRES_DB=starlight -p 55432:5432 postgres:16-alpine
 *   PROXY_DATABASE_URL="postgresql://postgres:dev@localhost:55432/starlight" \
 *     node scripts/neon-http-proxy.mjs
 *
 * Then run the app with:
 *   NEON_FETCH_ENDPOINT=http://localhost:54320/sql
 *
 * Never point production at this.
 */
import http from 'node:http'
import pg from 'pg'

const connectionString =
  process.env.PROXY_DATABASE_URL ?? 'postgresql://postgres:dev@localhost:55432/starlight'
const port = Number(process.env.PROXY_PORT ?? 54320)

const pool = new pg.Pool({ connectionString, max: 10 })

/** Neon's HTTP endpoint returns every column as raw text; the driver parses. */
const RAW_TEXT = { getTypeParser: () => (value) => value }

async function runQuery(client, { query, params }) {
  const result = await client.query({
    text: query,
    values: params ?? [],
    rowMode: 'array',
    types: RAW_TEXT,
  })
  return {
    command: result.command,
    rowCount: result.rowCount,
    fields: (result.fields ?? []).map((f) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
      tableID: f.tableID,
      columnID: f.columnID,
      dataTypeSize: f.dataTypeSize,
      dataTypeModifier: f.dataTypeModifier,
      format: 'text',
    })),
    rows: result.rows,
    rowAsArray: true,
  }
}

const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', async () => {
    const send = (status, body) => {
      const json = JSON.stringify(body)
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      })
      response.end(json)
    }

    if (request.method !== 'POST') return send(405, { message: 'POST only' })

    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch (error) {
      return send(400, { message: `bad JSON: ${error.message}` })
    }

    const client = await pool.connect()
    try {
      if (Array.isArray(body.queries)) {
        // sql.transaction([...]) — all or nothing, like the real endpoint.
        await client.query('begin')
        const results = []
        for (const item of body.queries) results.push(await runQuery(client, item))
        await client.query('commit')
        return send(200, { results })
      }
      return send(200, await runQuery(client, body))
    } catch (error) {
      await client.query('rollback').catch(() => {})
      // Shape mirrors what the driver turns into a thrown error.
      return send(400, {
        message: error.message,
        code: error.code,
        severity: error.severity,
        detail: error.detail,
        hint: error.hint,
        constraint: error.constraint,
      })
    } finally {
      client.release()
    }
  })
})

server.listen(port, () => {
  console.log(`neon-http-proxy → ${connectionString}`)
  console.log(`listening on http://localhost:${port}/sql`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close()
    void pool.end()
    process.exit(0)
  })
}
