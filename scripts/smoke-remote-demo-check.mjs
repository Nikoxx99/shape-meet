import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createSocket } from "node:dgram";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-remote-demo-check-"));
const servers = [];
let adminLivekitHealth = {
  status: "ok",
  urlConfigured: true,
  credentialsConfigured: true,
};

try {
  const admin = await listenHttp((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          database: "ok",
          livekit: adminLivekitHealth,
        }),
      );
      return;
    }
    response.writeHead(200);
    response.end("ok");
  });
  const livekit = await listenHttp((_request, response) => {
    response.writeHead(200);
    response.end("livekit");
  });
  const rtcTcp = await listenTcp();
  const turnTcp = await listenTcp();
  const turnTls = await listenTcp();
  const turnUdp = await listenStunUdp(turnTcp.port);
  const envPath = join(tempDir, "remote.env");
  const reportPath = join(tempDir, "remote-report.json");

  writeFileSync(
    envPath,
    [
      `NEXT_PUBLIC_APP_URL=http://127.0.0.1:${admin.port}`,
      `VITE_SHAPE_API_URL=http://127.0.0.1:${admin.port}`,
      `LIVEKIT_URL=ws://127.0.0.1:${livekit.port}`,
      "LIVEKIT_TURN_DOMAIN=127.0.0.1",
      "LIVEKIT_TURN_SHARED_SECRET=remote-check-secret",
      "LIVEKIT_TURN_TTL_SECONDS=14400",
      `LIVEKIT_RTC_TCP_PORT=${rtcTcp.port}`,
      `LIVEKIT_TURN_UDP_PORT=${turnUdp.port}`,
      `LIVEKIT_TURN_TLS_PORT=${turnTls.port}`,
      "",
    ].join("\n"),
  );

  const result = await runRemoteCheck(envPath, reportPath);

  if (result.code !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`remote demo check smoke failed with ${result.code}`);
  }

  const report = JSON.parse(result.stdout);
  assert(report.status === "passed", `expected passed, got ${report.status}`);
  assert(existsSync(reportPath), "expected output report to be written");
  const outputReport = JSON.parse(readFileSync(reportPath, "utf8"));
  assert(outputReport.status === "passed", "expected output report passed");
  assertCheck(outputReport, "report.output", "ok");
  assertCheck(report, "network.admin-health", "ok");
  assertCheck(report, "network.admin-livekit-config", "ok");
  assertCheck(report, "network.livekit-http", "ok");
  assertCheck(report, "network.livekit-rtc-tcp", "ok");
  assertCheck(report, "network.turn-tcp", "ok");
  assertCheck(report, "network.turn-tls-tcp", "ok");
  assertCheck(report, "network.turn-stun-udp", "ok");
  assertCheck(report, "network.turn-auth", "skipped");

  adminLivekitHealth = {
    status: "unconfigured",
    urlConfigured: false,
    credentialsConfigured: true,
  };
  const failedResult = await runRemoteCheck(envPath);
  assert(
    failedResult.code !== 0,
    "remote demo check should fail when admin LiveKit config is missing",
  );
  const failedReport = JSON.parse(failedResult.stdout);
  assert(failedReport.status === "failed", "expected failed report");
  assertCheck(failedReport, "network.admin-livekit-config", "failed");

  console.log("remote demo check smoke ok");
} finally {
  await Promise.all(servers.map((server) => closeServer(server)));
  rmSync(tempDir, { recursive: true, force: true });
}

function runRemoteCheck(envPath, outputPath = null) {
  const outputArgs = outputPath ? ["--output", outputPath] : [];
  return runNode([
    "scripts/check-remote-demo.mjs",
    "--env-file",
    envPath,
    "--strict",
    "--skip-turnutils",
    "--timeout-ms",
    "2000",
    ...outputArgs,
    "--json",
  ]);
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function listenHttp(handler) {
  const server = createHttpServer(handler);
  return listenServer(server);
}

function listenTcp() {
  const server = createTcpServer((socket) => socket.end());
  return listenServer(server);
}

function listenServer(server) {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

function listenStunUdp(port) {
  const socket = createSocket("udp4");
  servers.push(socket);

  socket.on("message", (message, remote) => {
    if (message.length < 20) return;
    const response = Buffer.alloc(20);
    response.writeUInt16BE(0x0101, 0);
    response.writeUInt16BE(0, 2);
    response.writeUInt32BE(0x2112a442, 4);
    message.copy(response, 8, 8, 20);
    socket.send(response, remote.port, remote.address);
  });

  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => {
      const address = socket.address();
      resolve({ server: socket, port: address.port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.close === "function") {
      server.close(() => resolve());
      return;
    }
    resolve();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertCheck(report, id, status) {
  assert(
    report.checks?.some((check) => check.id === id && check.status === status),
    `missing ${status} check ${id}`,
  );
}
