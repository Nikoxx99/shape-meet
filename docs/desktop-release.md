# Desktop release

Shape Meet genera el sidecar de IA en el mismo sistema operativo que empaqueta
Tauri. Esto es intencional: PyInstaller no hace cross-compile real, y el binario
del sidecar debe coincidir con el runner donde se crea el bundle.

## Workflows

- `.github/workflows/ci.yml`: valida el monorepo en Ubuntu, incluyendo
  typecheck, builds web, `cargo check`, sintaxis del sidecar, smoke de
  PyInstaller y parseo del compose de Coolify.
- `.github/workflows/desktop-packages.yml`: workflow manual o por tag
  `desktop-v*` para generar paquetes de Windows y macOS.

Targets iniciales:

- Windows x64: `windows-latest`.
- macOS Apple Silicon: `macos-26`.
- macOS Intel: `macos-26-intel`.

## Ejecutar release

Antes de lanzar una build, valida que la automatización de paquetes sigue
generando todos los artifacts esperados:

```bash
pnpm desktop:workflow:check
```

Para revisar el último run manual/tag desde una máquina con `gh` autenticado:

```bash
pnpm desktop:workflow:check -- --latest
```

Para preparar un paquete de entrega con manifest y README del último run exitoso:

```bash
pnpm desktop:handoff
```

El handoff exige que el run exitoso corresponda al commit actual. Si necesitas
documentar una prueba con artifacts viejos, usa `-- --allow-stale` y deja
registrado el commit del run en el manifest.

Si quieres bajar los artifacts al mismo directorio:

```bash
pnpm desktop:handoff -- --download
```

El handoff queda en `output/desktop-handoff/run-{id}` e incluye
`manifest.json`, `README.md` y, con `--download`, una carpeta `artifacts/`.

Si `Desktop Packages` está bloqueado, fallando o quedó stale frente a `HEAD`,
puedes entregar una build local de la plataforma actual:

```bash
pnpm build:desktop
pnpm desktop:bundle:check
pnpm desktop:handoff -- --local-bundle
```

Ese modo crea `output/desktop-handoff/local-{commit}` con manifest y README del
bundle en `apps/desktop/src-tauri/target/release/bundle`. Agrega
`-- --local-bundle --copy-local` si quieres copiar los instaladores al directorio
de handoff.

Cuando GitHub Actions esté bloqueado por billing o no haya runner Windows
disponible, prepara un handoff manual para el PC Windows:

```bash
pnpm desktop:windows-handoff -- \
  --api-url https://admin.tudominio.com \
  --meeting-url https://meet.tudominio.com \
  --ai-url http://127.0.0.1:7851 \
  --host-identifier host@tudominio.com \
  --sentry-dsn "https://..."
```

El paquete queda en `output/windows-demo-handoff/...` e incluye
`Build-ShapeMeetWindows.ps1` y `shape-meet.env`. En Windows, desde la raiz del
repo, ejecuta ese PowerShell para instalar el runtime config local, construir el
sidecar Windows, generar el instalador Tauri y producir
`desktop:handoff --local-bundle --copy-local`.

Desde GitHub Actions:

1. Abrir `Desktop Packages`.
2. Ejecutar `Run workflow`, o crear un tag `desktop-v0.1.0`.
3. Descargar los artifacts `shape-meet-windows-x64`,
   `shape-meet-macos-arm64`, `shape-meet-macos-x64` y
   `shape-meet-runtime-config`.

`shape-meet-runtime-config` contiene un `shape-meet.env` sin secretos. El
workflow también lo descarga dentro de cada job de paquete y lo embebe como
recurso Tauri, así que una app instalada desde esos artifacts ya arranca con las
URLs del entorno demo. Para una demo local apunta por defecto a
`http://localhost:13000`, `http://localhost:1420` y `http://127.0.0.1:7851`;
edítalo o regenéralo con `pnpm desktop:config` para apuntar a Coolify antes de
entregarlo a otra máquina.

Para un handoff remoto, llena los inputs del workflow manual:

- `admin_url`: URL pública del admin/API en Coolify.
- `meeting_url`: URL pública de reuniones.
- `ai_url`: normalmente `http://127.0.0.1:7851`, porque el sidecar IA corre
  local en la workstation.
- `host_identifier`: correo del host autorizado que aparecerá prellenado.
- `sentry_dsn`, `sentry_environment`, `sentry_release`,
  `sentry_traces_sample_rate`, `sentry_debug`: debug desktop.

Los mismos valores pueden quedar como GitHub repository variables para builds
por tag:

```env
DESKTOP_SHAPE_API_URL=https://admin.tudominio.com
DESKTOP_SHAPE_MEETING_URL=https://meet.tudominio.com
DESKTOP_SHAPE_AI_SERVICE_URL=http://127.0.0.1:7851
DESKTOP_SHAPE_HOST_IDENTIFIER=host@tudominio.com
DESKTOP_SENTRY_DSN=https://...
DESKTOP_SENTRY_ENVIRONMENT=internal-debug
DESKTOP_SENTRY_RELEASE=shape-meet-desktop@0.1.0
DESKTOP_SENTRY_TRACES_SAMPLE_RATE=1.0
DESKTOP_SENTRY_DEBUG=false
```

Si prefieres guardar el DSN como secret, usa `DESKTOP_SENTRY_DSN`. No agregues
tokens de Sentry, secretos de LiveKit ni credenciales de Postgres al runtime
desktop.

## Enlaces de reunión

El bundle desktop registra los esquemas `shapemeet://` y `shape-meet://`.
La app resuelve códigos desde enlaces web `/r/SM-123-456`, query
`?code=SM-123-456`, enlaces nativos `shapemeet://r/SM-123-456` y códigos
pegados manualmente. En Windows/Linux, `single-instance` evita que un deep link
abra una segunda ventana cuando la app ya está corriendo.

## Configuración runtime

El build desktop puede apuntar a un entorno Coolify sin recompilar creando un
archivo `shape-meet.env` en el directorio de datos de la app:

- Windows: `%LOCALAPPDATA%\Shape Meet\shape-meet.env`
- macOS: `~/Library/Application Support/Shape Meet/shape-meet.env`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/shape-meet/shape-meet.env`

También se puede fijar una ruta explícita con `SHAPE_DESKTOP_CONFIG_FILE`.
Variables útiles para demo remoto:

```env
VITE_SHAPE_API_URL=https://admin.tudominio.com
VITE_SHAPE_APP_URL=https://meet.tudominio.com
VITE_SHAPE_MEETING_URL=https://meet.tudominio.com
VITE_SHAPE_AI_SERVICE_URL=http://127.0.0.1:7851
VITE_SHAPE_HOST_IDENTIFIER=host@tudominio.com
VITE_SENTRY_DSN=https://...
SENTRY_DSN=https://...
SENTRY_ENVIRONMENT=internal-debug
VITE_SENTRY_ENVIRONMENT=internal-debug
```

La desktop usa esta configuración para API, enlaces públicos, sidecar IA local,
Sentry nativo y debug bundles. Si el archivo no existe, conserva los valores
compilados por Vite y los defaults locales.

Para generarlo desde el env de Coolify sin copiar secretos del servidor:

```bash
pnpm desktop:config -- \
  --env-file infra/shape-meet.production.env \
  --ai-url http://127.0.0.1:7851 \
  --out output/shape-meet.env
```

Usa `--install` para escribirlo directamente en el directorio de datos de la app
del equipo actual.

## Firma

El workflow macOS usa `--no-sign` por ahora. Para distribución externa hay que
agregar firma/notarización de Apple y firma Windows antes de entregar builds a
clientes. La validación técnica de empaquetado no depende de esas credenciales.

## Sidecar

El paso `sidecar:build` genera:

- `apps/desktop/src-tauri/binaries/shape-ai-sidecar-${targetTriple}`;
- `apps/desktop/src-tauri/binaries/shape-ai-processor-${targetTriple}`;
- `apps/desktop/src-tauri/resources/ai-wrappers/`;
- `apps/desktop/src-tauri/resources/shape-meet.env`;
- `apps/desktop/src-tauri/tauri.sidecar.conf.json`.

Ambos artefactos son locales al runner y están ignorados por git.

Antes de empaquetar, valida el entorno local con:

```bash
pnpm build:ai-sidecar
pnpm desktop:doctor -- --strict
pnpm build:desktop
pnpm desktop:bundle:check
```

El modo estricto falla si los binarios esperados no existen o están
desactualizados frente a `server.py` / `shape_processor_command.py`.
`desktop:bundle:check` valida el bundle ya generado. En macOS confirma `.app`,
`.dmg`, `shape-ai-sidecar`, `shape-ai-processor`, wrappers IA y esquemas
`shapemeet://` / `shape-meet://`; en Windows confirma ejecutables, wrappers IA
y un instalador en `target/release/bundle`.

## Debug de hardware

El comando nativo `get_gpu_profile` consulta `nvidia-smi` desde Tauri. En
Windows prueba rutas comunes como `nvidia-smi.exe`,
`C:\Windows\System32\nvidia-smi.exe` y
`C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe`. La pantalla de
prueba de equipo muestra nombre de GPU, VRAM, CUDA y driver; el debug bundle
incluye el mismo resumen sin enviar video/audio ni artefactos.
También incluye `aiRuntimeDoctor`, con perfil de workstation, estado de
passthrough, checks de FaceFusion/BackgroundMattingV2/vcclient000 y siguientes
pasos sin volcar el contenido crudo del archivo env.

Clasificación inicial:

- `ready`: GPU NVIDIA con al menos 8 GB de VRAM.
- `limited`: UI/debug operativo, pero sin garantía para modelos en vivo.
- `unsupported`: plataforma sin ruta GPU local validada.
