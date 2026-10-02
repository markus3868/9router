#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const projectRoot = process.cwd();
const standaloneRoot = path.join(projectRoot, ".next", "standalone");
const customServer = path.join(standaloneRoot, "custom-server.js");
const standaloneServer = path.join(standaloneRoot, "server.js");
const staticSource = path.join(projectRoot, ".next", "static");
const staticTarget = path.join(standaloneRoot, ".next", "static");
const publicSource = path.join(projectRoot, "public");
const publicTarget = path.join(standaloneRoot, "public");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function syncDir(source, target) {
  if (!fs.existsSync(source)) return;
  ensureDir(path.dirname(target));
  fs.cpSync(source, target, { recursive: true, force: true });
}

if (!fs.existsSync(standaloneServer)) {
  console.error(
    "[9router] Missing .next/standalone/server.js. Run `npm run build` before `npm start`."
  );
  process.exit(1);
}

syncDir(staticSource, staticTarget);
syncDir(publicSource, publicTarget);

if (fs.existsSync(customServer)) require(customServer);
require(standaloneServer);
