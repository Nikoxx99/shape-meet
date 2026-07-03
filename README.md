# Shape Meet

Monorepo inicial para Shape Meet:

- `apps/desktop`: app Tauri + React para reuniones, host login, prueba de equipo, ajustes de host y sala activa.
- `apps/admin`: panel Next.js + Prisma para usuarios, rangos de host y tokens LiveKit.
- `packages/shared`: contratos y datos base compartidos.
- `infra`: compose/config para Coolify, Postgres, LiveKit y TURN externo con coturn.

## Desarrollo

Stack local completo con Docker, usando puertos alternos para no chocar con
otros proyectos:

```bash
set -a
source infra/env.local.example
set +a
# macOS + Docker Desktop: publica candidatos ICE con la IP LAN real del host.
export LIVEKIT_NODE_IP="$(ipconfig getifaddr "$(route get default | awk '/interface:/ {print $2}')")"
pnpm check:coolify infra/env.local.example
docker compose -p shape-meet-local -f infra/docker-compose.coolify.yml up -d --build
```

En otra terminal, deja vivo el sidecar:

```bash
python3 apps/ai-sidecar/server.py --port 7851
```

En una tercera terminal, deja viva la desktop web:

```bash
pnpm --filter @shape-meet/desktop dev:vite
```

Prepara datos y valida el demo:

```bash
pnpm demo:prepare
pnpm demo:check
pnpm demo:ui:install
pnpm demo:ui
pnpm check:sentry

SHAPE_SMOKE_API_URL=http://127.0.0.1:13000 \
SHAPE_SMOKE_HOST_IDENTIFIER=admin@shape.test \
SHAPE_SMOKE_HOST_PASSWORD=ChangeMe123! \
pnpm smoke:admin

SHAPE_SMOKE_API_URL=http://127.0.0.1:13000 \
SHAPE_SMOKE_HOST_IDENTIFIER=admin@shape.test \
SHAPE_SMOKE_HOST_PASSWORD=ChangeMe123! \
SHAPE_SMOKE_GUEST_NAME="Smoke Guest" \
SHAPE_SMOKE_GUEST_EMAIL=smoke@example.com \
pnpm smoke:meeting-flow
```

`pnpm demo:prepare` deja el demo local en un estado presentable: limpia datos
locales conocidos de smoke/demo en el contenedor `shape-meet-local`, crea o
publica la identidad `Rostro demo aprobado`, crea una reunión pública
`Demo Shape Meet` y muestra el código/enlace para entrar. Usa `--no-reset` si
quieres conservar reuniones anteriores. El flujo esperado para enseñar es:

1. Host entra en [http://localhost:1420](http://localhost:1420) con
   `admin@shape.test` / `ChangeMe123!`.
2. Host abre la reunión `Demo Shape Meet`, prueba equipo, configura identidad y
   entra.
3. Invitado abre el enlace `/r/SM-...`, escribe nombre visible, entra a sala de
   espera.
4. Host admite al invitado; el invitado pulsa `Entrar a la reunión` y ambos
   quedan conectados por LiveKit.

`pnpm demo:check` verifica admin/API, sidecar IA, Sentry local, prepara datos,
corre el smoke de reunión, valida el contrato IA y vuelve a dejar una reunión
demo limpia lista para enseñar.

`pnpm demo:ui` abre Chromium con cámara/micrófono falsos y recorre la UI real:
invitado por enlace público, sala de espera, login de host, configuración de
host, admisión y entrada de ambos participantes. Requiere que la desktop web
esté viva en `http://localhost:1420` o en `SHAPE_DEMO_APP_URL`. En una máquina
nueva corre primero `pnpm demo:ui:install`.

Para desarrollo rápido por procesos locales:

```bash
pnpm install
docker run -d --name shape-meet-postgres \
  -e POSTGRES_USER=shape_meet \
  -e POSTGRES_PASSWORD=shape_meet \
  -e POSTGRES_DB=shape_meet \
  -p 55433:5432 postgres:17-alpine

DATABASE_URL="postgresql://shape_meet:shape_meet@localhost:55433/shape_meet?schema=public" pnpm --filter @shape-meet/admin prisma:migrate
DATABASE_URL="postgresql://shape_meet:shape_meet@localhost:55433/shape_meet?schema=public" pnpm --filter @shape-meet/admin seed

docker compose -f infra/docker-compose.livekit.dev.yml up -d

DATABASE_URL="postgresql://shape_meet:shape_meet@localhost:55433/shape_meet?schema=public" pnpm dev:admin
python3 apps/ai-sidecar/server.py --port 7851
VITE_SHAPE_API_URL="http://localhost:3000" pnpm dev:desktop
```

El compose de LiveKit local usa modo dev oficial con `devkey/secret`, publica
signaling en `ws://localhost:17880` y deja libres los puertos `7880-7882` por si
otro proyecto ya los usa. Para que el admin emita tokens contra ese servidor,
crea o conserva `apps/admin/.env.local` con:

```env
LIVEKIT_URL=ws://localhost:17880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
DATABASE_URL=postgresql://shape_meet:shape_meet@localhost:55433/shape_meet?schema=public
```

Después de cambiar variables LiveKit, reinicia `pnpm dev:admin`; Next.js no
actualiza `process.env` de rutas API ya cargadas sin reinicio.

El stack Docker de `infra/docker-compose.coolify.yml` usa `LIVEKIT_NODE_IP` para
desarrollo local. Con `LIVEKIT_USE_EXTERNAL_IP=false`, define
`LIVEKIT_NODE_IP` con la IP del host alcanzable desde el navegador/Tauri
local, por ejemplo la IP LAN que devuelve
`ipconfig getifaddr "$(route get default | awk '/interface:/ {print $2}')"` en macOS. Si
se deja vacío, LiveKit puede anunciar la IP interna del contenedor y WebRTC no
completará ICE. En Coolify, mantén `LIVEKIT_USE_EXTERNAL_IP=true` o define
`LIVEKIT_NODE_IP` con la IP pública real del nodo.

El TURN de producción corre como `shape-turn` usando coturn y LiveKit lo anuncia
a los clientes con `rtc.turn_servers`. `LIVEKIT_TURN_SHARED_SECRET` debe ser el
mismo secreto compartido entre ambos servicios, y `LIVEKIT_TURN_EXTERNAL_IP`
debe ser la IP pública real que coturn anunciará para relays. En local usamos
`LIVEKIT_TURN_RELAY_RANGE_START=30000` y `LIVEKIT_TURN_RELAY_RANGE_END=30100`
para evitar abrir el rango completo; en producción ajusta ese rango al volumen
esperado y ábrelo en firewall/Coolify.

Antes de crear o redesplegar el recurso en Coolify, valida el archivo de entorno
real con:

```bash
pnpm coolify:env -- \
  --admin-domain admin.tudominio.com \
  --meeting-domain meet.tudominio.com \
  --livekit-domain livekit.tudominio.com \
  --turn-domain turn.tudominio.com \
  --public-ip IP_PUBLICA_DEL_SERVIDOR \
  --bootstrap-email admin@tudominio.com \
  --out infra/shape-meet.production.env

pnpm check:coolify ruta/a/produccion.env --strict
```

El modo estricto falla si quedan placeholders de secretos y avisa cuando
TURN/TLS necesita un balanceador L4 o un puerto `443/tcp` dedicado.

## Build desktop con sidecar

El build empaquetado genera primero el sidecar Python como binario PyInstaller y
luego Tauri lo incluye como `externalBin`.

```bash
pnpm build:ai-sidecar
pnpm build:desktop
```

`build:ai-sidecar` crea archivos locales ignorados por git:

- `apps/desktop/src-tauri/binaries/shape-ai-sidecar-${targetTriple}`
- `apps/desktop/src-tauri/tauri.sidecar.conf.json`
- `output/ai-sidecar-build/`

PyInstaller no hace cross-compile real. Para Windows hay que ejecutar
`pnpm build:desktop` en Windows o en un runner Windows; para macOS, en macOS. Si
CI necesita fijar el nombre del target, puede definir `TAURI_TARGET_TRIPLE`, pero
debe coincidir con la plataforma real del runner.

Los workflows en `.github/workflows` validan el monorepo y permiten generar
paquetes desktop por plataforma. Ver [desktop-release.md](docs/desktop-release.md).

## Variables

Copia `.env.example` a los entornos de Coolify o a los `.env` locales de cada app según corresponda.

El admin actúa como backend de control para la desktop: autentica hosts, guarda
reuniones, emite tokens LiveKit y expone identidades aprobadas.

La desktop solo precarga usuarios/reuniones/rostros mock cuando corre en modo
desarrollo y `VITE_SHAPE_DEMO_DATA=true`. Para el demo real y producción debe
usar `VITE_SHAPE_DEMO_DATA=false`, `VITE_SHAPE_API_URL` apuntando al admin y
`VITE_SHAPE_MEETING_URL` con el dominio público para copiar enlaces de reunión.
Los enlaces públicos usan `/r/{codigo}`, por ejemplo
`https://meet.tudominio.com/r/SM-123-456`; la desktop también acepta
`?code=SM-123-456`, `shapemeet://r/SM-123-456`, `shape-meet://r/SM-123-456`
y códigos pegados manualmente. El admin Next sirve `/r/{codigo}` como launcher
público para abrir la app instalada o copiar el código.

## Flujo de reuniones

- El invitado busca una reunión pública por código o enlace.
- Antes de recibir token LiveKit, crea una solicitud en
  `/api/meetings/[code]/waiting-room`.
- Las reuniones `INVITE_ONLY` pueden guardar correos invitados para referencia
  del host, pero la entrada pública sigue usando código y nombre; la admisión
  del host es el control operativo antes de emitir token LiveKit.
- El host entra autenticado, ve invitados pendientes en la sala activa y los
  admite con `/api/meetings/[code]/participants/[participantId]/admit`.
- Solo después de `admittedAt` el invitado puede pedir
  `/api/meetings/[code]/join-token` y entrar a la llamada.
- Cuando el host cuelga, la desktop llama `/api/meetings/[code]/end`, marca la
  reunión como `ENDED` y cierra participantes activos.
- Al colgar, la desktop llama `/api/meetings/[code]/leave` para registrar
  `leftAt` de invitados y actualizar el estado de la reunión.

El panel web requiere sesión `ADMIN`. En local, el seed crea
`admin@shape.test` con `ChangeMe123!` si no defines
`HOST_BOOTSTRAP_EMAIL`/`HOST_BOOTSTRAP_PASSWORD`. Desde ese panel se crean
usuarios, se promueven/degradan hosts, se administran identidades aprobadas y se
revisa auditoría.

Las identidades tienen dos estados separados:

- `status`: entrenamiento/disponibilidad/revocación del rostro.
- `deliveryStatus`: publicación del artefacto hacia la desktop.

La desktop solo lista identidades `AVAILABLE` + `PUSHED`. El admin puede crear
un artefacto, dejarlo `READY`, publicarlo con `Push` y retirarlo sin borrar el
registro ni perder auditoría. El artefacto puede ser una URI externa o un
archivo subido desde el panel; en ese caso el backend calcula SHA-256/tamaño y
lo guarda en `SHAPE_ARTIFACT_STORAGE_DIR`.

Para iniciar face swap, la desktop puede refrescar una identidad concreta con
`GET /api/host/identities/[id]/artifact`. Ese endpoint valida que el usuario
sea host/admin, que la identidad esté publicada y devuelve la URL de descarga
actual. En Tauri, `cache_identity_artifact` descarga o copia artefactos
`http(s)`/`file://` a una cache local por identidad y valida `sha256`/tamaño
cuando están definidos. Los artefactos `shape://demo/...` se conservan como
referencias de desarrollo sin descarga.

La desktop consulta `SHAPE_AI_SERVICE_URL` desde Tauri para detectar el sidecar
local de IA. En desarrollo el sidecar liviano responde en `http://127.0.0.1:7851`
y expone el contrato de sesiones y frames que luego usarán FaceFusion/DFM,
BackgroundMattingV2 y vcclient000. En Tauri, la pantalla de prueba puede iniciar
y detener un sidecar gestionado por la app.

Variables del supervisor:

```env
SHAPE_AI_PYTHON=python3
SHAPE_AI_SIDECAR_SCRIPT=
SHAPE_AI_SIDECAR_BIN=
SHAPE_AI_SIDECAR_COMMAND=
SHAPE_IDENTITY_CACHE_DIR=
```

Prioridad: `SHAPE_AI_SIDECAR_COMMAND`, luego `SHAPE_AI_SIDECAR_BIN`, luego
el sidecar empaquetado por Tauri y finalmente `apps/ai-sidecar/server.py`
encontrado desde el repo en desarrollo. Los logs del sidecar gestionado se
escriben en el directorio temporal `shape-meet-debug`.

Smoke del sidecar:

```bash
curl http://127.0.0.1:7851/health
curl -X POST http://127.0.0.1:7851/sessions \
  -H "content-type: application/json" \
  -d '{"meetingCode":"SM-123-456","participantId":"host_1","faceEnabled":true,"backgroundEnabled":true,"backgroundCleanPlateDataUrl":"data:image/jpeg;base64,...","backgroundCleanPlateWidth":1280,"backgroundCleanPlateHeight":720,"voiceEnabled":false}'
```

Smoke del admin/API contra una base ya migrada y sembrada:

```bash
pnpm smoke:admin
pnpm smoke:meeting-flow
```

El primer comando valida `/api/health`, login host/admin y lectura de reuniones
usando el token emitido. También crea/cierra una reunión temporal, crea un
usuario temporal, valida desactivación/reactivación desde el panel admin y
comprueba que los rostros solo se puedan publicar cuando el artefacto tiene
SHA256 y tamaño.
`smoke:meeting-flow` crea una
reunión real, solicita entrada como invitado, verifica el bloqueo antes de
admisión, admite desde host, emite tokens LiveKit para invitado/host y finaliza
la reunión. Si Postgres está corrupto o caído, `smoke:admin` debe fallar en
health con `DATABASE_UNAVAILABLE`.

Smoke del contrato de motores IA externos:

```bash
pnpm smoke:ai-contract
```

Ese comando arranca el sidecar en `adapter-contract`, levanta procesadores mock
para video/audio y verifica que `SHAPE_VIDEO_PROCESSOR_ENDPOINT` y
`SHAPE_AUDIO_PROCESSOR_ENDPOINT` reciban los payloads completos y devuelvan
frames/audio inyectables para la desktop. El payload de video incluye la
calibracion de fondo limpia que requiere BackgroundMattingV2.

El cliente desktop publica tracks `shape-processed-video` y
`shape-processed-audio` en LiveKit. Cuando hay sesión IA, envía frames locales a
`POST /sessions/{id}/frames` y PCM mono `pcm_f32le` a
`POST /sessions/{id}/audio`; por defecto `SHAPE_AI_MODE=development-passthrough`
devuelve el mismo frame/audio y mide el transporte. Si el sidecar o vcclient000
no responden, la desktop cae a cámara o micrófono local sin cambiar la sala.
Los motores reales se activan detrás de `SHAPE_FACE_ENGINE`,
`SHAPE_BACKGROUND_ENGINE` y `SHAPE_VOICE_ENGINE` sin cambiar la UI ni el punto
de publicación WebRTC. Al iniciar sesión IA, la desktop envía al sidecar el
manifiesto de identidad seleccionado: tipo, versión, URI de artefacto, checksum
y tamaño si están disponibles. Si Tauri logró cachear el artefacto, también
envía `identityLocalArtifactPath`; los motores reales deben preferir ese archivo
local antes de intentar resolver la URI original. Para fondo premium, el host
puede capturar un clean plate antes de entrar a la sala; la desktop lo envia al
sidecar como metadata de sesion y el adaptador externo lo recibe junto a cada
frame procesable.

Sentry nativo usa `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` y
`SENTRY_TRACES_SAMPLE_RATE`. El webview React/Vite usa las variables `VITE_*`
equivalentes (`VITE_SENTRY_DSN`, `VITE_SENTRY_ENVIRONMENT`,
`VITE_SENTRY_RELEASE`, `VITE_SENTRY_TRACES_SAMPLE_RATE`). Si no hay DSN, la app
sigue funcionando y el panel de prueba muestra que solo está activo el debug
local.

En Tauri, la prueba de equipo consulta `nvidia-smi` y muestra GPU, VRAM, CUDA y
driver. En un Windows sin GPU NVIDIA compatible debe quedar en modo limitado,
pero la app debe abrir, exportar debug bundle y permitir validar UI/API. El
umbral operativo actual para modelos en vivo es 8 GB de VRAM; el objetivo
premium para face swap + fondo + voz es 24 GB.

El panel admin Next.js usa `@sentry/nextjs` en cliente, servidor y edge runtime.
Para el cliente usa `NEXT_PUBLIC_SENTRY_DSN`; para rutas API/SSR usa
`SENTRY_DSN`. `SENTRY_ORG`, `SENTRY_PROJECT` y `SENTRY_AUTH_TOKEN` quedan
reservadas para subir source maps cuando configuremos CI/release con Sentry.
El sidecar Python también usa `SENTRY_DSN` cuando el binario incluye
`sentry-sdk`; solo reporta errores y tags técnicos, no medios ni modelos.

`SHAPE_DEBUG_ERRORS=true` hace que las APIs admin devuelvan `requestId`, `code`
y detalle técnico controlado ante errores inesperados. Úsalo en pruebas
tempranas; en producción final déjalo en `false` para mostrar solo mensajes
amigables y el `requestId`.
