import { describe, expect, it } from "vitest";
import { PostgresDatabase, resolvePostgresSsl } from "../src/db/postgres.ts";

const CA = "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----";

/** MONEY_DB_SSL is the hosted beta's TLS contract: `verify-full` pins the
 * provider CA and verifies the hostname. The adapter also strips in-URL TLS
 * parameters when an explicit `ssl` option is given, because pg merges the
 * parsed URL over the explicit config and an in-URL `sslmode=require` would
 * silently replace the CA pin with a MITM-tolerant empty object. */
describe("resolvePostgresSsl", () => {
  it("leaves pg's default when MONEY_DB_SSL is unset or off", () => {
    expect(resolvePostgresSsl({})).toBeUndefined();
    expect(resolvePostgresSsl({ MONEY_DB_SSL: "off" })).toBeUndefined();
    expect(resolvePostgresSsl({ MONEY_DB_SSL: "" })).toBeUndefined();
  });

  it("requires a CA for verify-full and pins it", () => {
    expect(() => resolvePostgresSsl({ MONEY_DB_SSL: "verify-full" })).toThrow(/MONEY_DB_SSL_CA/);
    expect(() => resolvePostgresSsl({ MONEY_DB_SSL: "verify-full", MONEY_DB_SSL_CA: "   " })).toThrow(/MONEY_DB_SSL_CA/);
    expect(resolvePostgresSsl({ MONEY_DB_SSL: "verify-full", MONEY_DB_SSL_CA: CA }))
      .toEqual({ ca: CA, rejectUnauthorized: true });
  });

  it("maps require to an unverified TLS session and refuses unknown modes", () => {
    expect(resolvePostgresSsl({ MONEY_DB_SSL: "require" })).toEqual({ rejectUnauthorized: false });
    expect(() => resolvePostgresSsl({ MONEY_DB_SSL: "verify-ca" })).toThrow(/MONEY_DB_SSL must be one of/);
    expect(() => resolvePostgresSsl({ MONEY_DB_SSL: "prefer" })).toThrow(/MONEY_DB_SSL must be one of/);
  });
});

describe("PostgresDatabase TLS option precedence", () => {
  it("strips in-URL TLS parameters when an explicit ssl option is given", async () => {
    const db = new PostgresDatabase({
      connectionString: "postgresql://money_app_login.ref:pw@db.invalid:6543/postgres?sslmode=require&sslrootcert=x&application_name=keep",
      ssl: { rejectUnauthorized: false },
    });
    try {
      const options = db.pool.options as { ssl?: { rejectUnauthorized?: boolean }; connectionString?: string };
      expect(options.ssl?.rejectUnauthorized).toBe(false);
      expect(options.connectionString).not.toMatch(/sslmode|sslrootcert/);
      expect(options.connectionString).toBe(
        "postgresql://money_app_login.ref:pw@db.invalid:6543/postgres?application_name=keep",
      );
    } finally {
      await db.close();
    }
  });

  it("drops the whole query when TLS parameters were the only ones", async () => {
    const db = new PostgresDatabase({
      connectionString: "postgresql://u:p@db.invalid:5432/x?sslmode=verify-full&ssl=true",
      ssl: { ca: CA, rejectUnauthorized: true },
    });
    try {
      const options = db.pool.options as { ssl?: { ca?: string; rejectUnauthorized?: boolean }; connectionString?: string };
      expect(options.connectionString).toBe("postgresql://u:p@db.invalid:5432/x");
      expect(options.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
    } finally {
      await db.close();
    }
  });

  it("leaves the connection string untouched when no ssl option is given", async () => {
    const db = new PostgresDatabase({
      connectionString: "postgresql://u:p@db.invalid:5432/x?sslmode=require",
    });
    try {
      const options = db.pool.options as { ssl?: unknown; connectionString?: string };
      expect(options.connectionString).toBe("postgresql://u:p@db.invalid:5432/x?sslmode=require");
      expect(options.ssl).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});
