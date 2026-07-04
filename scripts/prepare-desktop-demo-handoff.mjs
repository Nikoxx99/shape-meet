import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const download = args.includes("--download");
const localBundle = args.includes("--local-bundle");
const copyLocal = args.includes("--copy-local");
const skipBundleCheck = args.includes("--skip-bundle-check");
const strictLatest = args.includes("--strict-latest");
const allowStale = args.includes("--allow-stale");
const workflowName = argValue("--workflow") ?? "Desktop Packages";
const runId = argValue("--run-id");
const repo = argValue("--repo") ?? detectRepository();
const currentHeadSha =
  argValue("--current-head") ??
  process.env.SHAPE_DESKTOP_HANDOFF_CURRENT_HEAD ??
  detectCurrentHead();
const expectedArtifacts = [
  "shape-meet-runtime-config",
  "shape-meet-windows-x64",
  "shape-meet-macos-arm64",
  "shape-meet-macos-x64",
];

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function main() {
  if (localBundle) {
    mainLocalBundle();
    return;
  }

  if (!repo) {
    throw new Error("No se pudo detectar repo GitHub. Usa --repo owner/name.");
  }

  const run = resolveRun();
  if (!run) {
    throw new Error(`No se encontro un run exitoso de ${workflowName}.`);
  }

  const artifacts = resolveArtifacts(run.databaseId);
  const report = buildReport(run, artifacts);
  const outputDir = resolve(
    repoRoot,
    argValue("--out") ??
      join("output", "desktop-handoff", `run-${run.databaseId}`),
  );
  mkdirSync(outputDir, { recursive: true });

  if (download && report.ok) {
    downloadArtifacts(run.databaseId, outputDir, report.artifacts);
  }

  writeFileSync(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(join(outputDir, "README.md"), handoffReadme(report));

  if (json) {
    console.log(JSON.stringify({ ...report, outputDir }, null, 2));
  } else {
    printReport(report, outputDir);
  }

  if (!report.ok || (strictLatest && report.run.conclusion !== "success")) {
    process.exit(1);
  }
}

function mainLocalBundle() {
  const bundleDir = resolve(
    repoRoot,
    argValue("--bundle-dir") ??
      join("apps", "desktop", "src-tauri", "target", "release", "bundle"),
  );
  const outputDir = resolve(
    repoRoot,
    argValue("--out") ??
      join("output", "desktop-handoff", `local-${shortSha(currentHeadSha)}`),
  );
  mkdirSync(outputDir, { recursive: true });

  const bundleCheck = skipBundleCheck
    ? {
        ok: true,
        skipped: true,
        command: "pnpm desktop:bundle:check",
        message: "omitido por --skip-bundle-check",
      }
    : runDesktopBundleCheck();
  const artifacts = findLocalBundleArtifacts(bundleDir);
  const report = buildLocalReport(bundleDir, bundleCheck, artifacts);

  if (copyLocal && report.ok) {
    copyLocalArtifacts(outputDir, report.artifacts);
  }

  writeFileSync(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(join(outputDir, "README.md"), localHandoffReadme(report));

  if (json) {
    console.log(JSON.stringify({ ...report, outputDir }, null, 2));
  } else {
    printLocalReport(report, outputDir);
  }

  if (!report.ok) process.exit(1);
}

function resolveRun() {
  const fixture = envJson("SHAPE_DESKTOP_HANDOFF_RUNS_JSON");
  if (fixture) {
    const runs = Array.isArray(fixture) ? fixture : [fixture];
    return chooseRun(runs);
  }

  if (runId) {
    const result = runCommand("gh", [
      "run",
      "view",
      runId,
      "--repo",
      repo,
      "--json",
      "databaseId,status,conclusion,url,name,createdAt,headSha,event",
    ]);
    if (result.status !== 0) {
      throw new Error(`No se pudo leer run ${runId}: ${trim(result.stderr)}`);
    }
    return parseJson(result.stdout);
  }

  const result = runCommand("gh", [
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    workflowName,
    "--limit",
    "20",
    "--json",
    "databaseId,status,conclusion,url,name,createdAt,headSha,event",
  ]);
  if (result.status !== 0) {
    throw new Error(
      `No se pudo listar ${workflowName}: ${trim(result.stderr)}`,
    );
  }
  return chooseRun(parseJson(result.stdout));
}

function chooseRun(runs) {
  if (!Array.isArray(runs)) return null;
  if (runId) {
    return runs.find((run) => String(run.databaseId) === String(runId)) ?? null;
  }
  return (
    runs.find(
      (run) => run.status === "completed" && run.conclusion === "success",
    ) ??
    runs[0] ??
    null
  );
}

function resolveArtifacts(databaseId) {
  const fixture = envJson("SHAPE_DESKTOP_HANDOFF_ARTIFACTS_JSON");
  if (fixture)
    return Array.isArray(fixture) ? fixture : (fixture.artifacts ?? []);

  const result = runCommand("gh", [
    "api",
    `repos/${repo}/actions/runs/${databaseId}/artifacts?per_page=100`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `No se pudieron listar artifacts del run ${databaseId}: ${trim(result.stderr)}`,
    );
  }

  const payload = parseJson(result.stdout);
  return payload?.artifacts ?? [];
}

function buildReport(run, artifacts) {
  const runReady = run.status === "completed" && run.conclusion === "success";
  const normalizedArtifacts = artifacts.map((artifact) => ({
    id: artifact.id ?? null,
    name: artifact.name,
    expired: Boolean(artifact.expired),
    sizeBytes: artifact.size_in_bytes ?? artifact.sizeBytes ?? null,
    createdAt: artifact.created_at ?? artifact.createdAt ?? null,
    expiresAt: artifact.expires_at ?? artifact.expiresAt ?? null,
    archiveDownloadUrl:
      artifact.archive_download_url ?? artifact.archiveDownloadUrl ?? null,
  }));
  const artifactNames = new Set(
    normalizedArtifacts.map((artifact) => artifact.name),
  );
  const missingArtifacts = expectedArtifacts.filter(
    (name) => !artifactNames.has(name),
  );
  const expiredArtifacts = normalizedArtifacts
    .filter(
      (artifact) =>
        expectedArtifacts.includes(artifact.name) && artifact.expired,
    )
    .map((artifact) => artifact.name);
  const presentArtifacts = normalizedArtifacts.filter((artifact) =>
    expectedArtifacts.includes(artifact.name),
  );

  return {
    ok:
      runReady &&
      missingArtifacts.length === 0 &&
      expiredArtifacts.length === 0 &&
      (allowStale || headMatchesCurrent(run.headSha)),
    generatedAt: new Date().toISOString(),
    repository: repo,
    workflow: workflowName,
    currentHeadSha,
    allowStale,
    run: {
      databaseId: run.databaseId,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
      name: run.name,
      event: run.event,
      createdAt: run.createdAt,
      headSha: run.headSha,
    },
    runReady,
    headMatchesCurrent: headMatchesCurrent(run.headSha),
    expectedArtifacts,
    artifacts: presentArtifacts,
    missingArtifacts,
    expiredArtifacts,
  };
}

function runDesktopBundleCheck() {
  const result = runCommand(pnpmCommand(), ["desktop:bundle:check"]);
  return {
    ok: result.status === 0,
    skipped: false,
    command: "pnpm desktop:bundle:check",
    stdout: trim(result.stdout),
    stderr: trim(result.stderr),
  };
}

function buildLocalReport(bundleDir, bundleCheck, artifacts) {
  const bundleExists = existsSync(bundleDir);
  const issues = [];
  if (!bundleExists) {
    issues.push(`No existe bundle local: ${relativePath(bundleDir)}`);
  }
  if (!bundleCheck.ok) {
    issues.push("desktop:bundle:check fallo para el bundle local.");
  }
  if (artifacts.length === 0) {
    issues.push(
      "No se encontraron instaladores o bundles locales en target/release/bundle.",
    );
  }

  return {
    ok: issues.length === 0,
    source: "local-bundle",
    generatedAt: new Date().toISOString(),
    repository: repo,
    currentHeadSha,
    platform: process.platform,
    arch: process.arch,
    bundleDir,
    bundleExists,
    bundleCheck,
    artifacts,
    issues,
  };
}

function downloadArtifacts(databaseId, outputDir, artifacts) {
  const artifactsDir = join(outputDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  for (const artifact of artifacts) {
    const result = runCommand("gh", [
      "run",
      "download",
      String(databaseId),
      "--repo",
      repo,
      "--name",
      artifact.name,
      "--dir",
      join(artifactsDir, artifact.name),
    ]);
    if (result.status !== 0) {
      throw new Error(
        `No se pudo descargar ${artifact.name}: ${trim(result.stderr)}`,
      );
    }
  }
}

function copyLocalArtifacts(outputDir, artifacts) {
  const artifactsDir = join(outputDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  for (const artifact of artifacts) {
    const target = join(artifactsDir, safeArtifactName(artifact.name));
    cpSync(artifact.path, target, { recursive: true });
    artifact.copiedTo = target;
  }
}

function handoffReadme(report) {
  const artifactLines = report.expectedArtifacts
    .map((name) => {
      const artifact = report.artifacts.find(
        (candidate) => candidate.name === name,
      );
      if (!artifact) return `- ${name}: faltante`;
      const size = artifact.sizeBytes
        ? `${Math.round(artifact.sizeBytes / 1024 / 1024)} MB`
        : "tamano desconocido";
      return `- ${name}: ${size}, expira ${artifact.expiresAt ?? "sin fecha"}`;
    })
    .join("\n");

  return `# Shape Meet desktop demo handoff

Run: ${report.run.url}
Commit: ${report.run.headSha}
Estado: ${report.ok ? "listo" : "revisar artifacts"}
Commit actual: ${report.currentHeadSha ?? "desconocido"}
Commit de artifacts: ${report.run.headSha}
Coincide con HEAD actual: ${report.headMatchesCurrent ? "si" : "no"}

## Artifacts

${artifactLines}

## Uso operativo

1. Descarga los artifacts desde el run de GitHub Actions o ejecuta \`pnpm desktop:handoff -- --download --run-id ${report.run.databaseId}\`.
2. Usa \`shape-meet-runtime-config\` como fuente de \`shape-meet.env\` para apuntar la app instalada al entorno demo.
3. Instala el artifact de la plataforma correspondiente y valida la estacion con \`pnpm demo:real:check -- --strict\` antes de mostrar modelos reales.
4. Si necesitas usar artifacts de otro commit para una prueba puntual, genera el handoff con \`--allow-stale\` y deja registrado el commit exacto.
`;
}

function localHandoffReadme(report) {
  const artifactLines = report.artifacts.length
    ? report.artifacts
        .map((artifact) => {
          const size = artifact.sizeBytes
            ? `${Math.round(artifact.sizeBytes / 1024 / 1024)} MB`
            : "tamano desconocido";
          return `- ${artifact.name}: ${size}, ${artifact.kind}, ${artifact.path}`;
        })
        .join("\n")
    : "- No se encontraron artifacts locales.";
  const issueLines = report.issues.length
    ? report.issues.map((issue) => `- ${issue}`).join("\n")
    : "- Sin issues.";

  return `# Shape Meet local desktop demo handoff

Fuente: bundle local
Commit actual: ${report.currentHeadSha ?? "desconocido"}
Bundle: ${report.bundleDir}
Estado: ${report.ok ? "listo" : "revisar bundle local"}
Bundle check: ${report.bundleCheck.ok ? "ok" : "fallo"}${report.bundleCheck.skipped ? " (omitido)" : ""}

## Artifacts Locales

${artifactLines}

## Issues

${issueLines}

## Uso Operativo

1. Genera el bundle local con \`pnpm build:desktop\`.
2. Valida contenido con \`pnpm desktop:bundle:check\`.
3. Genera este handoff con \`pnpm desktop:handoff -- --local-bundle\`.
4. Si necesitas copiar los instaladores al directorio de handoff, usa \`--copy-local\`.
5. Instala la app y valida la estacion con \`pnpm demo:real:check -- --strict --include-desktop\`.
`;
}

function printReport(report, outputDir) {
  console.log("Desktop demo handoff");
  console.log(`Run: ${report.run.url}`);
  console.log(`Output: ${outputDir}`);
  for (const artifact of report.artifacts) {
    const size = artifact.sizeBytes
      ? `${Math.round(artifact.sizeBytes / 1024 / 1024)} MB`
      : "sin tamano";
    console.log(`ok: ${artifact.name} (${size})`);
  }
  for (const artifact of report.missingArtifacts) {
    console.error(`fail: artifact faltante ${artifact}`);
  }
  for (const artifact of report.expiredArtifacts) {
    console.error(`fail: artifact expirado ${artifact}`);
  }
  if (!report.runReady) {
    console.error(
      `fail: run no exitoso (${report.run.status}/${report.run.conclusion})`,
    );
  }
  if (!report.headMatchesCurrent && !report.allowStale) {
    console.error(
      `fail: artifacts stale (${report.run.headSha} != ${report.currentHeadSha ?? "HEAD desconocido"})`,
    );
  }
  if (!report.headMatchesCurrent && report.allowStale) {
    console.warn(
      `warn: usando artifacts stale (${report.run.headSha} != ${report.currentHeadSha ?? "HEAD desconocido"})`,
    );
  }
  console.log(
    report.ok ? "Desktop demo handoff ok" : "Desktop demo handoff failed",
  );
}

function printLocalReport(report, outputDir) {
  console.log("Desktop local demo handoff");
  console.log(`Bundle: ${report.bundleDir}`);
  console.log(`Output: ${outputDir}`);
  for (const artifact of report.artifacts) {
    const size = artifact.sizeBytes
      ? `${Math.round(artifact.sizeBytes / 1024 / 1024)} MB`
      : "sin tamano";
    console.log(`ok: ${artifact.name} (${size})`);
  }
  for (const issue of report.issues) console.error(`fail: ${issue}`);
  console.log(
    report.ok
      ? "Desktop local demo handoff ok"
      : "Desktop local demo handoff failed",
  );
}

function headMatchesCurrent(runHeadSha) {
  if (!currentHeadSha || !runHeadSha) return false;
  return (
    String(runHeadSha).startsWith(currentHeadSha) ||
    String(currentHeadSha).startsWith(runHeadSha)
  );
}

function findLocalBundleArtifacts(bundleDir) {
  if (!existsSync(bundleDir)) return [];

  const artifacts = [];
  walkBundle(bundleDir, (path, stat) => {
    const name = basename(path);
    if (stat.isDirectory()) {
      if (name.endsWith(".app")) {
        artifacts.push(localArtifact(path, "app-bundle"));
        return false;
      }
      return true;
    }

    if (isDesktopDeliverable(name)) {
      artifacts.push(localArtifact(path, "installer"));
    }
    return true;
  });

  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

function walkBundle(dir, visitor) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = statSync(path);
    const shouldContinue = visitor(path, stat);
    if (entry.isDirectory() && shouldContinue !== false) {
      walkBundle(path, visitor);
    }
  }
}

function localArtifact(path, kind) {
  const stat = statSync(path);
  return {
    name: basename(path),
    path,
    relativePath: relativePath(path),
    kind,
    sizeBytes: pathSize(path),
    modifiedAt: stat.mtime.toISOString(),
  };
}

function isDesktopDeliverable(name) {
  return /\.(dmg|msi|exe|appimage|deb|rpm|zip)$/i.test(name);
}

function pathSize(path) {
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return readdirSync(path).reduce(
    (total, entry) => total + pathSize(join(path, entry)),
    0,
  );
}

function safeArtifactName(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function shortSha(value) {
  return value ? String(value).slice(0, 12) : "unknown";
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function detectRepository() {
  const gh = runCommand("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  if (gh.status === 0 && gh.stdout.trim()) return gh.stdout.trim();

  const remote = runCommand("git", ["remote", "get-url", "origin"]);
  if (remote.status !== 0) return null;
  const url = remote.stdout.trim();
  const httpsMatch = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  return httpsMatch?.[1] ?? null;
}

function detectCurrentHead() {
  const result = runCommand("git", ["rev-parse", "HEAD"]);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function envJson(name) {
  const value = process.env[name];
  if (!value) return null;
  if (existsSync(value)) return parseJson(readFileSync(value, "utf8"));
  return parseJson(value);
}

function relativePath(path) {
  const relativeToRepo = relative(repoRoot, path);
  return relativeToRepo.startsWith("..") ? path : relativeToRepo;
}

function runCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === "win32" && /\.cmd$/i.test(command),
  });
  return {
    status:
      typeof result.status === "number" ? result.status : result.error ? 1 : 0,
    stdout: result.stdout ?? "",
    stderr:
      result.stderr ??
      (result.error instanceof Error ? result.error.message : ""),
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function argValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function trim(value) {
  const text = String(value ?? "").trim();
  return text.length > 1000 ? `${text.slice(0, 1000)}...<truncated>` : text;
}
