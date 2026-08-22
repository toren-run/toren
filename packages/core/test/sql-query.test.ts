import { afterAll, beforeAll, expect, test } from "vitest";
import { createPool } from "../src/db.js";
import { BUILTIN_TOOLS, BUILTIN_TOOL_ENV } from "../src/builtins.js";

const pool = createPool();
// The tool reads SQL_DATABASE_URL from ctx.env; point it at the test Postgres.
const URL = process.env.DATABASE_URL ?? "postgres://toren:toren@localhost:5433/toren";
const ctx = { runId: "r", taskId: "t", toolUseId: "tu", env: { SQL_DATABASE_URL: URL } };
const sql = BUILTIN_TOOLS.sql_query!;

beforeAll(async () => {
  await pool.query("CREATE SCHEMA IF NOT EXISTS sqltest");
  await pool.query("CREATE TABLE IF NOT EXISTS sqltest.widgets (id int, name text, price int)");
  await pool.query("TRUNCATE sqltest.widgets");
  await pool.query("INSERT INTO sqltest.widgets VALUES (1,'bolt',10),(2,'nut',5),(3,'gear',50)");
});
afterAll(async () => { await pool.query("DROP SCHEMA IF EXISTS sqltest CASCADE"); await pool.end(); });

test("declares its required env", () => {
  expect(BUILTIN_TOOL_ENV.sql_query).toEqual(["SQL_DATABASE_URL"]);
});

test("runs a read-only SELECT and returns rows", async () => {
  const r = JSON.parse(await sql.handler({ query: "SELECT name, price FROM sqltest.widgets ORDER BY price DESC", limit: 100 }, ctx));
  expect(r.rowCount).toBe(3);
  expect(r.rows[0]).toEqual({ name: "gear", price: 50 });
});

test("caps rows even without a LIMIT in the query", async () => {
  const r = JSON.parse(await sql.handler({ query: "SELECT * FROM sqltest.widgets", limit: 2 }, ctx));
  expect(r.rows.length).toBe(2);
  expect(r.truncated).toBe(true);
});

test("refuses writes and DDL even on a read-write connection", async () => {
  for (const q of [
    "DELETE FROM sqltest.widgets",
    "UPDATE sqltest.widgets SET price = 0",
    "DROP TABLE sqltest.widgets",
    "INSERT INTO sqltest.widgets VALUES (9,'x',9)",
    "SELECT 1; DROP TABLE sqltest.widgets",
    "TRUNCATE sqltest.widgets",
  ]) {
    const r = JSON.parse(await sql.handler({ query: q, limit: 100 }, ctx));
    expect(r.error, q).toBeTruthy();
  }
  // The data is intact: nothing got through.
  const check = JSON.parse(await sql.handler({ query: "SELECT count(*)::int AS n FROM sqltest.widgets", limit: 1 }, ctx));
  expect(check.rows[0].n).toBe(3);
});

test("allows a WITH ... SELECT CTE", async () => {
  const r = JSON.parse(await sql.handler({ query: "WITH cheap AS (SELECT * FROM sqltest.widgets WHERE price < 20) SELECT name FROM cheap ORDER BY name", limit: 100 }, ctx));
  expect(r.rows.map((x: { name: string }) => x.name)).toEqual(["bolt", "nut"]);
});

test("missing SQL_DATABASE_URL is a clear error", async () => {
  await expect(sql.handler({ query: "SELECT 1", limit: 1 }, { runId: "r", taskId: "t", toolUseId: "tu", env: {} })).rejects.toThrow(/SQL_DATABASE_URL/);
});
