import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Client } = pkg;
import * as schema from './schema.js';
import 'dotenv/config';

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

await client.connect();

export const db = drizzle(client, { schema });