import http from "node:http";
import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { resolve } from "node:path";

const bridgeInfo = execFileSync("/sbin/ifconfig", ["bridge100"], { encoding: "utf8" });
const listenHost = /\binet (192\.168\.\d{1,3}\.\d{1,3})\b/u.exec(bridgeInfo)?.[1] ?? "";
if (!/^192\.168\.\d{1,3}\.\d{1,3}$/u.test(listenHost)) {
  throw new Error("OrbStack bridge address unavailable");
}
const listenPort = 9697;
const upstreamHost = "127.0.0.1";
const upstreamPort = 9696;
const tokenPath = process.env.PT_PROWLARR_PROXY_TOKEN_FILE;
if (!tokenPath?.startsWith("/")) throw new Error("Proxy token file unavailable");
const proxyToken = readFileSync(tokenPath, "utf8").trim();
if (proxyToken.length < 32) throw new Error("Proxy token unavailable");
const nasPath = process.env.PT_MEDIA_NAS_PATH;
const nasStatusFile = process.env.PT_MEDIA_NAS_STATUS_FILE;
const nasSentinelName = process.env.PT_MEDIA_NAS_SENTINEL_NAME ?? ".pt-media-assistant-mounted";
if (!nasPath?.startsWith("/") || !nasStatusFile?.startsWith("/")) {
  throw new Error("NAS monitor configuration unavailable");
}
if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u.test(nasSentinelName)) {
  throw new Error("NAS sentinel configuration unavailable");
}
const nasSentinelPath = resolve(nasPath, nasSentinelName);

function toNonNegativeBigInt(value) {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value));
}

function toJsonSafeNumber(value) {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > maximum ? maximum : value);
}

async function refreshNasStatus() {
  const snapshot = {
    ready: false,
    updatedAt: Date.now(),
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
  };
  try {
    const [directory, sentinel, stats] = await Promise.all([
      fs.stat(nasPath),
      fs.stat(nasSentinelPath),
      fs.statfs(nasPath, { bigint: true }),
    ]);
    if (directory.isDirectory() && sentinel.isFile()) {
      const blockSize = toNonNegativeBigInt(stats.bsize);
      const total = blockSize * toNonNegativeBigInt(stats.blocks);
      const physicallyFree = blockSize * toNonNegativeBigInt(stats.bfree);
      const available = blockSize * toNonNegativeBigInt(stats.bavail);
      snapshot.ready = true;
      snapshot.totalBytes = toJsonSafeNumber(total);
      snapshot.usedBytes = toJsonSafeNumber(total > physicallyFree ? total - physicallyFree : 0n);
      snapshot.freeBytes = toJsonSafeNumber(available);
    }
  } catch {
    // A disconnected share produces a fresh, explicit not-ready snapshot.
  }
  await fs.writeFile(nasStatusFile, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o644 });
}

function hasValidToken(value) {
  if (typeof value !== "string") return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(proxyToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isAllowedRequest(method, rawUrl) {
  if (!rawUrl) return false;
  const path = new URL(rawUrl, "http://proxy.invalid").pathname;
  if (method === "GET") return path === "/api/v1/system/status" || path === "/api/v1/search";
  return method === "POST" && path === "/api/v1/search";
}

const server = http.createServer((request, response) => {
  if (
    !request.headers["x-api-key"]
    || !hasValidToken(request.headers["x-pt-proxy-token"])
    || !isAllowedRequest(request.method, request.url)
  ) {
    response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Not found");
    return;
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(contentLength) || contentLength > 1024 * 1024) {
    response.writeHead(413, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Request too large");
    return;
  }

  const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}` };
  delete headers["x-pt-proxy-token"];
  const upstream = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  const closeBoth = () => {
    request.destroy();
    upstream.destroy();
  };
  request.on("error", closeBoth);
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "Cache-Control": "no-store" });
    response.end();
  });
  request.pipe(upstream);
});

server.on("error", () => {
  process.stderr.write("Prowlarr loopback proxy failed\n");
  process.exitCode = 1;
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write("Prowlarr loopback proxy ready\n");
});

await refreshNasStatus();
const statusTimer = setInterval(() => {
  void refreshNasStatus().catch(() => process.exit(1));
}, 10_000);

const close = () => {
  clearInterval(statusTimer);
  server.close(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
