import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const previousState = global._dbAdapter;
afterEach(() => {
  global._dbAdapter = previousState;
  vi.resetModules();
});

it.each(["better-sqlite3", "node:sqlite", "bun:sqlite"])(
  "read-only connections reuse the %s writer library",
  async (driver) => {
    vi.resetModules();
    const constructor = vi.fn(function () { this.close = vi.fn(); });
    global._dbAdapter = { instance: { driver, raw: { constructor } } };
    const { openReadOnlyDatabase } = await import("../../src/lib/db/driver.js");
    const reader = await openReadOnlyDatabase("/tmp/example.sqlite");
    expect(reader).toBeInstanceOf(constructor);
    expect(constructor).toHaveBeenCalledWith("/tmp/example.sqlite", driver === "node:sqlite"
      ? { readOnly: true } : { readonly: true, fileMustExist: true });
  },
);

it("refuses file reads with an in-memory SQL.js adapter", async () => {
  vi.resetModules();
  global._dbAdapter = { instance: { driver: "sql.js", raw: {} } };
  const { openReadOnlyDatabase } = await import("../../src/lib/db/driver.js");
  await expect(openReadOnlyDatabase("/tmp/example.sqlite")).rejects.toThrow("native SQLite");
});

it("report and shared config cannot open a second SQLite library", () => {
  for (const file of ["telegram/reportUsage.js", "apiKeys/sharedConfig.js"]) {
    const source = readFileSync(new URL("../../src/lib/" + file, import.meta.url), "utf8");
    expect(source).toContain("await openReadOnlyDatabase(");
    expect(source).not.toContain('import("node:sqlite")');
    expect(source).not.toContain("new DatabaseSync(");
  }
});

it("closing a report reader preserves the active writer's WAL lock", async () => {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const root = mkdtempSync(path.join(os.tmpdir(), "9router-reader-lock-"));
  const file = path.join(root, "test.sqlite");
  const raw = new Database(file);
  let reader;
  try {
    raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE test(value INTEGER); BEGIN IMMEDIATE");
    vi.resetModules();
    global._dbAdapter = { instance: { driver: "better-sqlite3", raw } };
    const { openReadOnlyDatabase } = await import("../../src/lib/db/driver.js");
    reader = await openReadOnlyDatabase(file);
    reader.prepare("SELECT * FROM test").all();
    reader.close();
    reader = null;
    const probe = spawnSync(process.execPath, ["-e", `
      const D = require(${JSON.stringify(require.resolve("better-sqlite3"))});
      const db = new D(${JSON.stringify(file)}, {timeout: 100});
      try { db.exec("INSERT INTO test VALUES(1)"); console.log("UNLOCKED"); }
      catch (e) { console.log(e.code); }
      finally { db.close(); }
    `], { encoding: "utf8", timeout: 5000 });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("SQLITE_BUSY");
  } finally {
    reader?.close();
    raw.exec("ROLLBACK");
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});
