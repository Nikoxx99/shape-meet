import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const hostEmail = "admin@shape.test";
const hostPassword = "RemoteCheck123!";
const hostToken = "remote-check-host-token";
const meetings = new Map();
const identities = new Map();
const identityArtifactBytes = Buffer.from("shape-meet-identity-artifact-smoke");
const identityArtifactSha256 = createHash("sha256")
  .update(identityArtifactBytes)
  .digest("hex");
let livekitUrlForToken = null;
let adminBaseUrl = null;

try {
  const admin = await listenHttp(async (request, response) => {
    try {
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

      if (request.method === "POST" && request.url === "/api/auth/host/login") {
        const body = await readJson(request);
        if (body.identifier !== hostEmail || body.password !== hostPassword) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Credenciales inválidas." }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            session: {
              token: hostToken,
              user: {
                id: "host_remote_check",
                email: hostEmail,
                username: "Host Remote Check",
                rank: "ADMIN",
              },
            },
          }),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/meetings") {
        if (!hasBearer(request, hostToken)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Sesión inválida." }));
          return;
        }

        const body = await readJson(request);
        const code = "SM-555-121";
        const meeting = {
          id: "meeting_remote_check",
          title: body.title,
          code,
          startsAt: body.startsAt,
          status: "SCHEDULED",
          maxParticipants: body.maxParticipants,
          participants: [],
        };
        meetings.set(code, meeting);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ meeting }));
        return;
      }

      if (
        request.method === "POST" &&
        request.url === "/api/admin/identities"
      ) {
        if (!hasBearer(request, hostToken)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Sesión inválida." }));
          return;
        }

        await drain(request);
        const identity = {
          id: "identity_remote_check",
          userId: "host_remote_check",
          name: "Remote identity check",
          kind: "PHOTO_IDENTITY",
          status: "AVAILABLE",
          version: "check",
          artifactUri:
            "shape-artifact://local/remote-check/shape-identity-check.bin",
          artifactSha256: identityArtifactSha256,
          artifactSizeBytes: identityArtifactBytes.byteLength,
          deliveryStatus: "READY",
          ownerName: "Host Remote Check",
          ownerEmail: hostEmail,
        };
        identities.set(identity.id, identity);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ identity }));
        return;
      }

      const identityDeliveryMatch = request.url?.match(
        /^\/api\/admin\/identities\/([^/]+)\/delivery$/,
      );
      if (request.method === "PATCH" && identityDeliveryMatch) {
        if (!hasBearer(request, hostToken)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Sesión inválida." }));
          return;
        }

        const identity = identities.get(
          decodeURIComponent(identityDeliveryMatch[1]),
        );
        if (!identity) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Rostro no encontrado." }));
          return;
        }

        identity.deliveryStatus = "PUSHED";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ identity }));
        return;
      }

      const identityStatusMatch = request.url?.match(
        /^\/api\/admin\/identities\/([^/]+)\/status$/,
      );
      if (request.method === "PATCH" && identityStatusMatch) {
        if (!hasBearer(request, hostToken)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Sesión inválida." }));
          return;
        }

        const identity = identities.get(
          decodeURIComponent(identityStatusMatch[1]),
        );
        if (identity) identity.status = "REVOKED";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ identity }));
        return;
      }

      if (request.method === "GET" && request.url === "/api/host/identities") {
        if (!hasBearer(request, hostToken)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Sesión inválida." }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            identities: Array.from(identities.values()).filter(
              (identity) =>
                identity.status === "AVAILABLE" &&
                identity.deliveryStatus === "PUSHED",
            ),
          }),
        );
        return;
      }

      const identityArtifactMatch = request.url?.match(
        /^\/api\/host\/identities\/([^/]+)\/artifact$/,
      );
      if (request.method === "GET" && identityArtifactMatch) {
        if (!hasBearer(request, hostToken)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Sesión inválida." }));
          return;
        }

        const identity = identities.get(
          decodeURIComponent(identityArtifactMatch[1]),
        );
        if (!identity) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Artefacto no encontrado." }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            artifact: {
              ...identity,
              downloadUrl: `${adminBaseUrl}/api/host/identities/${encodeURIComponent(identity.id)}/artifact/download?token=remote-check`,
            },
          }),
        );
        return;
      }

      const identityArtifactDownloadMatch = request.url?.match(
        /^\/api\/host\/identities\/([^/]+)\/artifact\/download/,
      );
      if (request.method === "GET" && identityArtifactDownloadMatch) {
        const identity = identities.get(
          decodeURIComponent(identityArtifactDownloadMatch[1]),
        );
        if (!identity) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Artefacto no encontrado." }));
          return;
        }

        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(identityArtifactBytes.byteLength),
          "x-shape-artifact-sha256": identityArtifactSha256,
          "x-shape-artifact-size": String(identityArtifactBytes.byteLength),
        });
        response.end(identityArtifactBytes);
        return;
      }

      const joinMatch = request.url?.match(
        /^\/api\/meetings\/([^/]+)\/join-token$/,
      );
      if (request.method === "POST" && joinMatch) {
        if (!hasBearer(request, hostToken)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Sesión inválida." }));
          return;
        }

        const code = decodeURIComponent(joinMatch[1]);
        const meeting = meetings.get(code);
        if (!meeting) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Reunión no encontrada." }));
          return;
        }

        meeting.status = "LIVE";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            meeting,
            livekit: {
              url: livekitUrlForToken,
              token: "livekit.jwt.remote.check",
              room: code,
              identity: "participant_remote_check",
            },
          }),
        );
        return;
      }

      const endMatch = request.url?.match(/^\/api\/meetings\/([^/]+)\/end$/);
      if (request.method === "POST" && endMatch) {
        if (!hasBearer(request, hostToken)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Sesión inválida." }));
          return;
        }

        const code = decodeURIComponent(endMatch[1]);
        const meeting = meetings.get(code);
        if (meeting) meeting.status = "ENDED";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ meeting }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end("ok");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  adminBaseUrl = `http://127.0.0.1:${admin.port}`;
  const livekit = await listenHttp((_request, response) => {
    response.writeHead(200);
    response.end("livekit");
  });
  livekitUrlForToken = `ws://127.0.0.1:${livekit.port}`;
  const rtcTcp = await listenTcp();
  const turnTcp = await listenTcp();
  const turnTls = await listenTcp();
  const turnUdp = await listenStunUdp(turnTcp.port);
  const envPath = join(tempDir, "remote.env");
  const reportPath = join(tempDir, "remote-report.json");

  writeFileSync(
    envPath,
    [
      `NEXT_PUBLIC_APP_URL=${adminBaseUrl}`,
      `VITE_SHAPE_API_URL=${adminBaseUrl}`,
      `LIVEKIT_URL=ws://127.0.0.1:${livekit.port}`,
      "LIVEKIT_TURN_DOMAIN=127.0.0.1",
      "LIVEKIT_TURN_SHARED_SECRET=remote-check-secret",
      "LIVEKIT_TURN_TTL_SECONDS=14400",
      `HOST_BOOTSTRAP_EMAIL=${hostEmail}`,
      `HOST_BOOTSTRAP_PASSWORD=${hostPassword}`,
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
  assertCheck(report, "api.host-login", "ok");
  assertCheck(report, "api.meeting-create", "ok");
  assertCheck(report, "api.livekit-token", "ok");
  assertCheck(report, "api.meeting-end", "ok");
  assertCheck(report, "api.identity-admin-login", "ok");
  assertCheck(report, "api.identity-host-login", "ok");
  assertCheck(report, "api.identity-create", "ok");
  assertCheck(report, "api.identity-push", "ok");
  assertCheck(report, "api.identity-host-list", "ok");
  assertCheck(report, "api.identity-artifact-resolve", "ok");
  assertCheck(report, "api.identity-artifact-download", "ok");

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
    "--api-flow",
    "--identity-flow",
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

function drain(request) {
  return new Promise((resolve, reject) => {
    request.on("data", () => undefined);
    request.on("error", reject);
    request.on("end", resolve);
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function hasBearer(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
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
