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

Desde GitHub Actions:

1. Abrir `Desktop Packages`.
2. Ejecutar `Run workflow`, o crear un tag `desktop-v0.1.0`.
3. Descargar los artifacts `shape-meet-windows-x64`,
   `shape-meet-macos-arm64` y `shape-meet-macos-x64`.

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

## Firma

El workflow macOS usa `--no-sign` por ahora. Para distribución externa hay que
agregar firma/notarización de Apple y firma Windows antes de entregar builds a
clientes. La validación técnica de empaquetado no depende de esas credenciales.

## Sidecar

El paso `sidecar:build` genera:

- `apps/desktop/src-tauri/binaries/shape-ai-sidecar-${targetTriple}`;
- `apps/desktop/src-tauri/binaries/shape-ai-processor-${targetTriple}`;
- `apps/desktop/src-tauri/resources/ai-wrappers/`;
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

Clasificación inicial:

- `ready`: GPU NVIDIA con al menos 8 GB de VRAM.
- `limited`: UI/debug operativo, pero sin garantía para modelos en vivo.
- `unsupported`: plataforma sin ruta GPU local validada.
