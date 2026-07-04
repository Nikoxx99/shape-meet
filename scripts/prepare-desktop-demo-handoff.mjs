import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const download = args.includes("--download");
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

function headMatchesCurrent(runHeadSha) {
  if (!currentHeadSha || !runHeadSha) return false;
  return (
    String(runHeadSha).startsWith(currentHeadSha) ||
    String(currentHeadSha).startsWith(runHeadSha)
  );
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
