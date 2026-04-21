declare module "postgres" {
  export interface PostgresClient {
    unsafe<T = unknown>(query: string, params?: readonly unknown[]): Promise<T>;
    end(options?: { timeout?: number }): Promise<void>;
  }

  export interface PostgresOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    max?: number;
    prepare?: boolean;
  }

  export default function postgres(
    optionsOrUrl?: string | PostgresOptions,
    maybeOptions?: PostgresOptions,
  ): PostgresClient;
}
