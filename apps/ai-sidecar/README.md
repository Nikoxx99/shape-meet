# Shape Meet AI Sidecar

Servicio local que expone el contrato de IA para la app Tauri.

En desarrollo corre sin dependencias externas:

```bash
python3 apps/ai-sidecar/server.py --port 7851
```

Para enseñar el demo local con procesadores visuales sin modelos reales:

```bash
pnpm dev:ai:demo
```

Si hay `SENTRY_DSN` local y no defines `SHAPE_AI_PYTHON`, ese runner prepara un
venv liviano en `output/ai-sidecar-dev/venv` con `sentry-sdk`. Usa
`SHAPE_AI_DEV_VENV=false` para desactivarlo o `SHAPE_AI_PYTHON=/ruta/python`
para forzar un entorno propio.

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
y `apps/desktop/src-tauri/binaries/shape-ai-processor-${targetTriple}`, además de
`apps/desktop/src-tauri/tauri.sidecar.conf.json`. Son artefactos locales: se
regeneran en cada máquina o runner y no se versionan.

PyInstaller debe correr en el sistema operativo de destino. Windows requiere un
runner Windows; macOS requiere un runner macOS.

Endpoints:

- `GET /health`: estado general y pipelines disponibles.
- `GET /diagnostics`: GPU, plataforma, motores configurados y límites de payload.
- `GET /pipelines`: lista de pipelines declarados.
- `POST /preflight`: ejecuta una prueba sintética de video/audio con la misma
  configuración de una sesión, sin dejar una sesión persistente.
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
SHAPE_VIDEO_PROCESSOR_COMMAND=
SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:7860/process-frame
SHAPE_VIDEO_PROCESSOR_HEALTH_URL=http://127.0.0.1:7860/health
SHAPE_VIDEO_FRAME_COMMAND=
SHAPE_FACE_COMMAND=
SHAPE_BACKGROUND_COMMAND=
SHAPE_AUDIO_PROCESSOR_COMMAND=
SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:7861/process-audio
SHAPE_AUDIO_PROCESSOR_HEALTH_URL=http://127.0.0.1:7861/health
SHAPE_AUDIO_CHUNK_COMMAND=
SHAPE_VOICE_COMMAND=
VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18888/test
VCCLIENT000_HTTP_MODE=w-okada-rest
SHAPE_PROCESSOR_DEMO_EFFECTS=false
SHAPE_MODEL_COMMAND_TIMEOUT_SECS=30
SHAPE_PROCESSOR_TIMEOUT_SECS=75
```

`development-passthrough` valida el transporte de frames sin cargar modelos. Los
adaptadores reales deben conservar el mismo contrato de entrada/salida para que
la publicación LiveKit no cambie.

Si `SHAPE_VIDEO_PROCESSOR_COMMAND` o `SHAPE_AUDIO_PROCESSOR_COMMAND` están
configurados, el sidecar inicia esos procesos como hijos y les inyecta:

- `SHAPE_PROCESSOR_KIND`: `video` o `audio`;
- `SHAPE_PROCESSOR_ENDPOINT`: endpoint HTTP que debe exponer el proceso;
- `SHAPE_PROCESSOR_PORT`: puerto derivado del endpoint;
- la variable específica `SHAPE_VIDEO_PROCESSOR_PORT` o
  `SHAPE_AUDIO_PROCESSOR_PORT`.

Esto permite reemplazar los mocks por wrappers locales de
FaceFusion/BackgroundMattingV2 y vcclient000 sin cambiar el contrato de la
desktop. Si no defines endpoint, el sidecar usa
`http://127.0.0.1:7860/process-frame` para video y
`http://127.0.0.1:7861/process-audio` para audio.

El repo incluye un adaptador HTTP de comandos para conectar motores locales sin
crear otro servidor:

```bash
SHAPE_VIDEO_PROCESSOR_COMMAND="python3 apps/ai-sidecar/processors/shape_processor_command.py --kind video --port 7860"

# Opcion A: wrapper combinado para face swap + fondo.
SHAPE_VIDEO_FRAME_COMMAND="/path/to/video-wrapper --input {input} --output {output} --identity {identity} --clean-plate {clean_plate}"

# Opcion B: wrappers separados, ejecutados en cadena segun efectos activos.
SHAPE_FACE_COMMAND="/path/to/facefusion-wrapper --input {input} --output {output} --identity {identity}"
SHAPE_BACKGROUND_COMMAND="/path/to/backgroundmattingv2-wrapper --input {input} --output {output} --clean-plate {clean_plate}"

SHAPE_AUDIO_PROCESSOR_COMMAND="python3 apps/ai-sidecar/processors/shape_processor_command.py --kind audio --port 7861"
SHAPE_AUDIO_CHUNK_COMMAND="/path/to/voice-wrapper --input {input} --output {output} --sample-rate {sample_rate}"
SHAPE_VOICE_COMMAND="/path/to/vcclient000-wrapper --input {input} --output {output} --sample-rate {sample_rate}"
```

`SHAPE_VIDEO_FRAME_COMMAND` y `SHAPE_AUDIO_CHUNK_COMMAND` tienen prioridad
porque representan wrappers combinados. Si los dejas vacios, el adaptador usa
`SHAPE_FACE_COMMAND`, `SHAPE_BACKGROUND_COMMAND` y `SHAPE_VOICE_COMMAND` segun
los efectos activos en la reunion.

Para demo sin modelos reales, `SHAPE_PROCESSOR_DEMO_EFFECTS=true` hace que el
procesador empaquetable devuelva un SVG con una capa visible sobre el frame y
audio passthrough marcado como procesado. Genera el archivo runtime con:

```bash
pnpm demo:ai-runtime
```

Ese modo prueba sidecar, procesos gestionados, endpoints y publicación WebRTC;
no reemplaza la integración final de modelos.

Para wrappers reales, genera el mismo archivo runtime con:

```bash
pnpm models:runtime -- --preset local-wrappers --passthrough
pnpm models:doctor -- --skip-hardware
```

Ese modo valida el contrato completo en cualquier PC: levanta los procesadores
locales, invoca los wrappers versionados y copia input a output cuando los
modelos no están instalados. Para activar modelos reales en la estación
Windows/NVIDIA del demo, usa el perfil estricto:

```bash
pnpm models:bootstrap -- --profile windows-nvidia --dry-run --write-checklist --write-setup-script
pnpm models:bootstrap -- --profile windows-nvidia --write-runtime --strict --write-checklist
```

Ese perfil asume `C:\models\FaceFusion`,
`C:\models\BackgroundMattingV2`, el checkpoint
`C:\models\BackgroundMattingV2\pytorch_resnet50.pth` y VCClient REST en
`http://127.0.0.1:18888/test`. Ese endpoint usa el REST oficial de
w-okada/VCClient (`POST /test`) y el wrapper convierte entre el `pcm_f32le` de
Shape Meet y el `pcm_s16le` que espera VCClient.
El runtime generado usa 30s por comando de modelo y 75s para el procesador
gestionado, suficiente para una primera carga de rostro + fondo en demo.

También puedes usar `--vcclient000-command` para un comando local de vcclient000.
Usa `--video-frame-command` si prefieres un solo wrapper combinado para rostro y
fondo, y `--audio-chunk-command` si prefieres un wrapper combinado para voz.
Los wrappers versionados están en `apps/ai-sidecar/wrappers`; aceptan variables
como `FACEFUSION_DIR`, `BMV2_REPO_DIR`, `BMV2_MODEL_CHECKPOINT` y
`VCCLIENT000_CHUNK_COMMAND`.
`pnpm models:doctor` valida esas variables, comandos y placeholders sin cargar
modelos pesados; usa `--env-file` para revisar un runtime concreto.
`pnpm models:bootstrap` envuelve esa preparación: puede crear carpetas con
`--init-dirs`, clonar los repos con `--clone`, validar GPU/rutas/checkpoints y
escribir el runtime final con `--write-runtime`. Con `--write-checklist` deja
un reporte Markdown en `output/model-workstation/` con checks, rutas y
siguientes pasos de la estación. Con `--write-setup-script` también genera un
PowerShell/Bash base para clonar repos y crear venvs antes de instalar pesos o
dependencias licenciadas. Si `VCCLIENT000_HTTP_ENDPOINT` está configurado, el
bootstrap valida w-okada/VCClient con una petición `POST /test`.
Después del bootstrap, `pnpm models:preflight` arranca un sidecar temporal con
ese runtime y ejecuta frame/audio contra los procesadores configurados:

```bash
pnpm models:preflight -- \
  --identity C:\models\identities\host.jpg \
  --frame C:\models\samples\frame.jpg \
  --clean-plate C:\models\samples\clean-plate.jpg \
  --audio C:\models\samples\audio.f32le \
  --strict
```

El reporte muestra estado, procesador, latencia y warnings por check. Si no
pasas assets, usa muestras mínimas internas para validar contrato/passthrough.

El adaptador escribe archivos temporales y ejecuta el comando sin shell. Tambien
inyecta variables como `SHAPE_FRAME_INPUT_PATH`, `SHAPE_FRAME_OUTPUT_PATH`,
`SHAPE_IDENTITY_PATH`, `SHAPE_CLEAN_PLATE_PATH`, `SHAPE_AUDIO_INPUT_PATH`,
`SHAPE_AUDIO_OUTPUT_PATH`, `SHAPE_AUDIO_SAMPLE_RATE`, `SHAPE_AUDIO_CHANNELS` y
`SHAPE_AUDIO_FORMAT`. Si el comando falta o falla, devuelve passthrough con
warnings para que LiveKit siga publicando.

En la app Tauri, estas variables también pueden vivir en `shape-ai-runtime.env`.
Por defecto se busca en:

- Windows: `%LOCALAPPDATA%\\Shape Meet\\shape-ai-runtime.env`
- macOS: `~/Library/Application Support/Shape Meet/shape-ai-runtime.env`
- Linux: `$XDG_DATA_HOME/shape-meet/shape-ai-runtime.env` o
  `~/.local/share/shape-meet/shape-ai-runtime.env`

Puedes cambiar la ruta con `SHAPE_AI_RUNTIME_ENV_FILE`. La app carga ese archivo
al iniciar el sidecar gestionado y lo reporta en el debug bundle solo como ruta,
claves configuradas y warnings, sin valores.

Desde `Runtime IA local`, el botón `Probar IA` llama a `/preflight` con la
identidad, clean plate y efectos activos. Si hay cámara disponible, envía un
frame real de la cámara seleccionada; si no, el sidecar usa un JPEG mínimo para
validar conectividad y comandos.

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
pnpm smoke:ai-demo
pnpm smoke:ai-runtime
pnpm smoke:ai-model-runtime
pnpm smoke:ai-model-wrappers
pnpm smoke:ai-demo-sidecar
pnpm smoke:ai-managed
pnpm smoke:ai-command
pnpm smoke:ai-stage-command
```

El script arranca el sidecar en un puerto libre, levanta mocks HTTP para video y
audio, y valida que los payloads enviados a `SHAPE_VIDEO_PROCESSOR_ENDPOINT` y
`SHAPE_AUDIO_PROCESSOR_ENDPOINT` incluyan sesión, identidad, clean plate de
fondo, flags activos y datos procesables.

`smoke:ai-managed` valida además que el sidecar pueda iniciar procesadores por
comando, reportarlos en diagnostics y delegar frame/audio a esos procesos.
`smoke:ai-demo-sidecar` valida que `pnpm dev:ai:demo` arranque el sidecar con
procesadores demo gestionados y que `/preflight` use esos procesadores.
`smoke:ai-command` valida la ruta completa usando el adaptador de comandos:
sidecar gestionado -> procesador HTTP -> comando de modelo -> output procesado.
`smoke:ai-stage-command` valida la ruta de comandos separados para
FaceFusion/BackgroundMattingV2/vcclient000.

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
