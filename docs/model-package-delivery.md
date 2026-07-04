# Shape Meet model package delivery

Fecha: 2026-07-04

Este documento fija la decision operativa para entregar modelos reales a hosts
de Shape Meet sin mezclar responsabilidades entre la app Tauri, el admin y los
motores de IA.

## Decision corta

Si: conviene tener un repositorio de paquetes descargables, y GitHub Releases
puede servir para la primera etapa. Pero la fuente de verdad no debe ser "lo que
la app encuentre en GitHub"; debe ser el admin de Shape Meet.

El flujo correcto es:

1. El equipo de operacion entrena o prepara los assets de una identidad.
2. El paquete se sube a un storage versionado: GitHub Releases, S3/R2 u otro
   bucket.
3. El admin registra esa version, SHA-256, tamano, motor compatible y host
   asignado.
4. La desktop lista solo las identidades asignadas al host autenticado.
5. Tauri descarga unicamente el artefacto autorizado, valida hash/tamano y lo
   cachea localmente.
6. El sidecar recibe la ruta local validada y activa rostro, voz y fondo segun
   el manifest.

GitHub es suficiente para piloto interno si los assets no son sensibles o si se
usa un repositorio privado mediado por backend. Para clientes reales, el modelo
de permisos debe vivir en el admin/API, no en tokens embebidos en la desktop.

## Separacion de modelos

No todos los motores esperan los mismos archivos:

| Area                            | Archivos esperados                                                        | Pertenece a                            | Comentario                                                           |
| ------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| Voz vcclient000 / w-okada / RVC | `.pth`, `.index`, opcionalmente config/metadatos                          | Identidad de voz del host              | Estos archivos no sirven para FaceFusion. Son pesos e indice de voz. |
| FaceFusion/InSwapper-like       | Foto fuente (`.jpg`, `.png`) o asset facial soportado por el motor        | Identidad facial del host              | El wrapper actual usa `--source-paths` con una identidad local.      |
| DFM/DeepFaceLive futuro         | Package entrenado del motor, por ejemplo `.dfm` u otro formato especifico | Identidad facial entrenada             | Requiere decision legal/licencia antes de distribuir.                |
| BackgroundMattingV2             | Checkpoint base `.pth` del modelo y clean plate local                     | Runtime base, no identidad del cliente | El clean plate se captura en la desktop antes de entrar a llamada.   |
| Fondos visuales                 | Imagenes/video de fondo, LUTs o presets                                   | Assets opcionales del host o marca     | No reemplazan el checkpoint BMV2.                                    |

La conclusion practica para la duda actual: los `.pth` y `.index` que ya tienes
entrenados para vcclient pertenecen al package de voz. El cambiador de rostros
no deberia intentar leerlos. Para rostro hay que entregar foto fuente o el
formato propio del motor facial final.

## Estado actual en el repo

Ya existe parte importante del canal:

- `HostIdentity` en Prisma guarda `kind`, `status`, `version`, `artifactUri`,
  `artifactSha256`, `artifactSizeBytes`, `deliveryStatus` y `publishedAt`.
- `/api/host/identities` lista identidades disponibles para el host.
- `/api/host/identities/[id]/artifact` entrega un artifact/download URL para el
  host autenticado.
- Tauri expone `cache_identity_artifact` en Rust.
- `cacheIdentityArtifact` descarga `http(s)`, copia `file://` o ignora
  `shape://demo`.
- La cache valida SHA-256 y tamano antes de pasar `identityLocalArtifactPath` al
  sidecar.
- La desktop inicia la sesion IA con `identityLocalArtifactPath`,
  `identityArtifactSha256` y toggles de rostro/voz/fondo.

Lo que falta para paquetes reales es pasar de "un artefacto generico" a "un
package con manifest interno".

## Manifest recomendado

Cada paquete deberia ser un `.zip` o `.tar.zst` con un manifest en la raiz:

```json
{
  "schemaVersion": 1,
  "packageId": "identity-nicolas-exec",
  "packageVersion": "2026.07.04.1",
  "assignedIdentityId": "cuid-host-identity",
  "displayName": "Nicolas - Executive",
  "engines": {
    "face": {
      "kind": "facefusion_source",
      "entry": "face/source.jpg",
      "sha256": "..."
    },
    "voice": {
      "kind": "vcclient000_rvc",
      "model": "voice/model.pth",
      "index": "voice/model.index",
      "config": "voice/config.json",
      "sha256": {
        "model": "...",
        "index": "..."
      }
    },
    "background": {
      "kind": "assets",
      "presets": ["backgrounds/office.jpg"]
    }
  },
  "runtimeRequirements": {
    "windows": true,
    "cuda": true,
    "minVramMb": 8192,
    "recommendedVramMb": 24576
  },
  "license": {
    "commercialUseApproved": false,
    "notes": "No distribuir face swap basado en InSwapper sin licencia."
  }
}
```

Reglas:

- El hash del package completo se registra en admin.
- Los hashes internos protegen contra packages mal armados o manipulados.
- `assignedIdentityId` debe coincidir con la identidad autorizada por el admin.
- El package no debe incluir secretos, tokens ni credenciales.
- La app solo activa engines presentes y compatibles con el runtime local.

## GitHub Releases como storage inicial

GitHub Releases funciona bien para publicar assets versionados y obtener URLs de
descarga de release assets. Para una primera etapa:

- crear un repo privado o publico tipo `shape-meet-model-packages`;
- publicar releases por identidad o por lote: `models-2026-07-04`;
- subir assets con nombres estables:
  `identity-nicolas-exec-2026.07.04.1.zip`;
- registrar en admin `downloadUrl`, `sha256`, `sizeBytes`, `packageVersion` y
  motor requerido;
- nunca embebir un token GitHub en la app Tauri.

Si el repo es privado, el backend debe actuar como mediador: valida al host y
entrega una URL temporal o descarga/streaming desde el servidor. Si los assets
son publicos, Tauri puede descargar directo, pero aun debe validar SHA-256 y
version contra el admin.

Tauri updater debe quedar separado: sirve para actualizar la app firmada. Los
modelos son datos de runtime y necesitan su propio manifest, cache y revocacion.

## UX de descarga y activacion

Estados recomendados para la desktop:

| Estado              | Texto visible            | Accion                                                      |
| ------------------- | ------------------------ | ----------------------------------------------------------- |
| `assigned`          | Identidad asignada       | Mostrar en selector, sin activar aun.                       |
| `download_required` | Descargar identidad      | Boton primario antes de preflight o al activar.             |
| `downloading`       | Descargando identidad    | Progreso por MB, opcion cancelar.                           |
| `ready`             | Lista para usar          | Permitir toggles de rostro/voz/fondo.                       |
| `update_available`  | Actualizacion disponible | Descargar version nueva sin borrar la activa hasta validar. |
| `runtime_missing`   | Runtime IA incompleto    | Mostrar diagnostico de FaceFusion/BMV2/vcclient000.         |
| `checksum_failed`   | Descarga no valida       | Bloquear activacion y permitir reintentar.                  |
| `revoked`           | Identidad retirada       | Evictar cache local y ocultar de seleccion activa.          |

La pantalla no debe hablar de "GitHub", "zip", "pth" o "index" al host final
salvo en diagnostico. El host deberia ver: identidad, rostro, voz, fondo,
descargar, activar, probar y entrar.

## Cambios tecnicos pendientes

Prioridad alta:

- agregar metadata de package al admin o extender `HostIdentity` con un JSON
  controlado;
- definir el manifest y validarlo al subir artefactos;
- descomprimir packages en cache segura de Tauri;
- pasar al sidecar rutas separadas: `faceSourcePath`, `voiceModelPath`,
  `voiceIndexPath`, `backgroundAssetsPath`;
- adaptar `vcclient000_chunk.py` o el endpoint persistente para seleccionar la
  voz entrenada por package;
- mantener BackgroundMattingV2 como runtime base instalado una vez, no como
  modelo por cliente.

Prioridad media:

- soportar actualizaciones atomicas de package: descargar a carpeta temporal,
  validar, activar symlink/carpeta current;
- implementar revocacion local cuando el admin retire una identidad;
- registrar version activa en debug bundle;
- agregar smoke con un package fixture pequeno.

## Checklist de aceptacion

- El admin muestra una identidad asignada a un host con version y estado.
- La desktop autentica host y lista solo sus identidades disponibles.
- Al activar rostro o voz, Tauri descarga/cachea el package con SHA-256 valido.
- El sidecar recibe rutas locales separadas y no URLs remotas.
- FaceFusion usa foto/asset facial; vcclient usa `.pth`/`.index`.
- BackgroundMattingV2 usa checkpoint base y clean plate local.
- Un invitado web recibe tracks `shape-processed-video` y
  `shape-processed-audio` desde LiveKit.
- La app no declara "identidad activa" solo por publicar un track; exige ultimo
  frame/audio `processed`, procesador real y sin fallback/passthrough.
- Si falla hash, runtime o licencia, la app no activa el modelo y muestra
  soporte accionable.
