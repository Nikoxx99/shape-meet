# Shape Meet model wrappers

Estos wrappers son el primer puente ejecutable entre el contrato local de Shape
Meet y los motores reales. El sidecar genera archivos temporales y los invoca por
frame o chunk de audio mediante `shape_processor_command.py`.

## FaceFusion

```bash
python apps/ai-sidecar/wrappers/facefusion_frame.py \
  --input frame.jpg \
  --output frame.out.jpg \
  --identity identity.jpg
```

Variables principales:

- `FACEFUSION_DIR`: carpeta del repo FaceFusion.
- `FACEFUSION_ENTRYPOINT`: ruta a `facefusion.py`; por defecto `facefusion.py`.
- `FACEFUSION_PYTHON`: intérprete del entorno FaceFusion.
- `FACEFUSION_EXECUTION_PROVIDERS`: por defecto `cuda`.
- `FACEFUSION_PROCESSORS`: por defecto `face_swapper face_enhancer`.
- `FACEFUSION_EXTRA_ARGS`: argumentos adicionales.

También puedes saltarte el comando interno con `FACEFUSION_COMMAND_TEMPLATE`.

## BackgroundMattingV2

```bash
python apps/ai-sidecar/wrappers/backgroundmattingv2_frame.py \
  --input frame.jpg \
  --output frame.out.png \
  --clean-plate clean.jpg
```

Variables principales:

- `BMV2_REPO_DIR`: carpeta del repo BackgroundMattingV2.
- `BMV2_MODEL_CHECKPOINT`: checkpoint `.pth`.
- `BMV2_PYTHON`: intérprete del entorno BackgroundMattingV2.
- `BMV2_DEVICE`: `cuda` o `cpu`.
- `BMV2_EXTRA_ARGS`: argumentos adicionales para `inference_images.py`.

Este wrapper usa `inference_images.py` como puente inicial. Es correcto para
integración y pruebas, pero no es la ruta final de baja latencia porque carga el
modelo por invocación.

## vcclient000

```bash
python apps/ai-sidecar/wrappers/vcclient000_chunk.py \
  --input chunk.f32le \
  --output chunk.out.f32le \
  --sample-rate 48000
```

Configura una de estas rutas:

- `VCCLIENT000_CHUNK_COMMAND`: comando local con placeholders.
- `VCCLIENT000_HTTP_ENDPOINT`: endpoint HTTP. Con
  `VCCLIENT000_HTTP_MODE=w-okada-rest`, usa el REST oficial de VCClient
  (`POST /test`, `buffer` PCM s16le y respuesta `changedVoiceBase64`). Con
  `VCCLIENT000_HTTP_MODE=shape-json`, usa el contrato JSON Shape Meet que recibe
  y devuelve `audioDataBase64`.

## Runtime

```bash
pnpm models:runtime -- --preset local-wrappers --passthrough
pnpm models:doctor -- --skip-hardware
```

`SHAPE_WRAPPER_PASSTHROUGH=true` permite validar los wrappers sin instalar los
modelos: copian input a output y emiten un warning controlado.

Para usar modelos reales, elimina `--passthrough` y agrega rutas o endpoints:

```bash
pnpm models:runtime -- --preset local-wrappers \
  --facefusion-dir "/models/FaceFusion" \
  --bmv2-repo-dir "/models/BackgroundMattingV2" \
  --bmv2-checkpoint "/models/BackgroundMattingV2/pytorch_resnet50.pth" \
  --vcclient000-http-endpoint "http://127.0.0.1:18888/test"
```

Para probar la ruta de procesos persistentes por etapa:

```bash
pnpm models:endpoint -- --passthrough
pnpm models:runtime -- --preset local-endpoints
pnpm smoke:ai-model-endpoint
```

Ese preset apunta `SHAPE_FACE_ENDPOINT`, `SHAPE_BACKGROUND_ENDPOINT` y
`SHAPE_VOICE_ENDPOINT` al servidor local `shape_model_endpoint_server.py`.
El mismo servidor tambien expone `/video-frame`; puedes apuntar
`SHAPE_VIDEO_FRAME_ENDPOINT` a esa ruta cuando quieras un pipeline persistente
unico para rostro + fondo:

```bash
pnpm models:runtime -- --preset local-endpoints --video-frame-endpoint http://127.0.0.1:9100/video-frame
```
