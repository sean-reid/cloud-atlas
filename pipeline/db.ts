import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "./log";

export type Row = Record<string, string | number | null>;

// The pipeline talks to D1 through this: statements with inlined literals so the same text
// runs against the local SQLite file wrangler keeps, an in-memory database in tests, and the
// D1 HTTP API in production.
export interface Db {
  exec(sql: string): Promise<void>;
  query<T extends Row = Row>(sql: string, params?: (string | number | null)[]): Promise<T[]>;
  close(): Promise<void>;
}

export const lit = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${v.replace(/'/g, "''")}'`;
};

export class SqliteDb implements Db {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  async query<T extends Row = Row>(
    sql: string,
    params: (string | number | null)[] = [],
  ): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  async close(): Promise<void> {
    this.db.close();
  }
}

export function applyMigrations(db: SqliteDb, dir: string): Promise<void> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return db.exec(files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n"));
}

// wrangler keeps the local D1 database as a SQLite file under .wrangler; the newest one is ours.
export function localD1Path(root: string): string | null {
  const dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0] ? join(dir, files[0].f) : null;
  } catch {
    return null;
  }
}

interface D1Response<T> {
  success: boolean;
  errors: { message: string }[];
  result: { results: T[]; success: boolean }[];
}

export class D1HttpDb implements Db {
  private constructor(
    private readonly account: string,
    private readonly token: string,
    private readonly database: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  static async connect(opts: {
    account: string;
    token: string;
    name: string;
    fetchImpl?: typeof fetch;
  }): Promise<D1HttpDb> {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(
      `https://api.cloudflare.com/client/v4/accounts/${opts.account}/d1/database?name=${encodeURIComponent(opts.name)}`,
      {
        headers: { authorization: `Bearer ${opts.token}` },
      },
    );
    const body = (await res.json()) as {
      success: boolean;
      result: { uuid: string; name: string }[];
      errors: { message: string }[];
    };
    if (!body.success)
      throw new Error(`d1 list failed: ${body.errors.map((e) => e.message).join("; ")}`);
    const db = body.result.find((d) => d.name === opts.name);
    if (!db) throw new Error(`no D1 database named ${opts.name}; the deploy workflow creates it`);
    return new D1HttpDb(opts.account, opts.token, db.uuid, f);
  }

  private async call<T>(sql: string, params: (string | number | null)[]): Promise<T[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.account}/d1/database/${this.database}/query`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sql, params }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = Math.min(1000 * 2 ** attempt, 15_000);
        log("warn", "d1.retry", { status: res.status, wait_ms: wait });
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const body = (await res.json()) as D1Response<T>;
      if (!res.ok || !body.success)
        throw new Error(
          `d1 query failed (${res.status}): ${body.errors?.map((e) => e.message).join("; ")}`,
        );
      return body.result.flatMap((r) => r.results ?? []);
    }
  }

  async exec(sql: string): Promise<void> {
    await this.call(sql, []);
  }
  async query<T extends Row = Row>(
    sql: string,
    params: (string | number | null)[] = [],
  ): Promise<T[]> {
    return this.call<T>(sql, params);
  }
  async close(): Promise<void> {}
}

// Collects statements and sends them in size-bounded batches; D1 rejects very long statements
// and each HTTP round trip costs more than the statement itself.
export class Batch {
  private pending: string[] = [];
  private bytes = 0;
  constructor(
    private readonly db: Db,
    private readonly maxBytes = 60_000,
  ) {}
  async add(sql: string): Promise<void> {
    if (this.pending.length && this.bytes + sql.length > this.maxBytes) await this.flush();
    this.pending.push(sql);
    this.bytes += sql.length + 1;
  }
  async flush(): Promise<void> {
    if (!this.pending.length) return;
    const sql = this.pending.join("\n");
    this.pending = [];
    this.bytes = 0;
    await this.db.exec(sql);
  }
}
