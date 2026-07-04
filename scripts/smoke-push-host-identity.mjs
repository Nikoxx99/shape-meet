import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "shape-identity-push-"));
const artifactPath = join(tempDir, "identity-smoke.bin");
const envPath = join(tempDir, "remote.env");
const artifactPayload = "shape-identity-push-smoke";
const artifactBytes = Buffer.from(artifactPayload);
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
const users = [
  {
    id: "admin_identity_push",
    email: "admin@shape.test",
    username: "admin",
    rank: "ADMIN",
    status: "ACTIVE",
  },
  {
    id: "host_identity_push",
    email: "host@shape.test",
    username: "host",
    rank: "HOST",
    status: "ACTIVE",
  },
];
const tokens = new Map([
  ["admin-token", users[0]],
  ["host-token", users[1]],
]);
const identities = new Map();
let uploadedBody = "";

try {
  writeFileSync(artifactPath, artifactBytes);
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });

  await listen(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port)
    throw new Error("identity push smoke server did not expose a port");
  writeFileSync(
    envPath,
    [
      `NEXT_PUBLIC_APP_URL=http://127.0.0.1:${port}`,
      "HOST_BOOTSTRAP_EMAIL=admin@shape.test",
      "HOST_BOOTSTRAP_PASSWORD=Admin123!",
      "VITE_SHAPE_HOST_IDENTIFIER=host@shape.test",
      "SHAPE_REMOTE_HOST_PASSWORD=Host123!",
      "",
    ].join("\n"),
  );

  try {
    const result = await runIdentityPush();
    if (result.code !== 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`identity push smoke failed with ${result.code}`);
    }

    const report = JSON.parse(result.stdout);
    assert(report.ok === true, "identity push report was not ok");
    assert(report.verified === true, "identity push did not verify download");
    assert(
      report.identity?.deliveryStatus === "PUSHED",
      "identity was not pushed",
    );
    assert(
      uploadedBody.includes("identity-smoke.bin") &&
        uploadedBody.includes(artifactPayload),
      "multipart upload did not include artifact payload",
    );
    assertCheck(report, "admin.login", "ok");
    assertCheck(report, "host.resolve", "ok");
    assertCheck(report, "identity.create", "ok");
    assertCheck(report, "identity.push", "ok");
    assertCheck(report, "identity.host-list", "ok");
    assertCheck(report, "identity.artifact-url", "ok");
    assertCheck(report, "identity.artifact-download", "ok");

    const handoffResult = await runIdentityHandoffOnly();
    if (handoffResult.code !== 0) {
      if (handoffResult.stdout) process.stdout.write(handoffResult.stdout);
      if (handoffResult.stderr) process.stderr.write(handoffResult.stderr);
      throw new Error(
        `identity handoff smoke failed with ${handoffResult.code}`,
      );
    }
    const handoff = JSON.parse(handoffResult.stdout);
    assert(handoff.ok === true, "identity handoff report was not ok");
    assert(
      handoff.steps?.identityPush?.ok === true,
      "handoff identity push step did not pass",
    );
    assert(
      handoff.demo?.identity?.deliveryStatus === "PUSHED",
      "handoff did not summarize pushed identity",
    );

    console.log("identity push smoke ok");
  } finally {
    await close(server);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

async function handleRequest(request, response) {
  if (request.method === "POST" && request.url === "/api/auth/host/login") {
    const body = JSON.parse(await readBody(request));
    const user =
      body.identifier === "admin@shape.test"
        ? users[0]
        : body.identifier === "host@shape.test"
          ? users[1]
          : null;
    const password =
      body.identifier === "admin@shape.test" ? "Admin123!" : "Host123!";

    if (!user || body.password !== password) {
      json(response, 401, { error: "Credenciales invalidas." });
      return;
    }

    json(response, 200, {
      session: {
        token: user.rank === "ADMIN" ? "admin-token" : "host-token",
        user,
      },
    });
    return;
  }

  if (request.method === "GET" && request.url === "/api/users") {
    if (!requireBearer(request, response, "ADMIN")) return;
    json(response, 200, { users });
    return;
  }

  if (request.method === "POST" && request.url === "/api/admin/identities") {
    if (!requireBearer(request, response, "ADMIN")) return;
    uploadedBody = await readBody(request);
    const identity = {
      id: "identity_push_smoke",
      userId: users[1].id,
      name: "Smoke Identity",
      ownerEmail: users[1].email,
      kind: "PHOTO_IDENTITY",
      status: "AVAILABLE",
      deliveryStatus: "READY",
      version: `demo-${artifactSha256.slice(0, 8)}`,
      artifactUri: "shape-artifact://local/smoke/identity-smoke.bin",
      artifactSha256,
      artifactSizeBytes: artifactBytes.byteLength,
    };
    identities.set(identity.id, identity);
    json(response, 201, { identity });
    return;
  }

  const deliveryMatch = request.url?.match(
    /^\/api\/admin\/identities\/([^/]+)\/delivery$/,
  );
  if (request.method === "PATCH" && deliveryMatch) {
    if (!requireBearer(request, response, "ADMIN")) return;
    const identity = identities.get(decodeURIComponent(deliveryMatch[1]));
    if (!identity) {
      json(response, 404, { error: "Rostro no encontrado." });
      return;
    }
    identity.deliveryStatus = "PUSHED";
    json(response, 200, { identity });
    return;
  }

  if (request.method === "GET" && request.url === "/api/host/identities") {
    if (!requireBearer(request, response)) return;
    json(response, 200, {
      identities: Array.from(identities.values()).filter(
        (identity) => identity.deliveryStatus === "PUSHED",
      ),
    });
    return;
  }

  const artifactMatch = request.url?.match(
    /^\/api\/host\/identities\/([^/]+)\/artifact$/,
  );
  if (request.method === "GET" && artifactMatch) {
    if (!requireBearer(request, response)) return;
    const identity = identities.get(decodeURIComponent(artifactMatch[1]));
    if (!identity) {
      json(response, 404, { error: "Artefacto no encontrado." });
      return;
    }
    const host = request.headers.host;
    json(response, 200, {
      artifact: {
        ...identity,
        downloadUrl: `http://${host}/api/host/identities/${encodeURIComponent(identity.id)}/artifact/download?token=smoke`,
      },
    });
    return;
  }

  const downloadMatch = request.url?.match(
    /^\/api\/host\/identities\/([^/]+)\/artifact\/download/,
  );
  if (request.method === "GET" && downloadMatch) {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(artifactBytes.byteLength),
      "x-shape-artifact-sha256": artifactSha256,
    });
    response.end(artifactBytes);
    return;
  }

  json(response, 404, { error: "not_found" });
}

function runIdentityPush() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/push-host-identity.mjs",
        "--json",
        "--env-file",
        envPath,
        "--artifact-file",
        artifactPath,
        "--name",
        "Smoke Identity",
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runIdentityHandoffOnly() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/package-demo-handoff.mjs",
        "--json",
        "--output-dir",
        join(tempDir, "handoff"),
        "--skip-prepare",
        "--skip-debug",
        "--skip-real-check",
        "--skip-local-preview",
        "--skip-desktop",
        "--skip-model-bootstrap",
        "--remote-env-file",
        envPath,
        "--identity-artifact-file",
        artifactPath,
        "--identity-name",
        "Smoke Identity Handoff",
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function requireBearer(request, response, rank = null) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const user = tokens.get(token);
  if (!user) {
    json(response, 401, { error: "Sesion invalida." });
    return false;
  }
  if (rank && user.rank !== rank) {
    json(response, 401, { error: "Sesion admin requerida." });
    return false;
  }
  return true;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function assertCheck(report, id, status) {
  assert(
    report.checks?.some((check) => check.id === id && check.status === status),
    `missing ${status} check ${id}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
