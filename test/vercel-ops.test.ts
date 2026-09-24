import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

const backup = read(".github/workflows/beta-backup.yml");
const drill = read(".github/workflows/beta-restore-drill.yml");
const ci = read(".github/workflows/ci.yml");
const publish = read(".github/workflows/publish-packages.yml");
const setup = read("deploy/vercel/setup.sql");
const setupExtensions = read("deploy/vercel/setup-extensions.sql");
const setupShim = read("deploy/vercel/setup-shim.sql");
const logins = read("deploy/vercel/logins.sql");
const dataApi = read("deploy/vercel/data-api.sql");
const schedule = read("deploy/vercel/schedule.sql");
const verify = read("deploy/vercel/verify.sql");

/** `uses: owner/repo@<40-hex>` -> { "owner/repo": sha }; throws on an unpinned use. */
function actionPins(text: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const use = line.match(/^\s*(?:- )?uses:\s*(\S+)/);
    if (!use) continue;
    const pinned = (use[1] ?? "").match(/^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})$/);
    if (!pinned || !pinned[1] || !pinned[2]) throw new Error(`unpinned action: ${line.trim()}`);
    pins[pinned[1]] = pinned[2];
  }
  return pins;
}

const IMAGE_PIN = /postgres:17\.\d+-bookworm@sha256:[0-9a-f]{64}/g;
const LITERAL_CREDENTIALS = /postgres(ql)?:\/\/[^$"']+:[^$"']+@/;
const lines = (text: string): string[] => text.split("\n");
/** The YAML minus its `#` comment lines: what the runner actually executes. */
const yamlCode = (text: string): string => lines(text).filter((line) => !/^\s*#/.test(line)).join("\n");
/** The SQL minus its `--` comment lines: what psql actually executes. */
const sqlCode = (text: string): string => lines(text).filter((line) => !/^\s*--/.test(line)).join("\n");

/** The hosted beta's backup and restore-drill workflows plus the Supabase-only
 * SQL under deploy/vercel/ are reviewed as text: pinned actions and images,
 * environment-scoped secrets, schema-scoped dumps, counts-only output, and no
 * literal credential anywhere (spec: hosted beta v2, section 2.8). */
describe("beta-backup workflow", () => {
  it("pins checkout and upload-artifact to the SHAs ci.yml and publish-packages.yml use", () => {
    const pins = actionPins(backup);
    expect(Object.keys(pins).sort()).toEqual(["actions/checkout", "actions/upload-artifact"]);
    expect(pins["actions/checkout"]).toBe(actionPins(ci)["actions/checkout"]);
    expect(pins["actions/upload-artifact"]).toBe(actionPins(publish)["actions/upload-artifact"]);
    expect(backup).toMatch(/persist-credentials: false/);
  });

  it("runs nightly or by hand from the beta-backup environment with read-only permissions", () => {
    expect(backup).toMatch(/^on:\n  schedule:\n    - cron: "17 3 \* \* \*"\n  workflow_dispatch:\n\n/m);
    expect(yamlCode(backup)).not.toMatch(/pull_request|^\s+push:/m);
    expect(backup).toMatch(/^permissions:\n  contents: read\n\n/m);
    expect(backup).not.toMatch(/:\s*write\b/);
    expect(backup).toMatch(/^    environment: beta-backup$/m);
    expect(backup).toMatch(/^concurrency:\n  group: beta-backup\n  cancel-in-progress: false$/m);
  });

  it("dumps only money and money_private through the pinned client with the URL in env, never argv", () => {
    const dump = lines(backup).find((line) => line.includes("pg_dump --dbname="));
    expect(dump).toBeDefined();
    expect(dump).toContain("--format=custom");
    expect(dump).toContain("--no-owner --no-privileges");
    expect(dump).toContain("--enable-row-security");
    expect(dump).toContain("--schema=money --schema=money_private");
    expect(dump).not.toContain("--schema=public");
    expect(dump).toMatch(/sh -c 'pg_dump --dbname="\$BETA_BACKUP_DATABASE_URL" [^']*'/);
    // The URL variable is referenced exactly once: inside that single-quoted
    // container command, so it expands only in the container's environment.
    expect(backup.match(/\$BETA_BACKUP_DATABASE_URL/g)).toHaveLength(1);
    expect(backup).toMatch(/-e BETA_BACKUP_DATABASE_URL\b/);
    expect(backup).toMatch(/-e PGSSLMODE=verify-full/);
    expect(backup).toMatch(/-e PGSSLROOTCERT=\/ca\.pem/);
    expect(backup).toMatch(/-v "\$RUNNER_TEMP\/ca\.pem:\/ca\.pem:ro"/);
    expect(backup).toMatch(/umask 077\n\s+printf '%s\\n' "\$BETA_BACKUP_SSL_CA" > "\$RUNNER_TEMP\/ca\.pem"/);
    expect(backup).not.toMatch(/sslmode=/);
    expect(backup).not.toMatch(/apt-get install[^\n]*postgresql-client/);
  });

  it("encrypts with age, shreds the plaintext, and keeps a constant-name artifact for 30 days", () => {
    expect(backup).toMatch(/apt-get install -y -qq --no-install-recommends age/);
    expect(backup).toMatch(
      /age -r "\$BETA_BACKUP_AGE_RECIPIENT" -o "\$RUNNER_TEMP\/beta-backup\.dump\.age" "\$RUNNER_TEMP\/beta-backup\.dump"/,
    );
    expect(backup).toMatch(/shred -u "\$RUNNER_TEMP\/beta-backup\.dump"\n/);
    expect(backup).toMatch(
      /uses: actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+name: beta-backup\n\s+path: \$\{\{ runner\.temp \}\}\/beta-backup\.dump\.age\n\s+if-no-files-found: error\n\s+retention-days: 30\n/,
    );
    expect(yamlCode(backup)).not.toMatch(/gzip|gunzip/);
    expect(backup).toMatch(/stat -c 'encrypted archive: %s bytes'/);
  });
});

describe("beta-restore-drill workflow", () => {
  it("pins checkout and setup-node to the SHAs ci.yml uses", () => {
    const pins = actionPins(drill);
    expect(Object.keys(pins).sort()).toEqual(["actions/checkout", "actions/setup-node"]);
    expect(pins["actions/checkout"]).toBe(actionPins(ci)["actions/checkout"]);
    expect(pins["actions/setup-node"]).toBe(actionPins(ci)["actions/setup-node"]);
    expect(drill).toMatch(/persist-credentials: false/);
  });

  it("runs monthly or by hand from the beta-backup environment with contents+actions read only", () => {
    expect(drill).toMatch(/^on:\n  schedule:\n    - cron: "23 4 1 \* \*"\n  workflow_dispatch:\n\n/m);
    expect(yamlCode(drill)).not.toMatch(/pull_request|^\s+push:/m);
    expect(drill).toMatch(/^permissions:\n  contents: read\n  actions: read\n\n/m);
    expect(drill).not.toMatch(/:\s*write\b/);
    expect(drill).toMatch(/^    environment: beta-backup$/m);
    expect(drill).toMatch(/^concurrency:\n  group: beta-restore-drill\n  cancel-in-progress: false$/m);
  });

  it("finds the newest successful backup on main, refuses one older than 48 h, downloads by constant name", () => {
    expect(drill).toMatch(
      /gh run list -R "\$GITHUB_REPOSITORY" -w beta-backup\.yml -s success -b main -L 1 --json databaseId,createdAt/,
    );
    expect(drill).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(drill).toMatch(/48 \* 3600/);
    expect(drill).toMatch(/gh run download -R "\$GITHUB_REPOSITORY" "\$RUN_ID" -n beta-backup/);
  });

  it("decrypts with a private identity file and replays only the pgcrypto shim before restoring", () => {
    expect(drill).toMatch(/umask 077\n\s+printf '%s\\n' "\$BETA_BACKUP_AGE_IDENTITY" > "\$RUNNER_TEMP\/age\.key"/);
    expect(drill).toMatch(/age -d -i "\$RUNNER_TEMP\/age\.key"/);
    expect(drill).toMatch(/shred -u "\$RUNNER_TEMP\/age\.key"/);
    expect(drill).toMatch(/create extension pgcrypto with schema extensions/);
    expect(drill).toMatch(/create role money_backup_login nologin/);
    expect(drill).toMatch(/-f deploy\/vercel\/setup-shim\.sql/);
    // A vanilla container has neither pg_cron nor pg_net: the extension half
    // of setup.sql (and the umbrella that includes it) must never run here.
    expect(drill).not.toMatch(/psql[^\n]*setup(-extensions)?\.sql/);
    expect(drill).toMatch(/select encode\(public\.digest\('x', 'sha256'\), 'hex'\)/);
  });

  it("restores with extension entries filtered and the first error fatal, then replays roles.sql", () => {
    expect(drill).toMatch(/pg_restore -l \/drill\/beta-backup\.dump > "\$RUNNER_TEMP\/all\.list"/);
    expect(drill).toMatch(/grep -v -E ' \(EXTENSION\|COMMENT - EXTENSION\) '/);
    expect(drill).toMatch(
      /pg_restore --exit-on-error --no-owner --no-privileges \\\n\s+-L \/drill\/filtered\.list -d "\$DRILL_DATABASE_URL" \/drill\/beta-backup\.dump/,
    );
    expect(drill).toMatch(/psql -v ON_ERROR_STOP=1 -d "\$DRILL_DATABASE_URL" -f db\/roles\.sql/);
  });

  it("reconciles, checks ledger_health and the schema head, and prints counts only", () => {
    expect(drill).toMatch(/DATABASE_URL: \$\{\{ env\.DRILL_DATABASE_URL \}\}\n\s+run: npm run db:reconcile/);
    expect(drill).toMatch(/select zero_sum and receipts_ok from money_private\.ledger_health\(\)/);
    expect(drill).toMatch(/test "\$health" = "t"/);
    expect(drill).toMatch(/ls db\/migrations \| tail -1 \| cut -c1-4/);
    expect(drill).toMatch(/select max\(version\) from money\.schema_migrations/);
    expect(drill).toMatch(/test "\$actual" = "\$expected"/);
    expect(drill).toMatch(/count\(\*\)/);
    expect(drill).toMatch(/information_schema\.tables t where t\.table_schema = 'money'/);
    expect(drill).not.toMatch(/select \* from money\./);
    expect(drill).not.toMatch(/from money\.beta_waitlist/);
  });

  it("runs the service and the client from one digest-pinned image, with the throwaway password outside the URL", () => {
    const pins = drill.match(IMAGE_PIN) ?? [];
    expect(pins).toHaveLength(2);
    expect(new Set(pins).size).toBe(1);
    expect(drill).toMatch(/^        image: postgres:17\.\d+-bookworm@sha256:[0-9a-f]{64}$/m);
    expect(drill).toMatch(/^      PG_IMAGE: postgres:17\.\d+-bookworm@sha256:[0-9a-f]{64}$/m);
    const servicePassword = drill.match(/POSTGRES_PASSWORD: (\S+)/)?.[1];
    const clientPassword = drill.match(/^      PGPASSWORD: (\S+)$/m)?.[1];
    expect(servicePassword).toBeDefined();
    expect(clientPassword).toBe(servicePassword);
    expect(drill).toMatch(/^      DRILL_DATABASE_URL: postgresql:\/\/postgres@127\.0\.0\.1:5432\/drill$/m);
    expect(drill).toMatch(/docker run --rm --network host/);
    expect(drill).toMatch(/-e PGPASSWORD/);
    expect(drill).toMatch(/docker pull --quiet "\$PG_IMAGE"/);
  });
});

describe("both beta workflows", () => {
  const workflows = [
    ["beta-backup.yml", backup],
    ["beta-restore-drill.yml", drill],
  ] as const;

  it("never carry a literal credential and never echo a secret", () => {
    for (const [name, text] of workflows) {
      for (const line of lines(text)) {
        expect(line, `${name}: ${line}`).not.toMatch(LITERAL_CREDENTIALS);
        if (!/\$\{?BETA_BACKUP_/.test(line)) continue;
        // A secret is only ever expanded into a private file under
        // $RUNNER_TEMP, into age's recipient argument, or inside the
        // single-quoted container command — never echoed or catted.
        expect(line, `${name}: ${line}`).not.toMatch(/\becho\b|\bcat\b/);
        if (/\bprintf\b/.test(line)) {
          expect(line, `${name}: ${line}`).toMatch(/> "\$RUNNER_TEMP\/[a-z.-]+"$/);
        }
      }
      expect(yamlCode(text), name).not.toMatch(/(echo|cat)[^\n]*(ca\.pem|age\.key|\.dump\b)/);
      expect(yamlCode(text), name).not.toMatch(/\bset -x\b/);
    }
  });

  it("share one postgres:17 digest for pg_dump, the drill server, and the drill client", () => {
    const pins = [...backup.matchAll(IMAGE_PIN), ...drill.matchAll(IMAGE_PIN)].map((match) => match[0]);
    expect(pins).toHaveLength(3);
    expect(new Set(pins).size).toBe(1);
    // ci.yml's service is postgres:18 (the VM profile); the beta pins 17 to
    // match Supabase, so the two must not be confused for each other.
    expect(pins[0]).not.toBe(ci.match(/postgres:\S+@sha256:[0-9a-f]{64}/)?.[0]);
  });

  it("are tab-free, trailing-space-free YAML with the top-level keys in the house order", () => {
    for (const [name, text] of workflows) {
      expect(text, name).not.toMatch(/\t/);
      expect(text, name).not.toMatch(/[ ]+\n/);
      expect(text, name).toMatch(/^name: beta-[a-z-]+\n\non:\n/m);
      expect(text, name).toMatch(/\n\npermissions:\n/);
      expect(text, name).toMatch(/\n\nconcurrency:\n/);
      expect(text, name).toMatch(/\n\njobs:\n/);
      expect(text.endsWith("\n"), name).toBe(true);
    }
  });
});

describe("deploy/vercel Supabase SQL", () => {
  it("setup.sql is split so the drill can replay the pgcrypto shim without pg_cron or pg_net", () => {
    expect(setup).toMatch(/^\\ir setup-extensions\.sql\n\\ir setup-shim\.sql\n$/m);
    for (const [name, text] of [["setup.sql", setup], ["setup-extensions.sql", setupExtensions], ["setup-shim.sql", setupShim]] as const) {
      expect(text, name).not.toMatch(/alter extension pgcrypto set schema/i);
      expect(sqlCode(text), name).not.toMatch(/alter extension/i);
    }
    expect(setupExtensions).toMatch(/^create extension if not exists pg_cron;$/m);
    expect(setupExtensions).toMatch(/^create extension if not exists pg_net with schema extensions;$/m);
    expect(setupExtensions).not.toMatch(/digest|gen_random_uuid/);
    expect(setupShim).not.toMatch(/pg_cron|pg_net/);
    for (const signature of ["public.digest(bytea,text)", "public.digest(text,text)", "public.gen_random_uuid()"]) {
      expect(setupShim).toContain(`if to_regprocedure('${signature}') is null`);
    }
    expect(setupShim).toMatch(/create function public\.digest\(bytea, text\) returns bytea/);
    expect(setupShim).toMatch(/create function public\.digest\(text, text\) returns bytea/);
    expect(setupShim).toMatch(/create function public\.gen_random_uuid\(\) returns uuid/);
    expect(setupShim.match(/set search_path = ''/g)).toHaveLength(3);
    expect(setupShim.match(/as 'select extensions\.digest\(\$1, \$2\)'/g)).toHaveLength(2);
    expect(setupShim).toContain("as 'select pg_catalog.gen_random_uuid()'");
  });

  it("logins.sql takes every password from psql variables, echoes nothing, and never uses pg_read_all_data", () => {
    expect(logins).not.toMatch(/pg_read_all_data/i);
    expect(sqlCode(logins)).not.toMatch(/pg_read_all_|pg_write_all_|superuser|bypassrls/i);
    // psql meta-commands are only recognised at the start of a line; the
    // comments may say "no \echo" without tripping this.
    expect(logins).not.toMatch(/^\s*\\echo/m);
    expect(logins).not.toMatch(/password\s+'/i);
    const passwords = [...logins.matchAll(/^alter role (\w+) with login password :'(\w+)';$/gm)]
      .map((match) => [match[1], match[2]]);
    expect(passwords).toEqual([
      ["money_app_login", "app_pw"],
      ["money_worker_login", "worker_pw"],
      ["money_card_ingress_login", "ingress_pw"],
      ["money_ops_login", "ops_pw"],
      ["money_metrics_login", "metrics_pw"],
      ["money_backup_login", "backup_pw"],
    ]);
    for (const [login] of passwords) {
      expect(logins).toContain(`if not exists (select 1 from pg_roles where rolname = '${login}') then\n    create role ${login} login;`);
    }
    expect(logins).toContain("<login>.<project-ref>");
  });

  it("logins.sql binds each login to one authority role and caps it at the role level", () => {
    for (const [authority, login] of [
      ["money_app", "money_app_login"],
      ["money_worker", "money_worker_login"],
      ["money_card_ingress", "money_card_ingress_login"],
      ["money_ops", "money_ops_login"],
      ["money_metrics", "money_metrics_login"],
    ]) {
      expect(logins).toContain(`grant ${authority} to ${login};`);
    }
    expect(logins).not.toMatch(/grant \w+ to money_backup_login;/);
    for (const [login, timeout, limit] of [
      ["money_app_login", "5s", 20],
      ["money_worker_login", "30s", 6],
      ["money_card_ingress_login", "2s", 6],
      ["money_ops_login", "50s", 2],
      ["money_metrics_login", "10s", 4],
    ] as const) {
      expect(logins).toContain(`alter role ${login} set statement_timeout = '${timeout}';`);
      expect(logins).toContain(`alter role ${login} connection limit ${limit};`);
    }
    expect(logins).toContain("alter role money_backup_login connection limit 2;");
    expect(logins).not.toMatch(/alter role money_backup_login set statement_timeout/);
  });

  it("logins.sql scopes the backup login to money/money_private; data-api.sql closes the Data API defaults", () => {
    expect(logins).toContain("grant usage on schema money, money_private to money_backup_login;");
    expect(logins).toContain("grant select on all tables in schema money to money_backup_login;");
    expect(logins).toContain("grant select on all sequences in schema money to money_backup_login;");
    expect(logins).toMatch(/alter default privileges for role current_user in schema money\n\s+grant select on tables to money_backup_login;/);
    expect(logins).toMatch(/alter default privileges for role current_user in schema money\n\s+grant select on sequences to money_backup_login;/);
    expect(logins).not.toMatch(/grant [^\n]*(cron|vault|auth|net)\./);
    // The dump's --enable-row-security counterpart: one policy, one role.
    expect(logins).toMatch(
      /create policy beta_waitlist_backup_read on money\.beta_waitlist\n\s+for select to money_backup_login using \(true\);/,
    );
    expect(logins.match(/create policy/g)).toHaveLength(1);
    // Altering postgres's own default privileges needs postgres, so the hardening
    // is its own file; logins.sql runs as the migrating identity (money_owner live).
    expect(sqlCode(logins)).not.toMatch(/for role postgres|\banon\b/);
    expect(dataApi).toContain("if exists (select 1 from pg_roles where rolname = 'anon') then");
    for (const hardening of [
      "revoke all on tables from anon, authenticated, service_role;",
      "revoke execute on functions from anon, authenticated, service_role;",
      "revoke all on all tables in schema public from anon, authenticated, service_role;",
      "revoke all on all functions in schema public from anon, authenticated, service_role;",
      "revoke usage on schema money, money_private from anon, authenticated, service_role;",
    ]) {
      expect(dataApi).toContain(hardening);
    }
  });

  it("schedule.sql keeps the sweep key in Vault, reads it at execution time, and waits out cold starts", () => {
    expect(schedule).not.toMatch(/^\s*\\echo/m);
    expect(schedule).toContain("select vault.create_secret(:'sweep_key', 'money_sweep_key')");
    expect(schedule).toContain("where not exists (select 1 from vault.secrets where name = 'money_sweep_key');");
    expect(schedule).toContain("vault.decrypted_secrets");
    expect(schedule).toContain("timeout_milliseconds := 55000");
    // The header value is a subselect, never a literal, so cron.job and the
    // function body hold no key material.
    expect(schedule).not.toMatch(/'x-sweep-key',\s*'/);
    expect(schedule).toMatch(/'x-sweep-key', \(select d\.decrypted_secret\n\s+from vault\.decrypted_secrets d\n\s+where d\.name = 'money_sweep_key'\)/);
    expect(schedule).toMatch(/create or replace function beta_cron\.call_internal\(path text\) returns bigint\nlanguage sql\nsecurity definer\nset search_path = ''/);
    expect(schedule).toContain("revoke all on function beta_cron.call_internal(text) from public;");
    expect(schedule).toContain("select cron.schedule('money-sweep', '*/5 * * * *',\n  $$select beta_cron.call_internal('sweep')$$);");
    expect(schedule).toContain("select cron.schedule('money-ledger-health', '7 * * * *',\n  $$select beta_cron.call_internal('ledger-health')$$);");
    expect(schedule).toContain("select cron.schedule('money-cron-gc', '23 4 * * 0',\n  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);");
    expect(schedule).toContain("insert into beta_cron.settings (key, value) values ('origin', :'beta_origin')");
    expect(schedule).toMatch(/v_origin !~ '\^https:\/\/\[a-z0-9\.-\]\+\$'/);
  });

  it("verify.sql asserts the role matrix, the Vault key, the cron jobs, and the migration head", () => {
    for (const check of [
      "encode(public.digest('x', 'sha256'), 'hex') is not null",
      "has_table_privilege('anon', 'money.beta_waitlist', 'select') = false",
      "has_function_privilege('anon', 'money_private.join_waitlist(text,text)', 'execute') = false",
      "has_schema_privilege('anon', 'money', 'usage') = false",
      "has_schema_privilege('anon', 'public', 'usage')",
      "not (has_schema_privilege('money_backup_login', 'cron', 'usage')",
      "has_table_privilege('money_backup_login', 'vault.decrypted_secrets', 'select') = false",
      "has_function_privilege('money_app', 'money_private.join_waitlist(text,text)', 'execute')",
      "has_function_privilege('money_worker', 'money_private.sweep_external_payments(integer)', 'execute')",
      "has_function_privilege('money_ops', 'money_private.record_ledger_health()', 'execute')",
      "has_function_privilege('money_metrics', 'money_private.public_metrics()', 'execute')",
      "(select count(*) from cron.job where jobname like 'money-%') = 3",
      "policyname = 'beta_waitlist_backup_read'",
      "pg_has_role('money_backup_login', 'pg_read_all_data', 'member') = false",
      "from money_private.ledger_health() h",
      "(select zero_sum from health)",
      "(select receipts_ok from health)",
    ]) {
      expect(verify).toContain(check);
    }
    expect(verify).toContain("(select max(version) from money.schema_migrations) = '0014'");
    // Lockstep once the migration set moves past the spec's head: verify.sql
    // must be bumped with every new migration.
    const head = readdirSync(resolve(ROOT, "db/migrations"))
      .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name))
      .sort()
      .at(-1)!
      .slice(0, 4);
    if (head >= "0014") {
      expect(verify).toContain(`(select max(version) from money.schema_migrations) = '${head}'`);
    }
    expect(verify).not.toMatch(/\bselect \*/);
    expect(verify).not.toMatch(/^\s*\\echo/m);
  });
});
