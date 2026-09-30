#!/usr/bin/env node
/**
 * Applies db/schema.sql and inserts default settings.
 *
 *   npm run db:migrate          # schema + defaults (idempotent)
 *   npm run db:seed             # the above + a handful of demo students
 *
 * Uses node-postgres rather than the serverless driver because DDL scripts are
 * easier to ship as one simple-query batch.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync } from 'node:crypto'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// Minimal .env / .env.local reader so the script works without extra deps.
for (const file of ['.env', '.env.local']) {
  const path = join(root, file)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

function hashCode(code) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(code, salt, 32).toString('hex')
  return `scrypt$${salt}$${hash}`
}

const DEFAULT_SETTINGS = {
  general: {
    churchName: 'Bethel Starlight Check-in System',
    locationName: 'Elementary',
    timezone: 'America/Los_Angeles',
    autoReturnSeconds: 5,
  },
  printer: {
    bridgeUrl: '',
    bridgeKey: '',
    mediaWidthMm: 62,
    labelLengthMm: 90,
    copies: 1,
    autocut: true,
    cutAtEnd: true,
    rotate180: false,
    feedDots: 35,
    threshold: 160,
    enabled: true,
  },
  label: {
    showKorean: true,
    showEnglish: true,
    showGrade: true,
    showCode: true,
    showDateTime: true,
    nameScale: 1,
  },
  grades: ['K', '1st', '2nd', '3rd', '4th', '5th', '6th'],
}

const DEMO_STUDENTS = [
  ['김민준', 'Minjun Kim', '3rd', 'male'],
  ['이서연', 'Seoyeon Lee', '1st', 'female'],
  ['박지호', 'Jiho Park', '5th', 'male'],
  [null, 'Ashley Howard', '2nd', 'female'],
  ['최은우', 'Ethan Choi', 'K', 'male'],
  [null, 'Carson Howard', '4th', 'male'],
  ['정하윤', 'Hayoon Jung', '6th', 'female'],
]

// Neon hands out `sslmode=require`. node-postgres currently treats that as
// full certificate verification but warns that v9 will weaken it to libpq's
// meaning. Ask for verification explicitly so the behaviour is pinned and the
// warning goes away. `sslmode=disable` (the local Docker database) is kept.
const client = new pg.Client({
  connectionString: connectionString.replace(
    /([?&]sslmode=)(prefer|require|verify-ca)\b/,
    '$1verify-full'
  ),
})

async function main() {
  await client.connect()

  console.log('→ applying db/schema.sql')
  await client.query(readFileSync(join(root, 'db', 'schema.sql'), 'utf8'))

  console.log('→ inserting default settings (existing values are left alone)')
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await client.query(
      'insert into app_settings (key, value) values ($1, $2) on conflict (key) do nothing',
      [key, JSON.stringify(value)]
    )
  }

  const { rows: adminRows } = await client.query(
    "select 1 from app_settings where key = 'admin_code'"
  )
  if (adminRows.length === 0) {
    await client.query('insert into app_settings (key, value) values ($1, $2)', [
      'admin_code',
      JSON.stringify({ hash: hashCode('1234') }),
    ])
    console.log('   admin code set to 1234 — change it on the Settings screen')
  }

  if (process.argv.includes('--seed')) {
    console.log('→ seeding demo students')
    for (const [korean, english, grade, gender] of DEMO_STUDENTS) {
      await client.query(
        `insert into students (korean_name, english_name, grade, gender)
         select $1, $2, $3, $4
         where not exists (
           select 1 from students
           where coalesce(english_name, '') = coalesce($2, '')
             and coalesce(korean_name, '') = coalesce($1, '')
         )`,
        [korean, english, grade, gender]
      )
    }
  }

  console.log('✓ database ready')
}

main()
  .catch((err) => {
    console.error('✗ migration failed:', err.message)
    process.exitCode = 1
  })
  .finally(() => client.end())
