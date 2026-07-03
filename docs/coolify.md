# Coolify deployment

Shape Meet usa tres superficies desplegables:

- `shape-admin`: Next.js standalone, Dockerfile en `apps/admin/Dockerfile`, puerto `3000`.
- `shape-postgres`: Postgres 17 para usuarios, hosts, reuniones e identidades.
- `shape-livekit`: LiveKit server con TURN embebido.
- `shape_artifacts_data`: volumen persistente para artefactos de rostros subidos desde el admin.

## Opción recomendada

Crear una app Docker Compose en Coolify usando:

```text
Resource type: Docker Compose
Repository: Luxora-Agency/shape-meet
Branch: main
Compose file: infra/docker-compose.coolify.yml
Build context: repository root
```

No hace falta crear repos adicionales para el admin, Postgres o TURN: el compose
levanta todo el stack en un solo recurso y conserva Postgres, Redis y artefactos
en volumenes nombrados. Si mas adelante separas servicios en recursos Coolify
independientes, mantén los mismos nombres internos (`shape-postgres`,
`shape-redis`, `shape-livekit`) o actualiza `DATABASE_URL` y `LIVEKIT_URL`.

Puertos que Coolify debe conocer:

- `shape-admin`: expone `3000/tcp`.
- `shape-livekit`: expone `7880/tcp` para API/WebSocket.
- `shape-livekit`: publica directamente `7881/tcp`, `7882/udp`, `3478/udp` y
  `5349/tcp` fuera del proxy HTTP.

No definas `NODE_ENV`, `HOST` ni `PORT` para `shape-admin` en Coolify. La imagen
Next standalone ya escucha en `0.0.0.0:3000`; sobrescribir `PORT` puede causar
502 aunque el contenedor haya arrancado.

Para pruebas locales de WebRTC sin tocar puertos de otros proyectos, usa
`infra/docker-compose.livekit.dev.yml`. Ese archivo levanta solo LiveKit en modo
dev (`devkey/secret`) y publica signaling en `ws://localhost:17880`. No sustituye
el despliegue Coolify: producción debe usar `docker-compose.coolify.yml`, dominio
`wss://livekit...` y TURN configurado.

Variables mínimas:

```env
POSTGRES_USER=shape_meet
POSTGRES_PASSWORD=...
POSTGRES_DB=shape_meet
REDIS_PASSWORD=...
AUTH_SESSION_SECRET=...
CORS_ORIGIN=*
RUN_SEED=false
SHAPE_DEBUG_ERRORS=true
HOST_BOOTSTRAP_EMAIL=admin@shape.test
HOST_BOOTSTRAP_PASSWORD=...

LIVEKIT_URL=wss://livekit.tudominio.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_HTTP_PORT=7880
LIVEKIT_TURN_DOMAIN=turn.tudominio.com
LIVEKIT_USE_EXTERNAL_IP=true
LIVEKIT_RTC_TCP_PORT=7881
LIVEKIT_RTC_UDP_PORT=7882
LIVEKIT_TURN_UDP_PORT=3478
LIVEKIT_TURN_TLS_PORT=5349
LIVEKIT_TURN_EXTERNAL_TLS=true
LIVEKIT_TURN_RELAY_RANGE_START=30000
LIVEKIT_TURN_RELAY_RANGE_END=30100

NEXT_PUBLIC_APP_URL=https://admin.tudominio.com
ADMIN_HTTP_PORT=3000
VITE_SHAPE_API_URL=https://admin.tudominio.com
VITE_SHAPE_APP_URL=https://meet.tudominio.com
VITE_SHAPE_MEETING_URL=https://meet.tudominio.com
SHAPE_ARTIFACT_STORAGE_DIR=/app/artifacts
SHAPE_ARTIFACT_MAX_BYTES=2147483648
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_ORG=
SENTRY_PROJECT=
SENTRY_AUTH_TOKEN=
SENTRY_ENVIRONMENT=production
NEXT_PUBLIC_SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=shape-meet-admin@0.1.0
NEXT_PUBLIC_SENTRY_RELEASE=shape-meet-admin@0.1.0
SENTRY_TRACES_SAMPLE_RATE=1.0
NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=1.0
```

Para el primer deploy contra una base vacía, usa `RUN_SEED=true` una sola vez.
Eso crea el admin bootstrap con `HOST_BOOTSTRAP_EMAIL` y
`HOST_BOOTSTRAP_PASSWORD`; después vuelve a `RUN_SEED=false`.
El panel web y las APIs admin requieren sesión con rango `ADMIN`.

Secuencia recomendada para el primer deploy:

1. Crear el recurso Docker Compose con las variables completas.
2. Usar `RUN_SEED=true` solo en el primer arranque.
3. Confirmar `/api/health` en `https://admin.tudominio.com/api/health`.
4. Entrar al panel admin con el bootstrap y crear los hosts reales.
5. Cambiar `RUN_SEED=false` y redeploy.
6. Probar una reunión 1:1 desde dos redes distintas para validar ICE/TURN.

Durante las primeras pruebas deja `SHAPE_DEBUG_ERRORS=true` para que las APIs
devuelvan `requestId`, `code` y detalle técnico controlado cuando fallen. Antes
de entregar a usuarios finales, cámbialo a `false` para conservar solo errores
amigables y el `requestId` de correlación.

El admin inicializa `@sentry/nextjs` para cliente, servidor y edge runtime.
`NEXT_PUBLIC_SENTRY_DSN` activa captura en navegador; `SENTRY_DSN` activa rutas
API/SSR. `SENTRY_ORG`, `SENTRY_PROJECT` y `SENTRY_AUTH_TOKEN` son opcionales y
solo se necesitan si quieres subir source maps desde CI/Coolify.

## Artefactos de identidad

El admin permite registrar una URI externa o subir un archivo. Si se sube un
archivo, el backend lo guarda en `SHAPE_ARTIFACT_STORAGE_DIR`, calcula SHA-256 y
tamaño, y entrega a la desktop una URL temporal firmada. El compose monta ese
directorio en el volumen `shape_artifacts_data`; sin ese volumen, los modelos se
perderían al recrear el contenedor.

Para artefactos muy grandes o entrenamientos externos, sigue siendo válido usar
una URL `https://...` o `s3://...` y registrar checksum/tamaño manualmente.

## Dominios

- Admin: `https://admin.tudominio.com` hacia `shape-admin:3000`.
- LiveKit signaling: `wss://livekit.tudominio.com` hacia `shape-livekit:7880`.
- TURN: `turn.tudominio.com`.

## Puertos LiveKit/TURN

LiveKit requiere puertos UDP/TCP abiertos fuera del proxy HTTP:

- `7880/tcp`: API/WebSocket, normalmente detrás de TLS en Coolify.
- `7881/tcp`: ICE TCP fallback.
- `7882/udp`: ICE UDP mux para medios.
- `3478/udp`: TURN/UDP.
- `5349/tcp`: TURN/TLS si tienes terminación L4 para ese dominio.

LiveKit incluye TURN embebido con autenticación integrada al signaling. Para
TURN/TLS real hay dos rutas válidas:

- `LIVEKIT_TURN_EXTERNAL_TLS=true`: un balanceador/proxy L4 termina TLS para
  `turn.tudominio.com` y reenvía tráfico TCP plano al `LIVEKIT_TURN_TLS_PORT`
  del contenedor. El proxy HTTP normal de Coolify no sustituye esa capa.
- `LIVEKIT_TURN_EXTERNAL_TLS=false`: LiveKit termina TLS directamente y necesita
  certificados montados como archivos (`turn.cert_file` y `turn.key_file` en la
  config). En ese modo, si no hay balanceador delante, el puerto anunciado debe
  ser `443`.

En un único servidor Coolify donde `443/tcp` ya está ocupado por el proxy HTTP,
lo más práctico para pruebas es TURN/UDP `3478/udp` + ICE `7881/tcp`/`7882/udp`
y dejar TURN/TLS en `5349/tcp`. Para redes corporativas estrictas, reserva un
segundo IP o un balanceador L4/SNI para poder anunciar TURN/TLS por `443/tcp`.

Para máxima cobertura, LiveKit recomienda TURN/TLS porque atraviesa mejor
firewalls corporativos. Si no tienes balanceador L4 delante de `turn.tudominio.com`,
el puerto anunciado de TURN/TLS debe ser `443`; en ese caso no puede compartir el
mismo IP:443 con el proxy HTTP normal de Coolify.

Variables para ajustar puertos anunciados y publicados:

```env
LIVEKIT_HTTP_PORT=7880
LIVEKIT_USE_EXTERNAL_IP=true
LIVEKIT_RTC_TCP_PORT=7881
LIVEKIT_RTC_UDP_PORT=7882
LIVEKIT_TURN_UDP_PORT=3478
LIVEKIT_TURN_TLS_PORT=5349
LIVEKIT_TURN_EXTERNAL_TLS=true
LIVEKIT_TURN_RELAY_RANGE_START=30000
LIVEKIT_TURN_RELAY_RANGE_END=30100
```

Si pruebas el compose completo en una máquina que ya tiene servicios en
`3000/tcp` o `7880/tcp`, cambia solo los puertos publicados:

```env
ADMIN_HTTP_PORT=13000
LIVEKIT_HTTP_PORT=17880
```

El tráfico interno entre servicios sigue usando `shape-admin:3000` y
`shape-livekit:7880`.

Para máxima compatibilidad en redes corporativas, usa un dominio separado como
`turn.tudominio.com` y publica TURN/TLS en `443/tcp` con terminación L4. En ese
caso cambia `LIVEKIT_TURN_TLS_PORT=443`.

Checklist de firewall/DNS:

- `admin.tudominio.com` apunta al proxy HTTP de Coolify.
- `livekit.tudominio.com` apunta al proxy HTTP de Coolify y termina TLS para
  `wss://`.
- `turn.tudominio.com` apunta al balanceador L4 o IP pública que recibe TURN.
- Abrir inbound `7881/tcp`, `7882/udp`, `3478/udp`, el puerto configurado para
  TURN/TLS y el rango UDP `LIVEKIT_TURN_RELAY_RANGE_START-END`.
- Si usas `LIVEKIT_USE_EXTERNAL_IP=true`, el host debe poder descubrir/anunciar
  su IP pública; si el servidor está detrás de NAT estricto, configura IP externa
  desde la capa de red antes de abrir pruebas con clientes reales.

Fuentes:

- https://docs.livekit.io/transport/self-hosting/deployment/
- https://docs.livekit.io/transport/self-hosting/ports-firewall/

## Migraciones

El contenedor `shape-admin` ejecuta automáticamente:

```bash
pnpm exec prisma migrate deploy
```

Si `RUN_SEED=true`, también ejecuta `pnpm exec tsx prisma/seed.ts`.
El `DATABASE_URL` apunta al servicio `shape-postgres` del compose.

## Desktop API

La app Tauri consume el backend del admin para login de host, reuniones,
identidades y emisión de tokens LiveKit. En desarrollo usa:

```env
VITE_SHAPE_API_URL=http://localhost:3000
```

En producción debe apuntar al dominio público del admin/API.
`VITE_SHAPE_MEETING_URL` controla los enlaces públicos copiados por hosts; la
desktop entiende `/r/SM-123-456`, `?code=SM-123-456` y códigos pegados
manualmente. Si ese dominio sirve una SPA web, debe tener fallback hacia
`index.html` para que `/r/{codigo}` abra directo en el flujo de invitado.
