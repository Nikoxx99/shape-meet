# Shape Meet AI Sidecar

Servicio local que expone el contrato de IA para la app Tauri.

En desarrollo corre sin dependencias externas:

```bash
python3 apps/ai-sidecar/server.py --port 7851
```

Dentro de Tauri, la pantalla de prueba de equipo puede iniciar este proceso
automáticamente. Define `SHAPE_AI_SIDECAR_COMMAND` para usar un comando completo,
`SHAPE_AI_SIDECAR_BIN` para un binario empaquetado o `SHAPE_AI_SIDECAR_SCRIPT`
para apuntar a este archivo explícitamente.

## Empaquetado

Para builds de escritorio, el repo crea un binario local con PyInstaller y Tauri
lo empaqueta como sidecar:

```bash
pnpm build:ai-sidecar
pnpm build:desktop
```

El script genera `apps/desktop/src-tauri/binaries/shape-ai-sidecar-${targetTriple}`
y `apps/desktop/src-tauri/tauri.sidecar.conf.json`. Ambos son artefactos locales:
se regeneran en cada máquina o runner y no se versionan.

PyInstaller debe correr en el sistema operativo de destino. Windows requiere un
runner Windows; macOS requiere un runner macOS.

Endpoints:

- `GET /health`: estado general y pipelines disponibles.
- `GET /diagnostics`: GPU, plataforma, motores configurados y límites de payload.
- `GET /pipelines`: lista de pipelines declarados.
- `POST /sessions`: inicia una sesión local de IA para una reunión/participante.
- `GET /sessions/{id}`: consulta métricas y estado de la sesión.
- `POST /sessions/{id}/frames`: recibe un frame codificado como data URL y devuelve el frame procesado.
- `POST /sessions/{id}/audio`: recibe un chunk de audio codificado en base64 y devuelve el chunk procesado.
- `DELETE /sessions/{id}`: detiene la sesión local.

Este sidecar es el punto de integración para:

- Face swap: ruta FaceFusion/Deep-Live-Cam/InSwapper y futura ruta DFM entrenada.
- Fondo: BackgroundMattingV2.
- Voz: vcclient000.

Los modelos reales se conectan detrás de este contrato sin cambiar la UI ni los
comandos Tauri.

Variables de motor:

```bash
SENTRY_DSN=
SENTRY_ENVIRONMENT=development
SENTRY_RELEASE=shape-ai-sidecar@0.1.0
SENTRY_TRACES_SAMPLE_RATE=1.0
SHAPE_AI_MODE=development-passthrough
SHAPE_FACE_ENGINE=facefusion
SHAPE_BACKGROUND_ENGINE=backgroundmattingv2
SHAPE_VOICE_ENGINE=vcclient000
SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:7860/process-frame
SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:7861/process-audio
SHAPE_PROCESSOR_TIMEOUT_SECS=0.8
```

`development-passthrough` valida el transporte de frames sin cargar modelos. Los
adaptadores reales deben conservar el mismo contrato de entrada/salida para que
la publicación LiveKit no cambie.

Si `SENTRY_DSN` está configurado y `sentry-sdk` está instalado, el sidecar envía
errores de adaptadores externos con tags de runtime. No envía frames, audio,
imagenes fuente ni artefactos de modelos.

`SHAPE_VIDEO_PROCESSOR_ENDPOINT` permite conectar un proceso externo que aplique
face swap y background matting. Recibe `{ session, frame, identity, background,
enabled, target }` y debe devolver `{ frame: { sequence, status, processor,
frame, metrics, warnings } }`. `background.cleanPlate.dataUrl` contiene la
captura limpia que BackgroundMattingV2 debe usar como referencia.

`SHAPE_AUDIO_PROCESSOR_ENDPOINT` hace lo mismo para voz/vcclient000. Recibe
`{ session, audio, identity, enabled }` y debe devolver `{ audio: { sequence,
status, processor, audio, metrics, warnings } }`.

La desktop envía PCM mono `pcm_f32le` al endpoint `/audio`, decodifica el audio
devuelto y lo inyecta en el track WebRTC `shape-processed-audio`. Si el sidecar,
vcclient000 o el formato de respuesta fallan, el mismo pipeline vuelve a
passthrough local del micrófono sin cambiar LiveKit.

Smoke automatizado del contrato de adaptadores:

```bash
pnpm smoke:ai-contract
```

El script arranca el sidecar en un puerto libre, levanta mocks HTTP para video y
audio, y valida que los payloads enviados a `SHAPE_VIDEO_PROCESSOR_ENDPOINT` y
`SHAPE_AUDIO_PROCESSOR_ENDPOINT` incluyan sesión, identidad, clean plate de
fondo, flags activos y datos procesables.

Ejemplo:

```bash
curl -X POST http://127.0.0.1:7851/sessions \
  -H "content-type: application/json" \
  -d '{
    "meetingCode": "SM-123-456",
    "participantId": "host_1",
    "identityId": "identity_demo",
    "identityKind": "TRAINED_IDENTITY",
    "identityVersion": "v2.1.0",
    "identityArtifactUri": "shape://artifacts/founder.dfm",
    "identityCachedArtifactUri": "shape://artifacts/founder.dfm",
    "identityLocalArtifactPath": "/Users/name/Library/Application Support/Shape Meet/identities/identity_demo/founder.dfm",
    "identityArtifactSha256": "012345...",
    "identityArtifactSizeBytes": 104857600,
    "identityArtifactCacheMessage": "Artefacto cacheado y validado localmente.",
    "faceEnabled": true,
    "backgroundEnabled": true,
    "backgroundCleanPlateDataUrl": "data:image/jpeg;base64,...",
    "backgroundCleanPlateCapturedAt": "2026-07-02T15:00:00.000Z",
    "backgroundCleanPlateWidth": 1280,
    "backgroundCleanPlateHeight": 720,
    "backgroundCleanPlateCameraDeviceId": "camera_1",
    "voiceEnabled": false,
    "targetWidth": 1280,
    "targetHeight": 720,
    "targetFps": 30
  }'
```

Procesar un frame:

```bash
curl -X POST http://127.0.0.1:7851/sessions/ai_xxx/frames \
  -H "content-type: application/json" \
  -d '{
    "sequence": 1,
    "timestampMs": 1783019916000,
    "width": 1280,
    "height": 720,
    "frameDataUrl": "data:image/jpeg;base64,...",
    "effects": { "face": true, "background": true, "voice": false }
  }'
```

Procesar audio:

```bash
curl -X POST http://127.0.0.1:7851/sessions/ai_xxx/audio \
  -H "content-type: application/json" \
  -d '{
    "sequence": 1,
    "timestampMs": 1783019916000,
    "sampleRate": 48000,
    "channels": 1,
    "format": "pcm_f32le",
    "audioDataBase64": "AAAA"
  }'
```
