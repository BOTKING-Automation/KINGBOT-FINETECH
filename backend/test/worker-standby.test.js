import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerEntry = path.join(backendDir, "src", "worker-web.js");

function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: backendDir,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000
  });
}

test("WORKER_STANDBY prevents the execution loop even when DATABASE_URL exists", () => {
  const child = runNode(
    ["--input-type=module", "-e", 'import { startWorker } from "./src/worker.js"; await startWorker();'],
    {
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      WORKER_STANDBY: "1"
    }
  );

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /standby mode: execution loop disabled/);
  assert.doesNotMatch(child.stdout, /execution loop started/);
});

test("dedicated worker web entrypoint refuses standby mode", () => {
  const child = runNode([workerEntry], {
    WORKER_STANDBY: "1",
    PORT: "19091"
  });

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /refusing to start dedicated execution service in standby mode/);
  assert.doesNotMatch(child.stdout, /listening/);
});
