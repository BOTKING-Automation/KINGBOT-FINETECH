import { createServer } from "node:http";

const standby = String(process.env.WORKER_STANDBY || "").trim() === "1";
if (standby) {
  console.error("[KINGBOT WORKER] refusing to start dedicated execution service in standby mode");
  process.exit(1);
}

const port = Number.parseInt(process.env.PORT || "10000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("KINGBOT_WORKER_PORT_INVALID");
}

let ready = false;
let startupError = null;
const server = createServer((request, response) => {
  let pathname = "/";
  try {
    pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  } catch {
    pathname = "/";
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
    const healthy = ready && !startupError;
    const body = JSON.stringify({
      ok: healthy,
      service: "KINGBOT execution worker",
      role: "execution",
      state: startupError ? "FAILED" : healthy ? "RUNNING" : "STARTING",
      error: startupError
    });
    response.writeHead(healthy ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
    return;
  }

  const body = JSON.stringify({ ok: false, error: "NOT_FOUND" });
  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
});

server.listen(port, "0.0.0.0", async () => {
  console.log("[KINGBOT WORKER HEALTH] listening", JSON.stringify({ host: "0.0.0.0", port }));
  try {
    const { startWorker } = await import("./worker.js");
    await startWorker();
    ready = true;
    console.log("[KINGBOT WORKER HEALTH] execution worker ready");
  } catch (error) {
    startupError = String(error?.message || "WORKER_STARTUP_FAILED").slice(0, 180);
    console.error("[KINGBOT WORKER] startup failed", startupError);
    server.close(() => process.exit(1));
  }
});

server.on("error", error => {
  console.error("[KINGBOT WORKER HEALTH] server error", String(error?.message || error));
  process.exit(1);
});
