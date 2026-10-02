import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const launcher = readFileSync(new URL("scripts/start-standalone.js", root), "utf8");
for (const hasWrapper of [false, true]) {
  const loaded = [];
  vm.runInNewContext(launcher, {
    process: { cwd: () => "/repo" },
    require: (name) => {
      if (name === "path") return path;
      if (name === "fs") return {
        existsSync: (file) => !file.endsWith("custom-server.js") || hasWrapper,
        mkdirSync() {},
        cpSync() {},
      };
      loaded.push(path.basename(name));
    },
  });
  assert.deepEqual(loaded, hasWrapper ? ["custom-server.js", "server.js"] : ["server.js"]);
}

const source = readFileSync(new URL("src/lib/usage/connectionUsage.js", root), "utf8");
const start = source.indexOf("export async function refreshAndUpdateCredentials");
const end = source.indexOf("export async function fetchUsageForConnection");
assert.ok(start >= 0 && end > start);
const latest = { id: "c1", provider: "codex", accessToken: "current", refreshToken: "rotated" };
const writes = [];
let result = { accessToken: "new", refreshToken: "next" };
const refresh = new Function(
  "getProviderConnectionById", "updateProviderConnection", "getExecutor", "isUnrecoverableRefreshError",
  `${source.slice(start, end).replace("export ", "")}; return refreshAndUpdateCredentials;`,
)(
  async () => latest,
  async (...args) => writes.push(args),
  () => ({
    needsRefresh: () => true,
    refreshCredentials: async (credentials) => {
      assert.equal(credentials.refreshToken, "rotated");
      return result;
    },
  }),
  (value) => value.error === "refresh_token_reused",
);

const updated = await refresh({ ...latest, refreshToken: "stale" });
assert.equal(updated.connection.refreshToken, "next");
assert.equal(writes.length, 1);
result = { error: "refresh_token_reused" };
await assert.rejects(refresh(latest), /re-authorize/);
assert.equal(writes.length, 1);
result = null;
assert.equal((await refresh(latest)).connection.accessToken, "current");
console.log("Production launcher + quota credential refresh checks passed");
