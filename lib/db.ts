import { env } from "./env";
import { SCHEMA } from "./schema";

// A tiny query layer over two drivers:
//  - Neon (serverless Postgres over HTTP) when DATABASE_URL is a postgres URL (production)
//  - PGlite (Postgres compiled to WebAssembly) for local dev: data in .data/db, or in memory for tests
// Every query is a single statement, which both drivers support without transactions.

type Row = Record<string, unknown>;
type Driver = { query: (text: string, params?: unknown[]) => Promise<Row[]> };

// Kept on globalThis: Next.js loads pages and API routes as separate bundles, and the local
// PGlite database must be opened only once per process (two copies would not see each other's writes).
const store = globalThis as unknown as { __clipAutopilotDb?: Promise<Driver> | null };

async function createDriver(): Promise<Driver> {
  const url = env.databaseUrl;
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    return { query: async (text, params = []) => (await sql.query(text, params as unknown[])) as Row[] };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const target = url === "memory://" ? "memory://" : url || "./.data/db";
  if (target !== "memory://") {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(target, { recursive: true });
  }
  const db = new PGlite(target);
  await db.waitReady;
  return { query: async (text, params = []) => (await db.query<Row>(text, params as unknown[])).rows };
}

async function migrate(driver: Driver) {
  // Split on statement ends; the schema has no functions or quoted semicolons.
  for (const statement of SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await driver.query(statement);
  }
}

async function driver(): Promise<Driver> {
  if (!store.__clipAutopilotDb) {
    store.__clipAutopilotDb = (async () => {
      const d = await createDriver();
      await migrate(d);
      return d;
    })().catch((err) => {
      store.__clipAutopilotDb = null;
      throw err;
    });
  }
  return store.__clipAutopilotDb;
}

export async function query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const d = await driver();
  return (await d.query(text, params)) as T[];
}

export async function queryOne<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export function newId(): string {
  return crypto.randomUUID();
}

/** For tests: drop the cached connection so the next query starts a fresh database. */
export function resetDbForTests() {
  store.__clipAutopilotDb = null;
}
