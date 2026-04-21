export interface HyperdriveBindingLike {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  exec(query: string): Promise<unknown>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
    },
  ): Promise<unknown>;
}

export interface Bindings {
  APP_ENV?: string;
  API_BASE_URL?: string;
  SESSION_EXPIRY_HOURS?: string;
  DB_PROVIDER?: string;
  ADMIN_USER_IDS?: string;

  DB_HOST?: string;
  DB_PORT?: string;
  DB_NAME?: string;
  DB_USER?: string;
  DB_PASS?: string;
  POSTGRES_URL?: string;
  PG_HOST?: string;
  PG_PORT?: string;
  PG_DATABASE?: string;
  PG_USER?: string;
  PG_PASS?: string;

  HYPERDRIVE?: HyperdriveBindingLike;
  DB?: D1DatabaseLike;
  UPLOADS_BUCKET?: R2BucketLike;
  R2_PUBLIC_URL?: string;
  FILE_UPLOAD_PREFIX?: string;
  FILE_UPLOAD_MAX_SIZE?: string;
  FILE_UPLOAD_ALLOWED_TYPES?: string;
  UPLOAD_METADATA_TABLE?: string;
  PAYMENT_WEBHOOK_AUDIT_TABLE?: string;
  WORKFLOW_MONITORING_TABLE?: string;
  TAILORED_EXTERNAL_API_URL?: string;
  TAILORED_EXTERNAL_API_KEY?: string;
  TAILORED_CALLBACK_SECRET?: string;

  TYPESENSE_HOST?: string;
  TYPESENSE_PORT?: string;
  TYPESENSE_API_KEY?: string;
  TYPESENSE_COLLECTION?: string;
  TYPESENSE_TAGS_COLLECTION?: string;
  TYPESENSE_PROTOCOL?: string;
  TYPESENSE_TIMEOUT_MS?: string;

  TOSS_PAYMENTS_SECRET_KEY?: string;
  TOSS_PAYMENTS_BILLING_SECRET_KEY?: string;
  TOSS_WEBHOOK_SECRET?: string;
}

export function getAppEnv(env: Bindings): string {
  return env.APP_ENV || "development";
}

export function getApiBaseUrl(env: Bindings): string {
  return env.API_BASE_URL || "http://localhost:8787";
}
