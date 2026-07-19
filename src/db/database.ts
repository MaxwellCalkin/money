export interface QueryRows<T> {
  rows: T[];
  rowCount?: number | null;
  affectedRows?: number;
}

/** Small common surface shared by node-postgres and the embedded Postgres
 * runtime used in tests. Keeping SQL behind this interface prevents a test
 * double from quietly replacing real database semantics. */
export interface SqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryRows<T>>;
  /** Execute a trusted SQL script containing one or more statements. Never use
   * this for interpolated request data; migrations are its intended caller. */
  executeScript(text: string): Promise<void>;
}

export interface TransactionalDatabase extends SqlExecutor {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
