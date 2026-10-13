import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL. Configura la conexión de PostgreSQL/Neon en .env.');
}

const databaseUrl = new URL(process.env.DATABASE_URL);
const isLocalDatabase = ['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname);
if (isLocalDatabase) {
  databaseUrl.searchParams.delete('sslmode');
  databaseUrl.searchParams.delete('channel_binding');
} else {
  databaseUrl.searchParams.set('sslmode', 'verify-full');
}

export const pool = new Pool({
  connectionString: databaseUrl.toString(),
  ssl: isLocalDatabase ? false : { rejectUnauthorized: true },
  max: process.env.VERCEL ? 1 : 10,
  idleTimeoutMillis: process.env.VERCEL ? 5000 : 30000,
  connectionTimeoutMillis: 10000,
});

export async function initializeDatabase() {
  const schemaUrl = new URL('../db/schema.sql', import.meta.url);
  const schema = await readFile(fileURLToPath(schemaUrl), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(740214)');
    await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function inTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
