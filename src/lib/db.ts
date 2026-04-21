import { createConnection, type RowDataPacket } from "mysql2/promise";
import postgres from "postgres";
import type { Bindings } from "../env";

type QueryValue = string | number | boolean | null | Date | Uint8Array | ArrayBuffer;

export interface DbConnection {
  provider: "mysql" | "postgres" | "d1";
  query<T extends RowDataPacket>(sql: string, params?: QueryValue[]): Promise<T[]>;
  exec(sql: string, params?: QueryValue[]): Promise<void>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface DbProviderDiagnostics {
  selectedProvider: "mysql" | "postgres" | "d1";
  configuredProvider: string | null;
  bindings: {
    hyperdrive: boolean;
    d1: boolean;
    postgresUrl: boolean;
    mysqlCredentials: boolean;
  };
}

export function getProvider(env: Bindings): "mysql" | "postgres" | "d1" {
  const configured = (env.DB_PROVIDER || "").trim().toLowerCase();
  if (configured === "postgres" || configured === "postgresql") {
    return "postgres";
  }
  if (configured === "d1") {
    return "d1";
  }
  if (configured === "mysql") {
    return "mysql";
  }

  if (env.DB) {
    return "d1";
  }
  if (env.POSTGRES_URL || env.PG_HOST) {
    return "postgres";
  }
  return "mysql";
}

export function getDbProviderDiagnostics(env: Bindings): DbProviderDiagnostics {
  const configured = (env.DB_PROVIDER || "").trim().toLowerCase();
  return {
    selectedProvider: getProvider(env),
    configuredProvider: configured || null,
    bindings: {
      hyperdrive: Boolean(env.HYPERDRIVE),
      d1: Boolean(env.DB),
      postgresUrl: Boolean(env.POSTGRES_URL || env.PG_HOST),
      mysqlCredentials: Boolean((env.HYPERDRIVE || env.DB_HOST) && (env.HYPERDRIVE || env.DB_USER) && (env.HYPERDRIVE || env.DB_NAME)),
    },
  };
}

function normalizeSqlForD1(sql: string): string {
  return sql
    .replace(/\bNOW\(\)/g, "CURRENT_TIMESTAMP")
    .replace(/\bTRUE\b/g, "1")
    .replace(/\bFALSE\b/g, "0");
}

function convertQuestionParamsToPg(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function isReadQuery(sql: string): boolean {
  return /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)/i.test(sql);
}

async function createMysqlConnection(env: Bindings): Promise<DbConnection> {
  const config = env.HYPERDRIVE
    ? {
        host: env.HYPERDRIVE.host,
        port: env.HYPERDRIVE.port,
        user: env.HYPERDRIVE.user,
        password: env.HYPERDRIVE.password,
        database: env.HYPERDRIVE.database,
        disableEval: true,
        charset: "utf8mb4",
        timezone: "Z",
      }
    : {
        host: env.DB_HOST,
        port: Number(env.DB_PORT || "3306"),
        user: env.DB_USER,
        password: env.DB_PASS || "",
        database: env.DB_NAME,
        disableEval: true,
        charset: "utf8mb4",
        timezone: "Z",
      };

  if (!config.host || !config.user || !config.database) {
    throw new Error("MySQL configuration is missing. Set Hyperdrive or DB_* vars.");
  }

  const connection = await createConnection(config);

  return {
    provider: "mysql",
    async query<T extends RowDataPacket>(sql: string, params: QueryValue[] = []) {
      const [rows] = await (connection as any).query(sql, params);
      return rows as T[];
    },
    async exec(sql: string, params: QueryValue[] = []) {
      await (connection as any).query(sql, params);
    },
    async beginTransaction() {
      await connection.beginTransaction();
    },
    async commit() {
      await connection.commit();
    },
    async rollback() {
      await connection.rollback();
    },
    async close() {
      await connection.end();
    },
  };
}

async function createPostgresConnection(env: Bindings): Promise<DbConnection> {
  const sql = env.POSTGRES_URL
    ? postgres(env.POSTGRES_URL, {
        max: 1,
        prepare: false,
      })
    : postgres({
        host: env.HYPERDRIVE?.host || env.PG_HOST,
        port: env.HYPERDRIVE?.port || Number(env.PG_PORT || "5432"),
        user: env.HYPERDRIVE?.user || env.PG_USER,
        password: env.HYPERDRIVE?.password || env.PG_PASS || "",
        database: env.HYPERDRIVE?.database || env.PG_DATABASE,
        max: 1,
        prepare: false,
      });

  return {
    provider: "postgres",
    async query<T extends RowDataPacket>(rawSql: string, params: QueryValue[] = []) {
      const rows = await sql.unsafe(convertQuestionParamsToPg(rawSql), params as any[]);
      return rows as unknown as T[];
    },
    async exec(rawSql: string, params: QueryValue[] = []) {
      await sql.unsafe(convertQuestionParamsToPg(rawSql), params as any[]);
    },
    async beginTransaction() {
      await sql.unsafe("BEGIN");
    },
    async commit() {
      await sql.unsafe("COMMIT");
    },
    async rollback() {
      await sql.unsafe("ROLLBACK");
    },
    async close() {
      await sql.end({ timeout: 0 });
    },
  };
}

async function createD1Connection(env: Bindings): Promise<DbConnection> {
  if (!env.DB) {
    throw new Error("D1 binding is missing. Add DB binding in wrangler.toml.");
  }

  const database = env.DB;

  return {
    provider: "d1",
    async query<T extends RowDataPacket>(rawSql: string, params: QueryValue[] = []) {
      const sql = normalizeSqlForD1(rawSql);
      if (!isReadQuery(sql)) {
        await database.prepare(sql).bind(...params).run();
        return [] as T[];
      }
      const result = await database.prepare(sql).bind(...params).all<T>();
      return (result.results || []) as T[];
    },
    async exec(rawSql: string, params: QueryValue[] = []) {
      const sql = normalizeSqlForD1(rawSql);
      await database.prepare(sql).bind(...params).run();
    },
    async beginTransaction() {
      await database.exec("BEGIN");
    },
    async commit() {
      await database.exec("COMMIT");
    },
    async rollback() {
      await database.exec("ROLLBACK");
    },
    async close() {},
  };
}

export async function withConnection<T>(env: Bindings, fn: (connection: DbConnection) => Promise<T>): Promise<T> {
  const provider = getProvider(env);
  const connection =
    provider === "d1"
      ? await createD1Connection(env)
      : provider === "postgres"
        ? await createPostgresConnection(env)
        : await createMysqlConnection(env);

  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

export async function pingDatabase(env: Bindings): Promise<{
  provider: "mysql" | "postgres" | "d1";
  ok: boolean;
  currentTime?: string | null;
  error?: string;
}> {
  const provider = getProvider(env);

  try {
    const result = await withConnection(env, async (connection) => {
      const rows = await queryRows<RowDataPacket & { value?: number; current_ts?: string | Date }>(
        connection,
        "SELECT 1 AS value, CURRENT_TIMESTAMP AS current_ts",
      );
      const row = rows[0];
      const currentTime =
        row?.current_ts instanceof Date
          ? row.current_ts.toISOString()
          : typeof row?.current_ts === "string"
            ? row.current_ts
            : null;

      return {
        provider: connection.provider,
        ok: true,
        currentTime,
      };
    });

    return result;
  } catch (error) {
    return {
      provider,
      ok: false,
      error: error instanceof Error ? error.message : "Database connection failed",
    };
  }
}

export async function queryRows<T extends RowDataPacket>(
  connection: DbConnection,
  sql: string,
  params: QueryValue[] = [],
): Promise<T[]> {
  return connection.query<T>(sql, params);
}

export function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}
