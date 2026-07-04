import { createHash, createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const json = args.includes("--json");
const skipNetwork = args.includes("--skip-network");
const skipTurnAuth = args.includes("--skip-turn-auth");
const skipTurnutils = args.includes("--skip-turnutils");
const skipJsTurnAuth = args.includes("--skip-js-turn-auth");
const skipLiveKitHandshake = args.includes("--skip-livekit-handshake");
const apiFlow =
  args.includes("--api-flow") || args.includes("--check-api-flow");
const identityFlow =
  args.includes("--identity-flow") || args.includes("--check-identity-flow");
const timeoutMs = Number(argValue("--timeout-ms") ?? "5000");
const envFile = argValue("--env-file");
const outputPath = argValue("--output");
const env = {
  ...(envFile ? readEnvFile(resolve(envFile)) : {}),
  ...process.env,
};
const skipTurnTls =
  args.includes("--skip-turn-tls") ||
  envFlag(env.SHAPE_REMOTE_SKIP_TURN_TLS) ||
  envFlag(env.LIVEKIT_SKIP_TURN_TLS);
const retryAttempts = positiveInteger(
  argValue("--retry-attempts") ?? env.SHAPE_REMOTE_RETRY_ATTEMPTS,
  3,
);
const retryDelayMs = positiveInteger(
  argValue("--retry-delay-ms") ?? env.SHAPE_REMOTE_RETRY_DELAY_MS,
  1000,
);
const checks = [];
const warnings = [];
const issues = [];

const adminUrl = normalizeUrl(
  argValue("--admin-url") ??
    env.SHAPE_REMOTE_ADMIN_URL ??
    env.NEXT_PUBLIC_APP_URL ??
    env.VITE_SHAPE_API_URL,
);
const livekitUrl = normalizeUrl(
  argValue("--livekit-url") ?? env.SHAPE_REMOTE_LIVEKIT_URL ?? env.LIVEKIT_URL,
);
const turnHost =
  argValue("--turn-host") ??
  env.SHAPE_REMOTE_TURN_HOST ??
  env.LIVEKIT_TURN_DOMAIN;
const rtcTcpPort = parsePort(
  argValue("--rtc-tcp-port") ?? env.LIVEKIT_RTC_TCP_PORT ?? "7881",
  "LIVEKIT_RTC_TCP_PORT",
);
const turnUdpPort = parsePort(
  argValue("--turn-udp-port") ?? env.LIVEKIT_TURN_UDP_PORT ?? "3478",
  "LIVEKIT_TURN_UDP_PORT",
);
const turnTlsPort = parsePort(
  argValue("--turn-tls-port") ?? env.LIVEKIT_TURN_TLS_PORT ?? "5349",
  "LIVEKIT_TURN_TLS_PORT",
);
const turnTtlSeconds = parsePositiveInteger(
  env.LIVEKIT_TURN_TTL_SECONDS ?? "14400",
  "LIVEKIT_TURN_TTL_SECONDS",
);
const turnSecret = env.LIVEKIT_TURN_SHARED_SECRET;
const hostIdentifier =
  argValue("--host-identifier") ??
  argValue("--host-email") ??
  env.SHAPE_REMOTE_HOST_IDENTIFIER ??
  env.SHAPE_REMOTE_HOST_EMAIL ??
  env.HOST_BOOTSTRAP_EMAIL ??
  env.VITE_SHAPE_HOST_IDENTIFIER;
const hostPassword =
  argValue("--host-password") ??
  env.SHAPE_REMOTE_HOST_PASSWORD ??
  env.HOST_BOOTSTRAP_PASSWORD;
const adminIdentifier =
  argValue("--admin-identifier") ??
  argValue("--admin-email") ??
  env.SHAPE_REMOTE_ADMIN_IDENTIFIER ??
  env.SHAPE_REMOTE_ADMIN_EMAIL ??
  env.ADMIN_BOOTSTRAP_EMAIL ??
  hostIdentifier;
const adminPassword =
  argValue("--admin-password") ??
  env.SHAPE_REMOTE_ADMIN_PASSWORD ??
  env.ADMIN_BOOTSTRAP_PASSWORD ??
  hostPassword;

await main();

async function main() {
  checkRequiredConfig();
  checkProtocols();

  if (!skipNetwork && issues.length === 0) {
    await runNetworkChecks();
    if (apiFlow) await checkAdminApiFlow();
    if (identityFlow) await checkIdentityArtifactFlow();
  }

  const status =
    issues.length > 0 ? "failed" : warnings.length > 0 ? "warning" : "passed";
  const report = {
    status,
    checkedAt: new Date().toISOString(),
    target: {
      adminUrl,
      livekitUrl,
      turnHost,
      rtcTcpPort,
      turnUdpPort,
      turnTlsPort,
    },
    checks,
    warnings,
    issues,
  };

  if (outputPath) writeReport(outputPath, report);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (issues.length > 0 || (strict && warnings.length > 0)) {
    process.exit(1);
  }
}

function writeReport(path, report) {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  checks.push(
    check(
      "report.output",
      "ok",
      `Reporte remoto escrito: ${absolutePath}`,
      null,
    ),
  );
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`);
}

function checkRequiredConfig() {
  if (!adminUrl)
    issue("config.admin", "Falta NEXT_PUBLIC_APP_URL o --admin-url.");
  else ok("config.admin", `Admin: ${adminUrl}`);

  if (!livekitUrl)
    issue("config.livekit", "Falta LIVEKIT_URL o --livekit-url.");
  else ok("config.livekit", `LiveKit: ${livekitUrl}`);

  if (!turnHost)
    issue("config.turn", "Falta LIVEKIT_TURN_DOMAIN o --turn-host.");
  else ok("config.turn", `TURN: ${turnHost}`);

  if (apiFlow) {
    if (!hostIdentifier) {
      issue(
        "config.api-flow-host",
        "Falta HOST_BOOTSTRAP_EMAIL, VITE_SHAPE_HOST_IDENTIFIER o --host-identifier para --api-flow.",
      );
    }
    if (!hostPassword) {
      issue(
        "config.api-flow-password",
        "Falta HOST_BOOTSTRAP_PASSWORD o --host-password para --api-flow.",
      );
    }
  }

  if (identityFlow) {
    if (!adminIdentifier) {
      issue(
        "config.identity-flow-admin",
        "Falta HOST_BOOTSTRAP_EMAIL, ADMIN_BOOTSTRAP_EMAIL o --admin-identifier para --identity-flow.",
      );
    }
    if (!adminPassword) {
      issue(
        "config.identity-flow-password",
        "Falta HOST_BOOTSTRAP_PASSWORD, ADMIN_BOOTSTRAP_PASSWORD o --admin-password para --identity-flow.",
      );
    }
  }
}

function checkProtocols() {
  const admin = safeUrl(adminUrl);
  const livekit = safeUrl(livekitUrl);

  if (admin && !isLocalHost(admin.hostname) && admin.protocol !== "https:") {
    warning("config.admin-protocol", "Admin remoto debería usar https://.");
  }

  if (
    livekit &&
    !isLocalHost(livekit.hostname) &&
    livekit.protocol !== "wss:"
  ) {
    warning("config.livekit-protocol", "LiveKit remoto debería usar wss://.");
  }

  if (
    livekit &&
    turnHost &&
    livekit.hostname === turnHost &&
    !isLocalHost(livekit.hostname)
  ) {
    issue(
      "config.turn-domain",
      "LIVEKIT_URL y LIVEKIT_TURN_DOMAIN deben usar dominios separados.",
    );
  }
}

async function runNetworkChecks() {
  await checkAdminHealth();
  await checkLiveKitHttp();
  await checkDns();

  const livekit = safeUrl(livekitUrl);
  if (livekit && rtcTcpPort) {
    await checkTcp(
      "network.livekit-rtc-tcp",
      livekit.hostname,
      rtcTcpPort,
      "LiveKit RTC TCP",
    );
  }

  if (turnHost && turnUdpPort) {
    await checkTcp("network.turn-tcp", turnHost, turnUdpPort, "TURN TCP");
    await checkStunUdp();
  }

  if (skipTurnTls) {
    skipped("network.turn-tls-tcp", "TURN TLS TCP omitido por flag.");
  } else if (turnHost && turnTlsPort) {
    await checkTcp(
      "network.turn-tls-tcp",
      turnHost,
      turnTlsPort,
      "TURN TLS TCP",
    );
  }

  await checkTurnRestAuthCli();
  await checkTurnRestAuthJs();
}

async function checkAdminHealth() {
  const healthUrl = `${adminUrl.replace(/\/$/, "")}/api/health`;
  const started = Date.now();

  try {
    const response = await retryAsync(() =>
      fetchWithTimeout(healthUrl, timeoutMs),
    );
    const text = await response.text();
    const data = parseJson(text);
    if (!response.ok) {
      issue(
        "network.admin-health",
        `Admin health devolvió HTTP ${response.status}.`,
        started,
      );
      return;
    }
    if (data?.ok !== true || data?.database !== "ok") {
      issue(
        "network.admin-health",
        `Admin health respondió sin ok/database=ok: ${text.slice(0, 160)}`,
        started,
      );
      return;
    }
    ok("network.admin-health", "Admin /api/health ok.", started);
    checkAdminLiveKitConfig(data, started);
  } catch (error) {
    issue("network.admin-health", errorMessage(error), started);
  }
}

function checkAdminLiveKitConfig(data, started) {
  const livekit = data?.livekit;

  if (!livekit || typeof livekit !== "object") {
    warning(
      "network.admin-livekit-config",
      "Admin health no reporta configuración LiveKit; redeploya una versión reciente antes del demo.",
      started,
    );
    return;
  }

  if (livekit.status !== "ok") {
    const missing = [];
    if (livekit.urlConfigured !== true) missing.push("LIVEKIT_URL");
    if (livekit.credentialsConfigured !== true)
      missing.push("LIVEKIT_API_KEY/LIVEKIT_API_SECRET");
    issue(
      "network.admin-livekit-config",
      `Admin no está listo para emitir tokens LiveKit${
        missing.length ? `; falta ${missing.join(", ")}` : ""
      }.`,
      started,
    );
    return;
  }

  ok(
    "network.admin-livekit-config",
    "Admin tiene LiveKit URL y credenciales configuradas para emitir tokens.",
    started,
  );
}

async function checkLiveKitHttp() {
  const httpUrl = liveKitHttpUrl(livekitUrl);
  const started = Date.now();

  try {
    const response = await retryAsync(() =>
      fetchWithTimeout(httpUrl, timeoutMs),
    );
    if (!response.ok) {
      issue(
        "network.livekit-http",
        `LiveKit HTTP devolvió ${response.status}.`,
        started,
      );
      return;
    }
    ok(
      "network.livekit-http",
      `LiveKit signaling responde en ${httpUrl}.`,
      started,
    );
  } catch (error) {
    issue("network.livekit-http", errorMessage(error), started);
  }
}

async function checkDns() {
  const started = Date.now();

  try {
    const records = await lookup(turnHost, { all: true });
    if (records.length === 0) {
      issue("network.turn-dns", `TURN no resolvió DNS: ${turnHost}.`, started);
      return;
    }
    ok(
      "network.turn-dns",
      `TURN DNS: ${records.map((record) => record.address).join(", ")}.`,
      started,
    );
  } catch (error) {
    issue("network.turn-dns", errorMessage(error), started);
  }
}

async function checkTcp(id, host, port, label) {
  const started = Date.now();

  try {
    await tcpConnect(host, port, timeoutMs);
    ok(id, `${label} abierto en ${host}:${port}.`, started);
  } catch (error) {
    issue(
      id,
      `${label} no conecta en ${host}:${port}: ${errorMessage(error)}`,
      started,
    );
  }
}

async function checkStunUdp() {
  const started = Date.now();

  try {
    const response = await stunBindingRequest(turnHost, turnUdpPort, timeoutMs);
    ok(
      "network.turn-stun-udp",
      `TURN UDP respondió STUN ${response.type} desde ${response.remote}.`,
      started,
    );
  } catch (error) {
    issue(
      "network.turn-stun-udp",
      `TURN UDP/STUN falló: ${errorMessage(error)}`,
      started,
    );
  }
}

async function checkTurnRestAuthCli() {
  if (skipTurnAuth) {
    skipped("network.turn-auth", "auth TURN REST omitido por flag.");
    return;
  }

  if (skipTurnutils) {
    skipped(
      "network.turn-auth",
      "turnutils_uclient omitido por flag; validacion JS continua.",
    );
    return;
  }

  if (!turnSecret || isPlaceholder(turnSecret)) {
    warning(
      "network.turn-auth",
      "Sin LIVEKIT_TURN_SHARED_SECRET real; se omite auth TURN REST.",
    );
    return;
  }

  const available = spawnSync("turnutils_uclient", ["-h"], {
    encoding: "utf8",
  });
  if (available.error?.code === "ENOENT") {
    skipped(
      "network.turn-auth",
      "turnutils_uclient no esta instalado; validacion JS continua.",
    );
    return;
  }

  const started = Date.now();
  const username = `${Math.floor(Date.now() / 1000) + turnTtlSeconds}:shape-remote-check`;
  const password = createHmac("sha1", turnSecret)
    .update(username)
    .digest("base64");
  const result = spawnSync(
    "turnutils_uclient",
    [
      "-u",
      username,
      "-w",
      password,
      "-n",
      "1",
      "-m",
      "1",
      "-y",
      "-p",
      String(turnUdpPort),
      turnHost,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs + 1000,
    },
  );

  if (result.status === 0) {
    ok(
      "network.turn-auth",
      "TURN REST auth validada con turnutils_uclient.",
      started,
    );
    return;
  }

  issue(
    "network.turn-auth",
    `turnutils_uclient falló: ${redact([result.stderr, result.stdout].filter(Boolean).join("\n")).slice(0, 400)}`,
    started,
  );
}

async function checkTurnRestAuthJs() {
  if (skipTurnAuth || skipJsTurnAuth) {
    skipped("network.turn-auth-js", "auth TURN REST JS omitido por flag.");
    return;
  }

  if (!turnSecret || isPlaceholder(turnSecret)) {
    warning(
      "network.turn-auth-js",
      "Sin LIVEKIT_TURN_SHARED_SECRET real; se omite Allocate TURN REST JS.",
    );
    return;
  }

  const started = Date.now();
  const username = `${Math.floor(Date.now() / 1000) + turnTtlSeconds}:shape-remote-check-js`;
  const password = createHmac("sha1", turnSecret)
    .update(username)
    .digest("base64");

  try {
    const allocation = await turnAllocateRequest({
      host: turnHost,
      port: turnUdpPort,
      username,
      password,
      timeout: timeoutMs,
    });

    ok(
      "network.turn-auth-js",
      `TURN REST auth validada por Allocate UDP en realm ${allocation.realm}.`,
      started,
    );
  } catch (error) {
    issue(
      "network.turn-auth-js",
      `Allocate TURN REST falló: ${errorMessage(error)}`,
      started,
    );
  }
}

async function checkAdminApiFlow() {
  const loginStarted = Date.now();
  let token = null;
  let displayName = "Remote Check Host";
  let meetingCode = null;

  try {
    const login = await postAdminJson("/api/auth/host/login", {
      identifier: hostIdentifier,
      password: hostPassword,
    });
    token = login?.session?.token;
    displayName = login?.session?.user?.username ?? displayName;

    if (!token) {
      issue(
        "api.host-login",
        "Login host no devolvió session.token.",
        loginStarted,
      );
      return;
    }

    ok("api.host-login", "Login host remoto ok.", loginStarted);
  } catch (error) {
    issue("api.host-login", errorMessage(error), loginStarted);
    return;
  }

  const createStarted = Date.now();
  try {
    const created = await postAdminJson(
      "/api/meetings",
      {
        title: `Remote readiness ${new Date().toISOString()}`,
        startsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        access: "PUBLIC_LINK",
        maxParticipants: 4,
        invitedEmails: [],
      },
      token,
    );
    meetingCode = created?.meeting?.code;

    if (!meetingCode) {
      issue(
        "api.meeting-create",
        "Create meeting no devolvió meeting.code.",
        createStarted,
      );
      return;
    }

    ok(
      "api.meeting-create",
      `Reunión remota creada: ${meetingCode}.`,
      createStarted,
    );
  } catch (error) {
    issue("api.meeting-create", errorMessage(error), createStarted);
    return;
  }

  const tokenStarted = Date.now();
  let livekitConnection = null;
  try {
    const joined = await postAdminJson(
      `/api/meetings/${encodeURIComponent(meetingCode)}/join-token`,
      {
        displayName,
        camera: false,
        microphone: false,
      },
      token,
    );
    const livekit = joined?.livekit;

    if (!livekit?.token || !livekit?.room || !livekit?.identity) {
      issue(
        "api.livekit-token",
        "Join-token no devolvió token/room/identity de LiveKit.",
        tokenStarted,
      );
    } else if (livekitUrl && livekit.url !== livekitUrl) {
      issue(
        "api.livekit-token",
        `Join-token usa LiveKit URL distinta: ${livekit.url ?? "sin url"}.`,
        tokenStarted,
      );
    } else {
      livekitConnection = livekit;
      ok(
        "api.livekit-token",
        `Token LiveKit emitido para room ${livekit.room}.`,
        tokenStarted,
      );
    }
  } catch (error) {
    issue("api.livekit-token", errorMessage(error), tokenStarted);
  } finally {
    if (livekitConnection) {
      await checkLiveKitClientHandshake(livekitConnection);
    }

    const endStarted = Date.now();
    try {
      await postAdminJson(
        `/api/meetings/${encodeURIComponent(meetingCode)}/end`,
        {},
        token,
      );
      ok(
        "api.meeting-end",
        `Reunión remota cerrada: ${meetingCode}.`,
        endStarted,
      );
    } catch (error) {
      warning(
        "api.meeting-end",
        `No se pudo cerrar la reunión remota ${meetingCode}: ${errorMessage(error)}`,
        endStarted,
      );
    }
  }
}

async function checkLiveKitClientHandshake(livekit) {
  if (skipLiveKitHandshake) {
    skipped(
      "api.livekit-client-handshake",
      "Handshake LiveKit omitido por flag.",
    );
    return;
  }

  const started = Date.now();
  try {
    const response = await retryAsync(() =>
      websocketUpgrade(liveKitRtcUrl(livekit.url, livekit.token), timeoutMs),
    );

    if (response.statusCode !== 101) {
      issue(
        "api.livekit-client-handshake",
        `LiveKit /rtc devolvió HTTP ${response.statusCode}: ${response.statusText}`,
        started,
      );
      return;
    }

    ok(
      "api.livekit-client-handshake",
      `Handshake LiveKit /rtc ok para room ${livekit.room}.`,
      started,
    );
  } catch (error) {
    issue("api.livekit-client-handshake", errorMessage(error), started);
  }
}

async function checkIdentityArtifactFlow() {
  const loginStarted = Date.now();
  let adminToken = null;
  let adminUser = null;
  let hostToken = null;
  let hostUser = null;
  let identityId = null;

  try {
    const login = await postAdminJson("/api/auth/host/login", {
      identifier: adminIdentifier,
      password: adminPassword,
    });
    adminToken = login?.session?.token;
    adminUser = login?.session?.user ?? null;

    if (!adminToken || adminUser?.rank !== "ADMIN") {
      issue(
        "api.identity-admin-login",
        "Login admin no devolvió usuario ADMIN con session.token.",
        loginStarted,
      );
      return;
    }

    ok(
      "api.identity-admin-login",
      "Login admin remoto ok para publicar identidades.",
      loginStarted,
    );
  } catch (error) {
    issue("api.identity-admin-login", errorMessage(error), loginStarted);
    return;
  }

  const hostLoginStarted = Date.now();
  try {
    if (hostIdentifier && hostPassword) {
      const login = await postAdminJson("/api/auth/host/login", {
        identifier: hostIdentifier,
        password: hostPassword,
      });
      hostToken = login?.session?.token;
      hostUser = login?.session?.user ?? null;
    } else {
      hostToken = adminToken;
      hostUser = adminUser;
    }

    if (!hostToken || !hostUser?.id) {
      issue(
        "api.identity-host-login",
        "Login host no devolvió usuario destino con session.token.",
        hostLoginStarted,
      );
      return;
    }

    ok(
      "api.identity-host-login",
      `Usuario destino para identidad: ${hostUser.email ?? hostUser.username ?? hostUser.id}.`,
      hostLoginStarted,
    );
  } catch (error) {
    issue("api.identity-host-login", errorMessage(error), hostLoginStarted);
    return;
  }

  const createStarted = Date.now();
  try {
    const created = await postAdminMultipart(
      "/api/admin/identities",
      identityArtifactFormData(hostUser.id),
      adminToken,
    );
    const identity = created?.identity;
    identityId = identity?.id ?? null;

    if (
      !identityId ||
      identity.status !== "AVAILABLE" ||
      !identity.artifactUri ||
      !identity.artifactSha256 ||
      !identity.artifactSizeBytes
    ) {
      issue(
        "api.identity-create",
        "Create identity no devolvió identidad AVAILABLE con artefacto.",
        createStarted,
      );
      return;
    }

    ok(
      "api.identity-create",
      `Identidad temporal creada con artefacto: ${identityId}.`,
      createStarted,
    );
  } catch (error) {
    issue("api.identity-create", errorMessage(error), createStarted);
    return;
  }

  const pushStarted = Date.now();
  try {
    const pushed = await patchAdminJson(
      `/api/admin/identities/${encodeURIComponent(identityId)}/delivery`,
      { action: "push" },
      adminToken,
    );
    const identity = pushed?.identity;

    if (identity?.deliveryStatus !== "PUSHED") {
      issue(
        "api.identity-push",
        "Push identity no devolvió deliveryStatus=PUSHED.",
        pushStarted,
      );
      return;
    }

    ok("api.identity-push", "Identidad publicada para el host.", pushStarted);
  } catch (error) {
    issue("api.identity-push", errorMessage(error), pushStarted);
    return;
  }

  const listStarted = Date.now();
  try {
    const listed = await getAdminJson("/api/host/identities", hostToken);
    const identities = Array.isArray(listed?.identities)
      ? listed.identities
      : [];
    const found = identities.find((identity) => identity.id === identityId);

    if (!found) {
      issue(
        "api.identity-host-list",
        "El host no ve la identidad publicada.",
        listStarted,
      );
      return;
    }

    ok(
      "api.identity-host-list",
      "Host lista la identidad publicada.",
      listStarted,
    );
  } catch (error) {
    issue("api.identity-host-list", errorMessage(error), listStarted);
    return;
  }

  const artifactStarted = Date.now();
  try {
    const resolved = await getAdminJson(
      `/api/host/identities/${encodeURIComponent(identityId)}/artifact`,
      hostToken,
    );
    const artifact = resolved?.artifact;
    const downloadUrl = artifact?.downloadUrl;

    if (
      !downloadUrl ||
      !artifact?.artifactSha256 ||
      !artifact.artifactSizeBytes
    ) {
      issue(
        "api.identity-artifact-resolve",
        "Artifact endpoint no devolvió downloadUrl/sha/tamaño.",
        artifactStarted,
      );
      return;
    }

    ok(
      "api.identity-artifact-resolve",
      "Host resolvió URL firmada del artefacto.",
      artifactStarted,
    );

    await verifyIdentityArtifactDownload(downloadUrl, artifact);
  } catch (error) {
    issue(
      "api.identity-artifact-resolve",
      errorMessage(error),
      artifactStarted,
    );
  } finally {
    if (identityId && adminToken) {
      await patchAdminJson(
        `/api/admin/identities/${encodeURIComponent(identityId)}/status`,
        { status: "REVOKED" },
        adminToken,
      ).catch((error) =>
        warning(
          "api.identity-cleanup",
          `No se pudo revocar identidad temporal ${identityId}: ${errorMessage(error)}`,
        ),
      );
    }
  }
}

async function verifyIdentityArtifactDownload(downloadUrl, artifact) {
  const started = Date.now();
  const response = await fetchWithTimeout(downloadUrl, timeoutMs, {
    headers: { accept: "application/octet-stream" },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (!response.ok) {
    issue(
      "api.identity-artifact-download",
      `Descarga de artefacto devolvió HTTP ${response.status}.`,
      started,
    );
    return;
  }

  if (bytes.byteLength !== artifact.artifactSizeBytes) {
    issue(
      "api.identity-artifact-download",
      `Artefacto descargado pesa ${bytes.byteLength}; esperado ${artifact.artifactSizeBytes}.`,
      started,
    );
    return;
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (sha256 !== artifact.artifactSha256) {
    issue(
      "api.identity-artifact-download",
      "SHA256 del artefacto descargado no coincide.",
      started,
    );
    return;
  }

  ok(
    "api.identity-artifact-download",
    "Artefacto publicado descarga y valida SHA256.",
    started,
  );
}

function identityArtifactFormData(userId) {
  const form = new FormData();
  const bytes = new TextEncoder().encode(
    `shape-meet-identity-check:${Date.now()}`,
  );
  const file = new File([bytes], "shape-identity-check.bin", {
    type: "application/octet-stream",
  });

  form.set("userId", userId);
  form.set("name", `Remote identity check ${new Date().toISOString()}`);
  form.set("kind", "PHOTO_IDENTITY");
  form.set("status", "AVAILABLE");
  form.set("version", "check");
  form.set("artifactFile", file);

  return form;
}

async function postAdminJson(path, body, token = null) {
  const response = await fetchWithTimeout(`${adminUrl}${path}`, timeoutMs, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = parseJson(text) ?? {};

  if (!response.ok) {
    const detail = data?.code
      ? `${data.code}: ${data.error ?? text.slice(0, 180)}`
      : (data?.error ?? text.slice(0, 180) ?? `HTTP ${response.status}`);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  return data;
}

async function patchAdminJson(path, body, token = null) {
  const response = await fetchWithTimeout(`${adminUrl}${path}`, timeoutMs, {
    method: "PATCH",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return jsonResponseOrThrow(response);
}

async function getAdminJson(path, token = null) {
  const response = await fetchWithTimeout(`${adminUrl}${path}`, timeoutMs, {
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return jsonResponseOrThrow(response);
}

async function postAdminMultipart(path, form, token = null) {
  const response = await fetchWithTimeout(`${adminUrl}${path}`, timeoutMs, {
    method: "POST",
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });
  return jsonResponseOrThrow(response);
}

async function jsonResponseOrThrow(response) {
  const text = await response.text();
  const data = parseJson(text) ?? {};

  if (!response.ok) {
    const detail = data?.code
      ? `${data.code}: ${data.error ?? text.slice(0, 180)}`
      : (data?.error ?? text.slice(0, 180) ?? `HTTP ${response.status}`);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  return data;
}

async function fetchWithTimeout(url, timeout, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function retryAsync(callback, attempts = retryAttempts) {
  let lastError = null;
  const totalAttempts = Math.max(1, attempts);

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await callback(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < totalAttempts) await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tcpConnect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy(new Error("timeout"));
    }, timeout);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("timeout", () => {
      clearTimeout(timer);
      reject(new Error("timeout"));
    });
    socket.connect(port, host);
  });
}

function websocketUpgrade(url, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const secure = parsed.protocol === "wss:";
    const port = Number(parsed.port || (secure ? 443 : 80));
    const hostHeader = hostHeaderValue(parsed.hostname, parsed.port);
    const key = randomBytes(16).toString("base64");
    const request = [
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "User-Agent: shape-meet-remote-check",
      "",
      "",
    ].join("\r\n");
    const socket = secure
      ? tlsConnect(
          {
            host: parsed.hostname,
            port,
            servername: parsed.hostname,
          },
          writeRequest,
        )
      : new Socket();
    let raw = "";
    const timer = setTimeout(() => {
      socket.destroy(new Error("timeout"));
    }, timeout);

    if (!secure) socket.once("connect", writeRequest);
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (!raw.includes("\r\n\r\n")) return;

      clearTimeout(timer);
      socket.destroy();
      const [statusLine = ""] = raw.split("\r\n", 1);
      const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/);
      if (!match) {
        reject(new Error(`Respuesta WebSocket inválida: ${statusLine}`));
        return;
      }
      resolve({
        statusCode: Number(match[1]),
        statusText: match[2] || "",
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    if (!secure) socket.connect(port, parsed.hostname);

    function writeRequest() {
      socket.write(request);
    }
  });
}

function liveKitRtcUrl(baseUrl, token) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";

  const basePath = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = `${basePath}/rtc`;
  parsed.search = "";
  parsed.searchParams.set("access_token", token);
  parsed.searchParams.set("auto_subscribe", "0");
  parsed.searchParams.set("sdk", "shape-remote-check");
  parsed.searchParams.set("version", "0.1.0");
  parsed.searchParams.set("protocol", "15");
  return parsed.toString();
}

function hostHeaderValue(hostname, port) {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return port ? `${host}:${port}` : host;
}

function stunBindingRequest(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const transactionId = randomBytes(12);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt32BE(0x2112a442, 4);
    transactionId.copy(request, 8);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timeout"));
    }, timeout);

    socket.once("message", (message, remote) => {
      clearTimeout(timer);
      socket.close();
      if (message.length < 20) {
        reject(new Error("respuesta STUN demasiado corta"));
        return;
      }
      if (message.readUInt32BE(4) !== 0x2112a442) {
        reject(new Error("magic cookie STUN inválida"));
        return;
      }
      if (!message.subarray(8, 20).equals(transactionId)) {
        reject(new Error("transaction id STUN no coincide"));
        return;
      }
      resolve({
        type: `0x${message.readUInt16BE(0).toString(16).padStart(4, "0")}`,
        remote: `${remote.address}:${remote.port}`,
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(request, port, host);
  });
}

async function turnAllocateRequest({
  host,
  port,
  username,
  password,
  timeout,
}) {
  const socket = createSocket("udp4");

  try {
    const challengeRequest = buildStunMessage(0x0003, [
      stunAttribute(0x0019, Buffer.from([17, 0, 0, 0])),
    ]);
    const challengeResponse = parseStunMessage(
      await sendUdpMessage(
        socket,
        challengeRequest.packet,
        host,
        port,
        timeout,
      ),
      challengeRequest.transactionId,
    );

    if (challengeResponse.type === 0x0103) {
      throw new Error(
        "coturn acepto Allocate sin autenticacion; revisa --use-auth-secret",
      );
    }

    if (challengeResponse.type !== 0x0113) {
      throw new Error(
        `respuesta inesperada al challenge: ${stunTypeName(challengeResponse.type)}`,
      );
    }

    const errorCode = stunErrorCode(challengeResponse.attrs.get(0x0009));
    if (errorCode !== 401 && errorCode !== 438) {
      throw new Error(
        `challenge TURN devolvio error ${errorCode ?? "desconocido"}`,
      );
    }

    const realm = stunText(challengeResponse.attrs.get(0x0014));
    const nonce = stunText(challengeResponse.attrs.get(0x0015));

    if (!realm || !nonce) {
      throw new Error("challenge TURN no incluyo REALM/NONCE");
    }

    const key = createHash("md5")
      .update(`${username}:${realm}:${password}`)
      .digest();
    const allocateRequest = buildStunMessage(
      0x0003,
      [
        stunAttribute(0x0006, Buffer.from(username, "utf8")),
        stunAttribute(0x0014, Buffer.from(realm, "utf8")),
        stunAttribute(0x0015, Buffer.from(nonce, "utf8")),
        stunAttribute(0x0019, Buffer.from([17, 0, 0, 0])),
      ],
      { integrityKey: key },
    );
    const allocateResponse = parseStunMessage(
      await sendUdpMessage(socket, allocateRequest.packet, host, port, timeout),
      allocateRequest.transactionId,
    );

    if (allocateResponse.type === 0x0103) {
      return { realm };
    }

    if (allocateResponse.type === 0x0113) {
      const code = stunErrorCode(allocateResponse.attrs.get(0x0009));
      const reason = stunReason(allocateResponse.attrs.get(0x0009));
      throw new Error(
        `coturn rechazo credenciales REST (${code ?? "sin codigo"}${reason ? ` ${reason}` : ""})`,
      );
    }

    throw new Error(
      `respuesta inesperada al Allocate autenticado: ${stunTypeName(allocateResponse.type)}`,
    );
  } finally {
    socket.close();
  }
}

function buildStunMessage(type, attrs, options = {}) {
  const transactionId = randomBytes(12);
  const attributes = [...attrs];
  let length = attributes.reduce(
    (total, attr) => total + 4 + paddedLength(attr.value.length),
    0,
  );

  if (options.integrityKey) length += 24;

  const packet = Buffer.alloc(20 + length);
  packet.writeUInt16BE(type, 0);
  packet.writeUInt16BE(length, 2);
  packet.writeUInt32BE(0x2112a442, 4);
  transactionId.copy(packet, 8);

  let offset = 20;
  for (const attr of attributes) {
    offset = writeStunAttribute(packet, offset, attr);
  }

  if (options.integrityKey) {
    packet.writeUInt16BE(0x0008, offset);
    packet.writeUInt16BE(20, offset + 2);
    const digest = createHmac("sha1", options.integrityKey)
      .update(packet.subarray(0, offset))
      .digest();
    digest.copy(packet, offset + 4);
  }

  return { packet, transactionId };
}

function stunAttribute(type, value) {
  return { type, value };
}

function writeStunAttribute(packet, offset, attr) {
  packet.writeUInt16BE(attr.type, offset);
  packet.writeUInt16BE(attr.value.length, offset + 2);
  attr.value.copy(packet, offset + 4);
  return offset + 4 + paddedLength(attr.value.length);
}

function sendUdpMessage(socket, packet, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const transactionId = packet.subarray(8, 20);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onMessage = (message) => {
      if (
        message.length < 20 ||
        message.readUInt32BE(4) !== 0x2112a442 ||
        !message.subarray(8, 20).equals(transactionId)
      ) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.send(packet, port, host, (error) => {
      if (error) onError(error);
    });
  });
}

function parseStunMessage(message, transactionId) {
  if (message.length < 20) {
    throw new Error("respuesta STUN demasiado corta");
  }
  if (message.readUInt32BE(4) !== 0x2112a442) {
    throw new Error("magic cookie STUN invalida");
  }
  if (!message.subarray(8, 20).equals(transactionId)) {
    throw new Error("transaction id STUN no coincide");
  }

  const declaredLength = message.readUInt16BE(2);
  const attrs = new Map();
  let offset = 20;
  const end = Math.min(message.length, 20 + declaredLength);

  while (offset + 4 <= end) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > end) break;

    if (!attrs.has(type)) attrs.set(type, []);
    attrs.get(type).push(message.subarray(valueStart, valueEnd));
    offset = valueStart + paddedLength(length);
  }

  return {
    type: message.readUInt16BE(0),
    attrs,
  };
}

function paddedLength(length) {
  return Math.ceil(length / 4) * 4;
}

function stunText(values) {
  const value = Array.isArray(values) ? values[0] : null;
  return value ? value.toString("utf8") : null;
}

function stunErrorCode(values) {
  const value = Array.isArray(values) ? values[0] : null;
  if (!value || value.length < 4) return null;
  return (value[2] & 0x07) * 100 + value[3];
}

function stunReason(values) {
  const value = Array.isArray(values) ? values[0] : null;
  if (!value || value.length <= 4) return "";
  return value.subarray(4).toString("utf8");
}

function stunTypeName(type) {
  return `0x${Number(type).toString(16).padStart(4, "0")}`;
}

function liveKitHttpUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.toString().replace(/\/$/, "");
}

function ok(id, detail, started = null) {
  checks.push(check(id, "ok", detail, started));
}

function warning(id, detail, started = null) {
  warnings.push(detail);
  checks.push(check(id, "warning", detail, started));
}

function issue(id, detail, started = null) {
  issues.push(detail);
  checks.push(check(id, "failed", detail, started));
}

function skipped(id, detail) {
  checks.push(check(id, "skipped", detail, null));
}

function check(id, status, detail, started) {
  return {
    id,
    status,
    detail,
    durationMs: started ? Date.now() - started : null,
  };
}

function printReport(report) {
  console.log("Shape Meet remote demo check");
  console.log(`Estado: ${report.status}`);
  console.log(`Admin: ${report.target.adminUrl ?? "no configurado"}`);
  console.log(`LiveKit: ${report.target.livekitUrl ?? "no configurado"}`);
  console.log(`TURN: ${report.target.turnHost ?? "no configurado"}`);
  console.log("");
  for (const item of report.checks) {
    const elapsed = item.durationMs === null ? "" : ` (${item.durationMs} ms)`;
    console.log(`${item.status}: ${item.id}: ${item.detail}${elapsed}`);
  }
}

function readEnvFile(path) {
  if (!existsSync(path)) {
    console.error(`Env file not found: ${path}`);
    process.exit(1);
  }

  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issue(`config.${label}`, `${label} debe ser un puerto válido.`);
    return null;
  }
  return port;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    issue(`config.${label}`, `${label} debe ser entero positivo.`);
    return 14400;
  }
  return parsed;
}

function normalizeUrl(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}

function safeUrl(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    issue("config.url", `URL inválida: ${value}`);
    return null;
  }
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isLocalHost(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function isPlaceholder(value) {
  return [
    /^replace/i,
    /change-me/i,
    /^secret$/i,
    /^devkey$/i,
    /^shape-turn-local-secret$/i,
    /^shape-turn-dev-secret$/i,
  ].some((pattern) => pattern.test(String(value ?? "")));
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function redact(value) {
  let output = String(value);
  for (const secret of [turnSecret, hostPassword, adminPassword].filter(
    Boolean,
  )) {
    output = output.replaceAll(secret, "[redacted]");
  }
  return output;
}
