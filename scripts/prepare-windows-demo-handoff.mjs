import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const json = args.includes("--json");
const outputDir = resolve(
  argValue("--out") ??
    join("output", "windows-demo-handoff", safeTimestamp(new Date())),
);
const env = {
  ...readEnvFile(".env.local"),
  ...readEnvFile("apps/admin/.env.local"),
  ...readEnvFile("apps/desktop/.env.local"),
  ...process.env,
};

const config = {
  apiUrl: trimTrailingSlash(
    argValue("--api-url") ??
      env.VITE_SHAPE_API_URL ??
      env.SHAPE_API_URL ??
      env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:13000",
  ),
  meetingUrl: trimTrailingSlash(
    argValue("--meeting-url") ??
      env.VITE_SHAPE_MEETING_URL ??
      env.SHAPE_MEETING_URL ??
      env.VITE_SHAPE_APP_URL ??
      env.SHAPE_APP_URL ??
      "http://localhost:1420",
  ),
  aiUrl: trimTrailingSlash(
    argValue("--ai-url") ??
      env.VITE_SHAPE_AI_SERVICE_URL ??
      env.SHAPE_AI_SERVICE_URL ??
      "http://127.0.0.1:7851",
  ),
  hostIdentifier:
    argValue("--host-identifier") ??
    env.VITE_SHAPE_HOST_IDENTIFIER ??
    env.SHAPE_HOST_IDENTIFIER ??
    env.HOST_BOOTSTRAP_EMAIL ??
    "",
  sentryDsn:
    argValue("--sentry-dsn") ??
    env.VITE_SENTRY_DSN ??
    env.SENTRY_DSN ??
    env.NEXT_PUBLIC_SENTRY_DSN ??
    "",
  sentryEnvironment:
    argValue("--sentry-environment") ??
    env.VITE_SENTRY_ENVIRONMENT ??
    env.SENTRY_ENVIRONMENT ??
    "internal-debug",
  sentryRelease:
    argValue("--release") ??
    env.VITE_SENTRY_RELEASE ??
    env.SENTRY_RELEASE ??
    "shape-meet-desktop@0.1.0",
  sentryTracesSampleRate:
    argValue("--sentry-traces-sample-rate") ??
    env.VITE_SENTRY_TRACES_SAMPLE_RATE ??
    env.SENTRY_TRACES_SAMPLE_RATE ??
    "1.0",
  sentryDebug:
    argValue("--sentry-debug") ??
    env.VITE_SENTRY_DEBUG ??
    env.SENTRY_DEBUG ??
    "true",
};

mkdirSync(outputDir, { recursive: true });

const runtimeConfigPath = join(outputDir, "shape-meet.env");
const scriptPath = join(outputDir, "Build-ShapeMeetWindows.ps1");
const diagnosticScriptPath = join(outputDir, "Test-ShapeMeetWindows.ps1");
const readmePath = join(outputDir, "README.md");
const manifestPath = join(outputDir, "manifest.json");
const runtimeResult = writeRuntimeConfig(runtimeConfigPath);
const manifest = {
  ok: runtimeResult.status === 0,
  generatedAt: new Date().toISOString(),
  outputDir,
  runtimeConfig: runtimeConfigPath,
  buildScript: scriptPath,
  diagnosticScript: diagnosticScriptPath,
  readme: readmePath,
  manifest: manifestPath,
  config: {
    apiUrl: config.apiUrl,
    meetingUrl: config.meetingUrl,
    aiUrl: config.aiUrl,
    hostIdentifier: config.hostIdentifier || null,
    sentryConfigured: Boolean(config.sentryDsn),
    sentryEnvironment: config.sentryEnvironment,
    sentryRelease: config.sentryRelease,
    sentryDebug: config.sentryDebug,
  },
  runtimeConfigCommand: runtimeResult,
  expectedWindowsArtifacts: [
    "apps/desktop/src-tauri/target/release/bundle/**/*.msi",
    "apps/desktop/src-tauri/target/release/bundle/**/*.exe",
  ],
  ciFallbackReason:
    "GitHub Actions Desktop Packages puede estar bloqueado por billing; este handoff permite construir en Windows localmente.",
};

writeFileSync(scriptPath, windowsBuildScript());
writeFileSync(diagnosticScriptPath, windowsDiagnosticScript());
writeFileSync(readmePath, readme(manifest));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (json) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log("Shape Meet Windows demo handoff");
  console.log(`Output: ${outputDir}`);
  console.log(`Runtime config: ${runtimeConfigPath}`);
  console.log(`Build script: ${scriptPath}`);
  console.log(`Diagnostic script: ${diagnosticScriptPath}`);
  console.log(`Manifest: ${manifestPath}`);
}

if (!manifest.ok) process.exit(1);

function writeRuntimeConfig(outPath) {
  const commandArgs = [
    "scripts/prepare-desktop-runtime-config.mjs",
    "--out",
    outPath,
    "--api-url",
    config.apiUrl,
    "--meeting-url",
    config.meetingUrl,
    "--ai-url",
    config.aiUrl,
    "--sentry-environment",
    config.sentryEnvironment,
    "--release",
    config.sentryRelease,
    "--sentry-traces-sample-rate",
    config.sentryTracesSampleRate,
    "--sentry-debug",
    config.sentryDebug,
  ];

  if (config.hostIdentifier) {
    commandArgs.push("--host-identifier", config.hostIdentifier);
  }
  if (config.sentryDsn) {
    commandArgs.push("--sentry-dsn", config.sentryDsn);
  }

  const result = spawnSync(process.execPath, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  return {
    command: `node ${commandArgs.join(" ")}`,
    status: result.status,
    stdout: trim(result.stdout),
    stderr: trim(result.stderr),
  };
}

function windowsBuildScript() {
  return `param(
  [string]$RuntimeConfig = (Join-Path $PSScriptRoot "shape-meet.env"),
  [string]$OutputDir = "output/desktop-handoff/windows-local",
  [switch]$SkipInstallRuntimeConfig,
  [switch]$SkipBundleCheck
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Command
  )
  Write-Host ""
  Write-Host "==> $Name"
  & $Command
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name no esta instalado o no esta en PATH."
  }
}

Write-Host "Shape Meet Windows demo build"
Write-Host "Runtime config: $RuntimeConfig"
Write-Host "Output: $OutputDir"

Assert-Command "node"
Assert-Command "pnpm"
Assert-Command "cargo"
Assert-Command "rustc"
Assert-Command "python"

if (Test-Path $RuntimeConfig) {
  $env:SHAPE_DESKTOP_RUNTIME_CONFIG_FILE = (Resolve-Path $RuntimeConfig).Path
  if (-not $SkipInstallRuntimeConfig) {
    $appData = Join-Path $env:LOCALAPPDATA "Shape Meet"
    New-Item -ItemType Directory -Force -Path $appData | Out-Null
    Copy-Item -Force $RuntimeConfig (Join-Path $appData "shape-meet.env")
    Write-Host "Runtime config instalado en $appData\\shape-meet.env"
  }
} else {
  Write-Warning "No encontre runtime config en $RuntimeConfig; se usaran defaults de build."
}

Invoke-Step "Corepack" { corepack enable }
Invoke-Step "Dependencias" { pnpm install --frozen-lockfile }
Invoke-Step "Sidecar IA" { pnpm build:ai-sidecar }
Invoke-Step "Doctor desktop" { pnpm desktop:doctor -- --strict }
Invoke-Step "Build Tauri Windows" { pnpm build:desktop }

if (-not $SkipBundleCheck) {
  Invoke-Step "Bundle check" { pnpm desktop:bundle:check }
}

Invoke-Step "Handoff local" { pnpm desktop:handoff -- --local-bundle --copy-local --out $OutputDir }

Write-Host ""
Write-Host "Build Windows listo."
Write-Host "Instaladores esperados en apps/desktop/src-tauri/target/release/bundle"
Write-Host "Handoff copiado en $OutputDir"
Write-Host "Abre la app, entra a Prueba de equipo y usa Bundle debug / Evento Sentry."
`;
}

function windowsDiagnosticScript() {
  return `param(
  [string]$RuntimeConfig = (Join-Path $PSScriptRoot "shape-meet.env"),
  [switch]$InstallRuntimeConfig,
  [switch]$SkipSentryLive,
  [switch]$SkipDemoPrepare
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Command
  )
  Write-Host ""
  Write-Host "==> $Name"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Name fallo con codigo $LASTEXITCODE."
  }
}

function Invoke-OptionalStep {
  param(
    [string]$Name,
    [scriptblock]$Command
  )
  Write-Host ""
  Write-Host "==> $Name"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "$Name fallo con codigo $LASTEXITCODE."
  }
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name no esta instalado o no esta en PATH."
  }
}

function Import-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    throw "No encontre runtime config: $Path"
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $key, $value = $line.Split("=", 2)
      $value = $value.Trim()
      if (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      ) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      [Environment]::SetEnvironmentVariable($key.Trim(), $value, "Process")
    }
  }
}

function Copy-RuntimeConfig {
  param([string]$Path)
  $appData = Join-Path $env:LOCALAPPDATA "Shape Meet"
  New-Item -ItemType Directory -Force -Path $appData | Out-Null
  Copy-Item -Force $Path (Join-Path $appData "shape-meet.env")
  Write-Host "Runtime config instalado en $appData\\shape-meet.env"
}

function Set-DemoEnvAliases {
  if ($env:VITE_SHAPE_API_URL) {
    $env:SHAPE_DEMO_API_URL = $env:VITE_SHAPE_API_URL
    $env:SHAPE_SMOKE_API_URL = $env:VITE_SHAPE_API_URL
  }
  if ($env:VITE_SHAPE_MEETING_URL) {
    $env:SHAPE_DEMO_APP_URL = $env:VITE_SHAPE_MEETING_URL
  }
  if ($env:VITE_SHAPE_AI_SERVICE_URL) {
    $env:SHAPE_DEMO_AI_URL = $env:VITE_SHAPE_AI_SERVICE_URL
  }
  if ($env:VITE_SENTRY_DSN -and -not $env:SENTRY_DSN) {
    $env:SENTRY_DSN = $env:VITE_SENTRY_DSN
  }
  if ($env:VITE_SENTRY_ENVIRONMENT -and -not $env:SENTRY_ENVIRONMENT) {
    $env:SENTRY_ENVIRONMENT = $env:VITE_SENTRY_ENVIRONMENT
  }
  if ($env:VITE_SENTRY_RELEASE -and -not $env:SENTRY_RELEASE) {
    $env:SENTRY_RELEASE = $env:VITE_SENTRY_RELEASE
  }
}

function Mask-Dsn {
  param([string]$Value)
  if (-not $Value) {
    return "sin configurar"
  }
  return ($Value -replace "https://([^@]{6})[^@]*([^@]{4})@", 'https://$1...$2@')
}

Write-Host "Shape Meet Windows demo diagnostics"
Write-Host "Runtime config: $RuntimeConfig"

Assert-Command "node"
Assert-Command "pnpm"
Assert-Command "cargo"
Assert-Command "rustc"
Assert-Command "python"

Import-DotEnv $RuntimeConfig
Set-DemoEnvAliases
if ($InstallRuntimeConfig) {
  Copy-RuntimeConfig $RuntimeConfig
}

Write-Host ""
Write-Host "Runtime"
Write-Host "- API/admin: $env:SHAPE_DEMO_API_URL"
Write-Host "- Reuniones: $env:SHAPE_DEMO_APP_URL"
Write-Host "- IA local: $env:SHAPE_DEMO_AI_URL"
Write-Host "- Sentry: $(Mask-Dsn $env:SENTRY_DSN)"

Invoke-Step "Sentry formato local" { pnpm check:sentry }
if (-not $SkipSentryLive) {
  Invoke-OptionalStep "Sentry live" { pnpm check:sentry:live }
}
Invoke-Step "Doctor desktop" { pnpm desktop:doctor -- --strict }
Invoke-Step "Doctor demo endpoints" { pnpm demo:doctor -- --no-docker --strict }

if (-not $SkipDemoPrepare) {
  Invoke-Step "Datos demo" { pnpm demo:prepare }
}

Invoke-Step "Bundle debug" { pnpm demo:debug -- --output-dir output/windows-debug }

Write-Host ""
Write-Host "Diagnostico Windows listo."
Write-Host "Si Sentry live falla con ProjectId, copia una DSN nueva desde Project Settings > Client Keys."
Write-Host "Si Doctor demo endpoints falla, revisa que admin, meeting web, LiveKit e IA local esten accesibles desde este PC."
`;
}

function readme(report) {
  return `# Shape Meet Windows Demo Handoff

Este paquete existe para construir la app en un PC Windows cuando GitHub Actions
no puede generar artifacts Windows. PyInstaller no hace cross-compile real: el
sidecar debe construirse en Windows para producir el instalador Windows.

## Contenido

- \`shape-meet.env\`: runtime desktop sin secretos de LiveKit/Postgres.
- \`Build-ShapeMeetWindows.ps1\`: build local Windows + handoff.
- \`Test-ShapeMeetWindows.ps1\`: diagnostico de entorno, endpoints, Sentry,
  desktop doctor y bundle debug.
- \`manifest.json\`: resumen de URLs y comandos.

## Runtime

- API/admin: ${report.config.apiUrl}
- Reuniones: ${report.config.meetingUrl}
- IA local: ${report.config.aiUrl}
- Host prellenado: ${report.config.hostIdentifier ?? "sin configurar"}
- Sentry: ${report.config.sentryConfigured ? "configurado" : "sin DSN"}

Si el admin corre en otra maquina de la LAN, genera este paquete con
\`--api-url http://IP_LAN:13000 --meeting-url http://IP_LAN:1420\`.
Para Coolify usa dominios HTTPS públicos.

## Requisitos Windows

- Windows 10/11 x64.
- WebView2 Runtime.
- Node.js 22 + pnpm/corepack.
- Rust stable MSVC toolchain.
- Python 3.11+ en PATH.
- Microsoft Visual Studio Build Tools con Desktop development with C++.

## Build

Desde la raiz del repo en PowerShell:

\`\`\`powershell
Set-ExecutionPolicy -Scope Process Bypass
.\\${relativePath(scriptPath)}
\`\`\`

El script instala \`shape-meet.env\` en \`%LOCALAPPDATA%\\Shape Meet\`, ejecuta
\`pnpm build:desktop\`, valida el bundle y crea un handoff local con copia de
instaladores.

## Diagnostico rapido

Antes o despues del build puedes validar la maquina Windows y generar un bundle
debug:

\`\`\`powershell
Set-ExecutionPolicy -Scope Process Bypass
.\\${relativePath(diagnosticScriptPath)} -InstallRuntimeConfig -SkipSentryLive
\`\`\`

Quita \`-SkipSentryLive\` cuando tengas una DSN que acepte ingesta. Si falla con
\`ProjectId\`, la DSN no corresponde al proyecto/key correcto de Sentry.

## Debug esperado

En el Windows AMD Ryzen sin GPU NVIDIA, la app debe abrir en modo limitado. La
Prueba de equipo debe permitir exportar bundle debug y enviar Evento Sentry. Los
modelos reales seguirán en passthrough hasta usar una RTX 4070+ con runtime de
modelos configurado.
`;
}

function argValue(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function readEnvFile(path) {
  try {
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
  } catch {
    return {};
  }
}

function relativePath(path) {
  const absolute = resolve(path);
  return absolute.startsWith(process.cwd())
    ? absolute.slice(process.cwd().length + 1).replaceAll("/", "\\")
    : path;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, "");
}

function safeTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function trim(value) {
  return String(value ?? "").trim();
}
