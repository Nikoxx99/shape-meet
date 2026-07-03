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
- `VCCLIENT000_HTTP_ENDPOINT`: endpoint JSON que recibe y devuelve
  `audioDataBase64`.

## Runtime

```bash
pnpm models:runtime -- \
  --face-command "python apps/ai-sidecar/wrappers/facefusion_frame.py --input {input} --output {output} --identity {identity}" \
  --background-command "python apps/ai-sidecar/wrappers/backgroundmattingv2_frame.py --input {input} --output {output} --clean-plate {clean_plate}" \
  --voice-command "python apps/ai-sidecar/wrappers/vcclient000_chunk.py --input {input} --output {output} --sample-rate {sample_rate} --channels {channels} --format {format}"
```

`SHAPE_WRAPPER_PASSTHROUGH=true` permite validar los wrappers sin instalar los
modelos: copian input a output y emiten un warning controlado.
