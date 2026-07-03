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

## Firma

El workflow macOS usa `--no-sign` por ahora. Para distribución externa hay que
agregar firma/notarización de Apple y firma Windows antes de entregar builds a
clientes. La validación técnica de empaquetado no depende de esas credenciales.

## Sidecar

El paso `sidecar:build` genera:

- `apps/desktop/src-tauri/binaries/shape-ai-sidecar-${targetTriple}`;
- `apps/desktop/src-tauri/binaries/shape-ai-processor-${targetTriple}`;
- `apps/desktop/src-tauri/tauri.sidecar.conf.json`.

Ambos artefactos son locales al runner y están ignorados por git.

Antes de empaquetar, valida el entorno local con:

```bash
pnpm build:ai-sidecar
pnpm desktop:doctor -- --strict
pnpm build:desktop
```

El modo estricto falla si los binarios esperados no existen o están
desactualizados frente a `server.py` / `shape_processor_command.py`.

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
