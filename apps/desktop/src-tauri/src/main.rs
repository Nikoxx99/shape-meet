use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{Manager, State};

const DEFAULT_AI_ENDPOINT: &str = "http://127.0.0.1:7851";
const HTTP_TIMEOUT_MS: u64 = 1200;
const ARTIFACT_DOWNLOAD_TIMEOUT_SECS: u64 = 900;
const AI_SIDECAR_BINARY_NAME: &str = "shape-ai-sidecar";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuProfile {
    platform: String,
    arch: String,
    gpu_tier: String,
    message: String,
    nvidia_smi_available: bool,
    cuda_available: bool,
    cuda_version: Option<String>,
    driver_version: Option<String>,
    total_vram_mb: Option<u64>,
    free_vram_mb: Option<u64>,
    minimum_required_vram_mb: u64,
    recommended_vram_mb: u64,
    devices: Vec<GpuDevice>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuDevice {
    name: String,
    memory_total_mb: Option<u64>,
    memory_free_mb: Option<u64>,
    driver_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservabilityStatus {
    native_sentry_enabled: bool,
    environment: String,
    release: String,
    traces_sample_rate: f32,
    debug: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugEventResult {
    captured: bool,
    event_id: Option<String>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiPipelineStatus {
    id: String,
    label: String,
    status: String,
    model: String,
    detail: String,
    latency_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiServiceStatus {
    endpoint: String,
    online: bool,
    mode: String,
    status: String,
    message: String,
    checked_at: String,
    pipelines: Vec<AiPipelineStatus>,
}

#[derive(Default)]
struct SidecarState {
    supervisor: Mutex<SidecarSupervisor>,
}

#[derive(Default)]
struct SidecarSupervisor {
    child: Option<Child>,
    last_exit: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiSidecarRuntime {
    endpoint: String,
    managed: bool,
    running: bool,
    pid: Option<u32>,
    command: Option<String>,
    log_path: String,
    message: String,
    last_exit: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRuntimeEnvFile {
    path: String,
    exists: bool,
    content: String,
    configured_keys: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAiRuntimeEnvInput {
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheIdentityArtifactInput {
    identity_id: String,
    artifact_uri: Option<String>,
    artifact_sha256: Option<String>,
    artifact_size_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvictIdentityArtifactInput {
    identity_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityArtifactCacheResult {
    identity_id: String,
    cached: bool,
    local_path: Option<String>,
    uri: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    message: String,
}

#[tauri::command]
fn get_gpu_profile() -> GpuProfile {
    gpu_profile()
}

#[tauri::command]
fn get_observability_status() -> ObservabilityStatus {
    ObservabilityStatus {
        native_sentry_enabled: sentry_dsn().is_some(),
        environment: sentry_environment(),
        release: sentry_release(),
        traces_sample_rate: sentry_traces_sample_rate(),
        debug: sentry_debug(),
    }
}

#[tauri::command]
fn capture_native_debug_event(message: Option<String>) -> DebugEventResult {
    let message = message.unwrap_or_else(|| "Shape Meet native debug event".to_string());

    if sentry_dsn().is_none() {
        return DebugEventResult {
            captured: false,
            event_id: None,
            message: "Sentry nativo no tiene DSN configurado.".to_string(),
        };
    }

    let event_id = sentry::capture_message(&message, sentry::Level::Info).to_string();

    DebugEventResult {
        captured: true,
        event_id: Some(event_id),
        message,
    }
}

#[tauri::command]
fn get_ai_service_status() -> AiServiceStatus {
    ai_service_status()
}

#[tauri::command]
fn get_ai_sidecar_runtime(state: State<'_, SidecarState>) -> AiSidecarRuntime {
    let mut supervisor = state
        .supervisor
        .lock()
        .expect("sidecar supervisor lock poisoned");
    supervisor.runtime_status()
}

#[tauri::command]
fn start_ai_sidecar(state: State<'_, SidecarState>) -> Result<AiSidecarRuntime, String> {
    let mut supervisor = state.supervisor.lock().map_err(|error| error.to_string())?;
    supervisor.start()
}

#[tauri::command]
fn stop_ai_sidecar(state: State<'_, SidecarState>) -> Result<AiSidecarRuntime, String> {
    let mut supervisor = state.supervisor.lock().map_err(|error| error.to_string())?;
    supervisor.stop()
}

#[tauri::command]
fn get_ai_runtime_env() -> Result<AiRuntimeEnvFile, String> {
    read_ai_runtime_env_file()
}

#[tauri::command]
fn save_ai_runtime_env(input: SaveAiRuntimeEnvInput) -> Result<AiRuntimeEnvFile, String> {
    write_ai_runtime_env_file(&input.content)?;
    read_ai_runtime_env_file()
}

#[tauri::command]
fn cache_identity_artifact(
    input: CacheIdentityArtifactInput,
) -> Result<IdentityArtifactCacheResult, String> {
    prepare_identity_artifact(input)
}

#[tauri::command]
fn evict_identity_artifact(
    input: EvictIdentityArtifactInput,
) -> Result<IdentityArtifactCacheResult, String> {
    evict_identity_artifact_cache(input)
}

#[tauri::command]
fn export_debug_bundle() -> Result<String, String> {
    let now = utc_timestamp()?;
    let safe_now = now.replace([':', '.'], "-");
    let output_dir = env::temp_dir().join("shape-meet-debug");
    fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;

    let output_path = output_dir.join(format!("shape-meet-debug-{safe_now}.json"));
    let payload = json!({
        "generatedAt": now,
        "app": {
            "name": "Shape Meet",
            "version": env!("CARGO_PKG_VERSION"),
            "platform": env::consts::OS,
            "arch": env::consts::ARCH
        },
        "gpu": get_gpu_profile(),
        "observability": get_observability_status(),
        "aiService": get_ai_service_status(),
        "aiSidecar": {
            "endpoint": ai_endpoint(),
            "logPath": sidecar_log_path().display().to_string(),
            "logTail": read_sidecar_log_tail(80)
        },
        "environment": redacted_environment()
    });

    fs::write(
        &output_path,
        serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    if sentry_dsn().is_some() {
        sentry::capture_message("Shape Meet debug bundle exported", sentry::Level::Info);
    }

    Ok(format!("Debug bundle preparado: {}", output_path.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _sentry_guard = init_sentry();
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            println!("Shape Meet received a new app instance request: {argv:?}");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .manage(SidecarState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_gpu_profile,
            get_observability_status,
            capture_native_debug_event,
            get_ai_service_status,
            get_ai_sidecar_runtime,
            start_ai_sidecar,
            stop_ai_sidecar,
            get_ai_runtime_env,
            save_ai_runtime_env,
            cache_identity_artifact,
            evict_identity_artifact,
            export_debug_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running Shape Meet");
}

fn main() {
    run();
}

fn init_sentry() -> Option<sentry::ClientInitGuard> {
    let dsn = sentry_dsn()?;
    let environment = sentry_environment();
    let release = sentry_release();

    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(release.clone().into()),
            environment: Some(environment.clone().into()),
            traces_sample_rate: sentry_traces_sample_rate(),
            debug: sentry_debug(),
            ..Default::default()
        },
    ));

    sentry::configure_scope(|scope| {
        scope.set_tag("app.surface", "desktop-native");
        scope.set_tag("platform", env::consts::OS);
        scope.set_tag("arch", env::consts::ARCH);
        scope.set_tag("release", release);
        scope.set_tag("environment", environment);
    });

    sentry::capture_message("Shape Meet native runtime initialized", sentry::Level::Info);
    Some(guard)
}

fn gpu_profile() -> GpuProfile {
    const MINIMUM_REQUIRED_VRAM_MB: u64 = 8 * 1024;
    const RECOMMENDED_VRAM_MB: u64 = 24 * 1024;

    let platform = env::consts::OS.to_string();
    let arch = env::consts::ARCH.to_string();
    let cuda_version = nvidia_cuda_version();

    match query_nvidia_devices() {
        Ok(devices) if !devices.is_empty() => {
            let total_vram_mb = devices
                .iter()
                .filter_map(|device| device.memory_total_mb)
                .max();
            let free_vram_mb = devices
                .iter()
                .filter_map(|device| device.memory_free_mb)
                .max();
            let driver_version = devices
                .iter()
                .find_map(|device| device.driver_version.clone())
                .filter(|value| !value.is_empty());
            let cuda_available = cuda_version.is_some();
            let gpu_tier = if total_vram_mb.unwrap_or(0) >= MINIMUM_REQUIRED_VRAM_MB {
                "ready"
            } else {
                "limited"
            };
            let mut warnings = Vec::new();

            if total_vram_mb.unwrap_or(0) < MINIMUM_REQUIRED_VRAM_MB {
                warnings.push(format!(
                    "VRAM por debajo del minimo operativo: {} MB requeridos.",
                    MINIMUM_REQUIRED_VRAM_MB
                ));
            }

            if !cuda_available {
                warnings
                    .push("nvidia-smi no reporto version CUDA; revisa driver/runtime.".to_string());
            }

            let primary_name = devices
                .first()
                .map(|device| device.name.as_str())
                .unwrap_or("GPU NVIDIA");
            let message = match total_vram_mb {
                Some(total) if total >= RECOMMENDED_VRAM_MB => {
                    format!("{primary_name} lista para perfiles 720p30 premium.")
                }
                Some(total) if total >= MINIMUM_REQUIRED_VRAM_MB => {
                    format!("{primary_name} compatible; usa perfiles conservadores si hay mas de un efecto activo.")
                }
                Some(_) => format!(
                    "{primary_name} detectada, pero con VRAM limitada para modelos en vivo."
                ),
                None => format!("{primary_name} detectada; no se pudo leer VRAM."),
            };

            GpuProfile {
                platform,
                arch,
                gpu_tier: gpu_tier.to_string(),
                message,
                nvidia_smi_available: true,
                cuda_available,
                cuda_version,
                driver_version,
                total_vram_mb,
                free_vram_mb,
                minimum_required_vram_mb: MINIMUM_REQUIRED_VRAM_MB,
                recommended_vram_mb: RECOMMENDED_VRAM_MB,
                devices,
                warnings,
            }
        }
        Ok(_) => gpu_profile_without_nvidia(
            platform,
            arch,
            "nvidia-smi no devolvio GPUs NVIDIA.",
            MINIMUM_REQUIRED_VRAM_MB,
            RECOMMENDED_VRAM_MB,
        ),
        Err(error) => gpu_profile_without_nvidia(
            platform,
            arch,
            &format!("nvidia-smi no disponible: {error}"),
            MINIMUM_REQUIRED_VRAM_MB,
            RECOMMENDED_VRAM_MB,
        ),
    }
}

fn gpu_profile_without_nvidia(
    platform: String,
    arch: String,
    diagnostic: &str,
    minimum_required_vram_mb: u64,
    recommended_vram_mb: u64,
) -> GpuProfile {
    let apple_silicon = platform == "macos" && matches!(arch.as_str(), "aarch64" | "arm64");
    let (gpu_tier, message) = if apple_silicon {
        (
            "limited",
            "Apple Silicon detectado; requiere motores macOS/Metal preparados en el sidecar.",
        )
    } else if platform == "windows" {
        (
            "limited",
            "Sin GPU NVIDIA/CUDA detectable; la app puede abrir en modo UI y debug.",
        )
    } else {
        (
            "unsupported",
            "Plataforma sin ruta GPU local validada para los modelos en vivo.",
        )
    };

    GpuProfile {
        platform,
        arch,
        gpu_tier: gpu_tier.to_string(),
        message: message.to_string(),
        nvidia_smi_available: false,
        cuda_available: false,
        cuda_version: None,
        driver_version: None,
        total_vram_mb: None,
        free_vram_mb: None,
        minimum_required_vram_mb,
        recommended_vram_mb,
        devices: if apple_silicon {
            vec![GpuDevice {
                name: "Apple Silicon GPU".to_string(),
                memory_total_mb: None,
                memory_free_mb: None,
                driver_version: None,
            }]
        } else {
            Vec::new()
        },
        warnings: vec![diagnostic.to_string()],
    }
}

fn query_nvidia_devices() -> Result<Vec<GpuDevice>, String> {
    let output = run_nvidia_smi(&[
        "--query-gpu=name,memory.total,memory.free,driver_version",
        "--format=csv,noheader,nounits",
    ])?;

    Ok(output
        .lines()
        .filter_map(parse_nvidia_device_line)
        .collect::<Vec<_>>())
}

fn parse_nvidia_device_line(line: &str) -> Option<GpuDevice> {
    let parts = line.split(',').map(|part| part.trim()).collect::<Vec<_>>();
    let name = parts.first()?.trim();

    if name.is_empty() {
        return None;
    }

    Some(GpuDevice {
        name: name.to_string(),
        memory_total_mb: parts.get(1).and_then(|value| parse_u64_prefix(value)),
        memory_free_mb: parts.get(2).and_then(|value| parse_u64_prefix(value)),
        driver_version: parts
            .get(3)
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty()),
    })
}

fn nvidia_cuda_version() -> Option<String> {
    let output = run_nvidia_smi(&["--version"]).ok()?;
    output.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        if !lower.contains("cuda version") {
            return None;
        }

        line.split(':')
            .nth(1)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn run_nvidia_smi(args: &[&str]) -> Result<String, String> {
    let mut last_error = None;

    for candidate in nvidia_smi_candidates() {
        let output = Command::new(&candidate).args(args).output();

        match output {
            Ok(output) if output.status.success() => {
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                last_error = Some(if stderr.is_empty() {
                    format!("{candidate} salio con estado {}", output.status)
                } else {
                    stderr
                });
            }
            Err(error) => {
                last_error = Some(error.to_string());
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "no se encontro nvidia-smi".to_string()))
}

fn nvidia_smi_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Some(path) = env_non_empty("NVIDIA_SMI") {
        candidates.push(path);
    }

    if cfg!(windows) {
        candidates.push("nvidia-smi.exe".to_string());
        candidates.push(r"C:\Windows\System32\nvidia-smi.exe".to_string());
        candidates.push(r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe".to_string());
    } else {
        candidates.push("nvidia-smi".to_string());
        candidates.push("/usr/bin/nvidia-smi".to_string());
        candidates.push("/usr/local/bin/nvidia-smi".to_string());
    }

    candidates.dedup();
    candidates
}

fn parse_u64_prefix(value: &str) -> Option<u64> {
    value
        .split_whitespace()
        .next()
        .and_then(|part| part.parse::<u64>().ok())
}

fn ai_service_status() -> AiServiceStatus {
    let endpoint = ai_endpoint();
    let checked_at = utc_timestamp().unwrap_or_else(|_| "unknown".to_string());
    let health_url = format!("{}/health", endpoint.trim_end_matches('/'));

    match read_http_json(&health_url) {
        Ok(value) => AiServiceStatus {
            endpoint,
            online: true,
            mode: value
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("local-sidecar")
                .to_string(),
            status: value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("ready")
                .to_string(),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Servicio local de IA conectado.")
                .to_string(),
            checked_at,
            pipelines: parse_pipelines(&value).unwrap_or_else(default_online_pipelines),
        },
        Err(error) => AiServiceStatus {
            endpoint,
            online: false,
            mode: "offline".to_string(),
            status: "offline".to_string(),
            message: format!("Servicio local de IA no disponible: {error}"),
            checked_at,
            pipelines: default_offline_pipelines(),
        },
    }
}

fn parse_pipelines(value: &Value) -> Option<Vec<AiPipelineStatus>> {
    let pipelines = value.get("pipelines")?.as_array()?;
    let parsed = pipelines
        .iter()
        .filter_map(|pipeline| {
            Some(AiPipelineStatus {
                id: pipeline.get("id")?.as_str()?.to_string(),
                label: pipeline.get("label")?.as_str()?.to_string(),
                status: pipeline.get("status")?.as_str()?.to_string(),
                model: pipeline.get("model")?.as_str()?.to_string(),
                detail: pipeline
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                latency_ms: pipeline.get("latencyMs").and_then(Value::as_u64),
            })
        })
        .collect::<Vec<_>>();

    if parsed.is_empty() {
        None
    } else {
        Some(parsed)
    }
}

fn default_online_pipelines() -> Vec<AiPipelineStatus> {
    vec![
        pipeline(
            "face",
            "Rostro",
            "ready",
            "FaceFusion connector",
            "Contrato local listo.",
            None,
        ),
        pipeline(
            "background",
            "Fondo",
            "ready",
            "BackgroundMattingV2",
            "Contrato local listo.",
            None,
        ),
        pipeline(
            "voice",
            "Voz",
            "ready",
            "vcclient000",
            "Contrato local listo.",
            None,
        ),
    ]
}

fn default_offline_pipelines() -> Vec<AiPipelineStatus> {
    vec![
        pipeline(
            "face",
            "Rostro",
            "offline",
            "FaceFusion / DFM",
            "Esperando sidecar local.",
            None,
        ),
        pipeline(
            "background",
            "Fondo",
            "offline",
            "BackgroundMattingV2",
            "Esperando sidecar local.",
            None,
        ),
        pipeline(
            "voice",
            "Voz",
            "offline",
            "vcclient000",
            "Esperando sidecar local.",
            None,
        ),
    ]
}

fn pipeline(
    id: &str,
    label: &str,
    status: &str,
    model: &str,
    detail: &str,
    latency_ms: Option<u64>,
) -> AiPipelineStatus {
    AiPipelineStatus {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        model: model.to_string(),
        detail: detail.to_string(),
        latency_ms,
    }
}

impl SidecarSupervisor {
    fn runtime_status(&mut self) -> AiSidecarRuntime {
        self.reap_finished_child();

        if let Some(child) = self.child.as_mut() {
            return AiSidecarRuntime {
                endpoint: ai_endpoint(),
                managed: true,
                running: true,
                pid: Some(child.id()),
                command: Some(sidecar_command_description()),
                log_path: sidecar_log_path().display().to_string(),
                message: "Sidecar gestionado por Shape Meet.".to_string(),
                last_exit: self.last_exit.clone(),
            };
        }

        let service = ai_service_status();
        AiSidecarRuntime {
            endpoint: service.endpoint,
            managed: false,
            running: service.online,
            pid: None,
            command: Some(sidecar_command_description()),
            log_path: sidecar_log_path().display().to_string(),
            message: if service.online {
                "Sidecar externo detectado.".to_string()
            } else {
                "Sidecar detenido.".to_string()
            },
            last_exit: self.last_exit.clone(),
        }
    }

    fn start(&mut self) -> Result<AiSidecarRuntime, String> {
        self.reap_finished_child();

        if self.child.is_some() {
            return Ok(self.runtime_status());
        }

        if ai_service_status().online {
            return Ok(AiSidecarRuntime {
                endpoint: ai_endpoint(),
                managed: false,
                running: true,
                pid: None,
                command: Some(sidecar_command_description()),
                log_path: sidecar_log_path().display().to_string(),
                message: "Sidecar externo ya está activo.".to_string(),
                last_exit: self.last_exit.clone(),
            });
        }

        let log_path = sidecar_log_path();
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        append_sidecar_log("starting sidecar")?;

        let (program, args, description) = sidecar_command()?;
        let runtime_env = load_ai_runtime_env()?;
        if !runtime_env.is_empty() {
            append_sidecar_log(&format!(
                "loading AI runtime env keys: {}",
                runtime_env
                    .iter()
                    .map(|(key, _)| key.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))?;
        }
        let stdout_log = open_sidecar_log_file()?;
        let stderr_log = stdout_log.try_clone().map_err(|error| error.to_string())?;
        let mut command = Command::new(&program);
        command
            .args(&args)
            .envs(runtime_env.iter().map(|(key, value)| (key, value)))
            .stdout(Stdio::from(stdout_log))
            .stderr(Stdio::from(stderr_log))
            .stdin(Stdio::null());
        let child = command
            .spawn()
            .map_err(|error| format!("No se pudo iniciar sidecar con {description}: {error}"))?;

        self.child = Some(child);
        self.last_exit = None;

        for _ in 0..12 {
            thread::sleep(Duration::from_millis(250));
            self.reap_finished_child();
            if ai_service_status().online || self.child.is_none() {
                break;
            }
        }

        Ok(self.runtime_status())
    }

    fn stop(&mut self) -> Result<AiSidecarRuntime, String> {
        self.reap_finished_child();

        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            child.kill().map_err(|error| error.to_string())?;
            let status = child.wait().map_err(|error| error.to_string())?;
            self.last_exit = Some(format!("pid {pid} detenido: {status}"));
            append_sidecar_log(&format!("stopped managed sidecar pid {pid}: {status}"))?;
        }

        Ok(self.runtime_status())
    }

    fn reap_finished_child(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };

        match child.try_wait() {
            Ok(Some(status)) => {
                let pid = child.id();
                self.last_exit = Some(format!("pid {pid} finalizó: {status}"));
                let _ = append_sidecar_log(&format!("managed sidecar pid {pid} exited: {status}"));
                self.child = None;
            }
            Ok(None) => {}
            Err(error) => {
                self.last_exit = Some(format!("error consultando sidecar: {error}"));
                let _ = append_sidecar_log(&format!("managed sidecar status error: {error}"));
                self.child = None;
            }
        }
    }
}

fn prepare_identity_artifact(
    input: CacheIdentityArtifactInput,
) -> Result<IdentityArtifactCacheResult, String> {
    let identity_id = input.identity_id.trim().to_string();
    if identity_id.is_empty() {
        return Err("La identidad no tiene id válido.".to_string());
    }

    let uri = input
        .artifact_uri
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let Some(uri) = uri else {
        return Ok(identity_artifact_result(
            &identity_id,
            false,
            None,
            None,
            input.artifact_sha256.as_deref(),
            input.artifact_size_bytes,
            "La identidad no tiene artefacto publicado.",
        ));
    };

    if uri.starts_with("shape://") {
        return Ok(identity_artifact_result(
            &identity_id,
            false,
            None,
            Some(&uri),
            input.artifact_sha256.as_deref(),
            input.artifact_size_bytes,
            "Artefacto de desarrollo shape:// sin descarga local.",
        ));
    }

    if uri.starts_with("http://") || uri.starts_with("https://") {
        return download_identity_artifact(&input, &identity_id, &uri);
    }

    let source_path = if uri.starts_with("file://") {
        file_uri_to_path(&uri)?
    } else {
        let path = PathBuf::from(&uri);
        if !path.is_absolute() {
            return Err(
                "URI de artefacto no soportada. Usa http(s), file:// o shape://demo.".to_string(),
            );
        }
        path
    };

    copy_local_identity_artifact(&input, &identity_id, &uri, &source_path)
}

fn evict_identity_artifact_cache(
    input: EvictIdentityArtifactInput,
) -> Result<IdentityArtifactCacheResult, String> {
    let identity_id = input.identity_id.trim().to_string();
    if identity_id.is_empty() {
        return Err("La identidad no tiene id válido.".to_string());
    }

    let cache_dir = identity_cache_dir()?;
    let identity_dir = cache_dir.join(safe_cache_component(&identity_id));
    let relative_identity_dir = identity_dir
        .strip_prefix(&cache_dir)
        .map_err(|_| "Ruta de cache de identidad inválida.".to_string())?;

    if relative_identity_dir
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Ruta de cache de identidad inválida.".to_string());
    }

    if identity_dir.exists() {
        fs::remove_dir_all(&identity_dir)
            .map_err(|error| format!("No se pudo retirar cache local de identidad: {error}"))?;
    }

    Ok(identity_artifact_result(
        &identity_id,
        false,
        None,
        None,
        None,
        None,
        "Cache local de identidad retirada.",
    ))
}

fn download_identity_artifact(
    input: &CacheIdentityArtifactInput,
    identity_id: &str,
    uri: &str,
) -> Result<IdentityArtifactCacheResult, String> {
    let target_path =
        identity_artifact_cache_path(identity_id, uri, expected_artifact_sha(input).as_deref())?;
    if let Some(result) = reusable_cached_artifact(input, identity_id, uri, &target_path)? {
        return Ok(result);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(ARTIFACT_DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("No se pudo crear cliente HTTP de artefactos: {error}"))?;
    let mut response = client
        .get(uri)
        .send()
        .map_err(|error| format!("No se pudo descargar el artefacto de identidad: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Descarga de artefacto falló con estado HTTP {}.",
            response.status()
        ));
    }

    cache_identity_artifact_from_reader(input, identity_id, uri, &target_path, &mut response)
}

fn copy_local_identity_artifact(
    input: &CacheIdentityArtifactInput,
    identity_id: &str,
    uri: &str,
    source_path: &Path,
) -> Result<IdentityArtifactCacheResult, String> {
    if !source_path.exists() {
        return Err(format!(
            "El artefacto local no existe: {}",
            source_path.display()
        ));
    }

    let target_path =
        identity_artifact_cache_path(identity_id, uri, expected_artifact_sha(input).as_deref())?;
    if let Some(result) = reusable_cached_artifact(input, identity_id, uri, &target_path)? {
        return Ok(result);
    }

    let mut file = File::open(source_path)
        .map_err(|error| format!("No se pudo abrir artefacto local: {error}"))?;
    cache_identity_artifact_from_reader(input, identity_id, uri, &target_path, &mut file)
}

fn cache_identity_artifact_from_reader<R: Read>(
    input: &CacheIdentityArtifactInput,
    identity_id: &str,
    uri: &str,
    target_path: &Path,
    reader: &mut R,
) -> Result<IdentityArtifactCacheResult, String> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let temp_path = target_path.with_extension(format!(
        "{}.part",
        target_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact")
    ));
    let mut output = File::create(&temp_path)
        .map_err(|error| format!("No se pudo crear cache de artefacto: {error}"))?;
    let mut hasher = Sha256::new();
    let mut size_bytes = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("No se pudo leer artefacto de identidad: {error}"))?;
        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("No se pudo escribir cache de artefacto: {error}"))?;
        size_bytes += read as u64;
    }

    output
        .flush()
        .map_err(|error| format!("No se pudo cerrar cache de artefacto: {error}"))?;

    let actual_sha = to_hex(&hasher.finalize());
    validate_artifact_integrity(input, size_bytes, &actual_sha)?;
    fs::rename(&temp_path, target_path)
        .map_err(|error| format!("No se pudo finalizar cache de artefacto: {error}"))?;

    Ok(identity_artifact_result(
        identity_id,
        true,
        Some(target_path),
        Some(uri),
        Some(&actual_sha),
        Some(size_bytes),
        "Artefacto cacheado y validado localmente.",
    ))
}

fn reusable_cached_artifact(
    input: &CacheIdentityArtifactInput,
    identity_id: &str,
    uri: &str,
    target_path: &Path,
) -> Result<Option<IdentityArtifactCacheResult>, String> {
    if !target_path.exists() {
        return Ok(None);
    }

    let expected_size = expected_artifact_size(input);
    let expected_sha = expected_artifact_sha(input);
    let metadata = fs::metadata(target_path).map_err(|error| error.to_string())?;
    if expected_size.is_some_and(|size| size != metadata.len()) {
        fs::remove_file(target_path).map_err(|error| error.to_string())?;
        return Ok(None);
    }

    let actual_sha = if expected_sha.is_some() {
        Some(file_sha256(target_path)?)
    } else {
        None
    };

    if let (Some(expected), Some(actual)) = (&expected_sha, &actual_sha) {
        if expected != actual {
            fs::remove_file(target_path).map_err(|error| error.to_string())?;
            return Ok(None);
        }
    }

    Ok(Some(identity_artifact_result(
        identity_id,
        true,
        Some(target_path),
        Some(uri),
        actual_sha.as_deref().or(input.artifact_sha256.as_deref()),
        Some(metadata.len()),
        "Artefacto reutilizado desde cache local.",
    )))
}

fn validate_artifact_integrity(
    input: &CacheIdentityArtifactInput,
    size_bytes: u64,
    actual_sha: &str,
) -> Result<(), String> {
    if let Some(expected_size) = expected_artifact_size(input) {
        if expected_size != size_bytes {
            return Err(format!(
                "Tamaño inválido del artefacto: esperado {expected_size} bytes, recibido {size_bytes} bytes."
            ));
        }
    }

    if let Some(expected_sha) = expected_artifact_sha(input) {
        if expected_sha != actual_sha {
            return Err(format!(
                "Checksum SHA-256 inválido del artefacto: esperado {expected_sha}, recibido {actual_sha}."
            ));
        }
    }

    Ok(())
}

fn identity_artifact_cache_path(
    identity_id: &str,
    uri: &str,
    expected_sha: Option<&str>,
) -> Result<PathBuf, String> {
    let cache_key = expected_sha
        .map(str::to_string)
        .unwrap_or_else(|| sha256_string(uri.as_bytes()));
    let file_name = format!(
        "{}{}",
        safe_cache_component(&cache_key)
            .chars()
            .take(32)
            .collect::<String>(),
        artifact_extension(uri)
    );

    Ok(identity_cache_dir()?
        .join(safe_cache_component(identity_id))
        .join(file_name))
}

fn identity_cache_dir() -> Result<PathBuf, String> {
    if let Some(path) = env_non_empty("SHAPE_IDENTITY_CACHE_DIR").map(PathBuf::from) {
        return Ok(path);
    }

    Ok(shape_meet_data_dir()?.join("identities"))
}

fn shape_meet_data_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        return env::var("LOCALAPPDATA")
            .map(|base| PathBuf::from(base).join("Shape Meet"))
            .map_err(|_| "LOCALAPPDATA no está disponible para datos de Shape Meet.".to_string());
    }

    if cfg!(target_os = "macos") {
        return env::var("HOME")
            .map(|home| {
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("Shape Meet")
            })
            .map_err(|_| "HOME no está disponible para datos de Shape Meet.".to_string());
    }

    if let Some(data_home) = env_non_empty("XDG_DATA_HOME") {
        return Ok(PathBuf::from(data_home).join("shape-meet"));
    }

    env::var("HOME")
        .map(|home| {
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("shape-meet")
        })
        .map_err(|_| "No se pudo resolver directorio de datos de Shape Meet.".to_string())
}

fn ai_runtime_env_path() -> Result<PathBuf, String> {
    if let Some(path) = env_non_empty("SHAPE_AI_RUNTIME_ENV_FILE").map(PathBuf::from) {
        return Ok(path);
    }

    Ok(shape_meet_data_dir()?.join("shape-ai-runtime.env"))
}

fn read_ai_runtime_env_file() -> Result<AiRuntimeEnvFile, String> {
    let path = ai_runtime_env_path()?;
    let exists = path.exists();
    let content = if exists {
        fs::read_to_string(&path).map_err(|error| error.to_string())?
    } else {
        default_ai_runtime_env_template()
    };
    let parsed = if exists {
        parse_ai_runtime_env(&content)
    } else {
        ParsedAiRuntimeEnv {
            values: Vec::new(),
            keys: Vec::new(),
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    };

    Ok(AiRuntimeEnvFile {
        path: path.display().to_string(),
        exists,
        content,
        configured_keys: parsed.keys,
        warnings: parsed.warnings,
    })
}

fn write_ai_runtime_env_file(content: &str) -> Result<(), String> {
    let parsed = parse_ai_runtime_env(content);
    if !parsed.errors.is_empty() {
        return Err(parsed.errors.join("; "));
    }

    let path = ai_runtime_env_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fs::write(path, content).map_err(|error| error.to_string())
}

fn load_ai_runtime_env() -> Result<Vec<(String, String)>, String> {
    let path = ai_runtime_env_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = parse_ai_runtime_env(&content);
    if !parsed.errors.is_empty() {
        return Err(parsed.errors.join("; "));
    }

    Ok(parsed.values)
}

struct ParsedAiRuntimeEnv {
    values: Vec<(String, String)>,
    keys: Vec<String>,
    warnings: Vec<String>,
    errors: Vec<String>,
}

fn parse_ai_runtime_env(content: &str) -> ParsedAiRuntimeEnv {
    let mut values = Vec::new();
    let mut keys = Vec::new();
    let mut warnings = Vec::new();
    let mut errors = Vec::new();

    for (index, raw_line) in content.lines().enumerate() {
        let line_number = index + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((raw_key, raw_value)) = line.split_once('=') else {
            warnings.push(format!("Línea {line_number}: falta '='."));
            continue;
        };

        let key = raw_key.trim();
        if !valid_env_key(key) {
            warnings.push(format!("Línea {line_number}: clave inválida '{key}'."));
            continue;
        }
        if !allowed_ai_runtime_env_key(key) {
            warnings.push(format!("Línea {line_number}: clave no permitida '{key}'."));
            continue;
        }

        let value = unquote_env_value(raw_value.trim());
        if value.is_empty() {
            continue;
        }

        if keys.iter().any(|existing| existing == key) {
            errors.push(format!("Línea {line_number}: clave duplicada '{key}'."));
            continue;
        }

        keys.push(key.to_string());
        values.push((key.to_string(), value));
    }

    ParsedAiRuntimeEnv {
        values,
        keys,
        warnings,
        errors,
    }
}

fn valid_env_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
        && key
            .chars()
            .next()
            .map(|character| character.is_ascii_uppercase() || character == '_')
            .unwrap_or(false)
}

fn allowed_ai_runtime_env_key(key: &str) -> bool {
    key.starts_with("SHAPE_")
        || key == "CUDA_VISIBLE_DEVICES"
        || key == "NVIDIA_VISIBLE_DEVICES"
        || key == "NVIDIA_DRIVER_CAPABILITIES"
        || key.starts_with("ORT_")
        || key.starts_with("OMP_")
}

fn unquote_env_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        return trimmed[1..trimmed.len() - 1].to_string();
    }

    trimmed.to_string()
}

fn default_ai_runtime_env_template() -> String {
    [
        "# Shape Meet local AI runtime",
        "# Set these when connecting local model wrappers.",
        "SHAPE_AI_MODE=adapter-contract",
        "SHAPE_FACE_ENGINE=facefusion",
        "SHAPE_BACKGROUND_ENGINE=backgroundmattingv2",
        "SHAPE_VOICE_ENGINE=vcclient000",
        "# Demo sin modelos reales: pnpm demo:ai-runtime genera un archivo listo.",
        "# SHAPE_PROCESSOR_DEMO_EFFECTS=true",
        "# SHAPE_VIDEO_PROCESSOR_COMMAND=shape-ai-processor --kind video --port 7860",
        "# SHAPE_VIDEO_FRAME_COMMAND=C:\\\\shape-models\\\\video-wrapper.exe --input {input} --output {output} --identity {identity} --clean-plate {clean_plate}",
        "# SHAPE_AUDIO_PROCESSOR_COMMAND=shape-ai-processor --kind audio --port 7861",
        "# SHAPE_AUDIO_CHUNK_COMMAND=C:\\\\shape-models\\\\voice-wrapper.exe --input {input} --output {output} --sample-rate {sample_rate}",
        "",
    ]
    .join("\n")
}

fn identity_artifact_result(
    identity_id: &str,
    cached: bool,
    local_path: Option<&Path>,
    uri: Option<&str>,
    sha256: Option<&str>,
    size_bytes: Option<u64>,
    message: &str,
) -> IdentityArtifactCacheResult {
    IdentityArtifactCacheResult {
        identity_id: identity_id.to_string(),
        cached,
        local_path: local_path.map(|path| path.display().to_string()),
        uri: uri.map(str::to_string),
        sha256: sha256.map(str::to_string),
        size_bytes,
        message: message.to_string(),
    }
}

fn expected_artifact_sha(input: &CacheIdentityArtifactInput) -> Option<String> {
    input
        .artifact_sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "dev-demo")
        .map(|value| value.to_ascii_lowercase())
}

fn expected_artifact_size(input: &CacheIdentityArtifactInput) -> Option<u64> {
    input.artifact_size_bytes.filter(|value| *value > 0)
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];

    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(to_hex(&hasher.finalize()))
}

fn sha256_string(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    to_hex(&hasher.finalize())
}

fn to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn safe_cache_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();

    let trimmed = sanitized.trim_matches(['.', '_', '-']).to_string();
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed
    }
}

fn artifact_extension(uri: &str) -> String {
    let without_query = uri.split(['?', '#']).next().unwrap_or(uri);
    let file_name = without_query.rsplit(['/', '\\']).next().unwrap_or("");
    let Some((_, extension)) = file_name.rsplit_once('.') else {
        return ".artifact".to_string();
    };

    if extension.is_empty()
        || extension.len() > 16
        || !extension
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        ".artifact".to_string()
    } else {
        format!(".{extension}")
    }
}

fn file_uri_to_path(uri: &str) -> Result<PathBuf, String> {
    let raw_path = uri
        .strip_prefix("file://")
        .ok_or_else(|| "URI file:// inválida.".to_string())?;
    let decoded = percent_decode(raw_path)?;

    if cfg!(windows) {
        let path = decoded.strip_prefix('/').unwrap_or(&decoded);
        Ok(PathBuf::from(path))
    } else {
        Ok(PathBuf::from(decoded))
    }
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Escape percent inválido en URI file://.".to_string());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|error| error.to_string())?;
            let byte = u8::from_str_radix(hex, 16)
                .map_err(|_| "Escape percent inválido en URI file://.".to_string())?;
            output.push(byte);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(output).map_err(|error| error.to_string())
}

fn sidecar_command() -> Result<(String, Vec<String>, String), String> {
    let (host, port) = sidecar_host_port();

    if let Some(command) = env_non_empty("SHAPE_AI_SIDECAR_COMMAND") {
        let (program, args) = shell_command(command.clone());
        return Ok((program, args, command));
    }

    if let Some(binary) = env_non_empty("SHAPE_AI_SIDECAR_BIN") {
        let args = vec![
            "--host".to_string(),
            host,
            "--port".to_string(),
            port.to_string(),
        ];
        return Ok((binary.clone(), args, binary));
    }

    if let Some(binary) = bundled_sidecar_binary_path() {
        let args = vec![
            "--host".to_string(),
            host,
            "--port".to_string(),
            port.to_string(),
        ];
        let description = binary.display().to_string();
        return Ok((description.clone(), args, description));
    }

    let script = sidecar_script_path().ok_or_else(|| {
        "No se encontró sidecar local. Ejecuta pnpm build:ai-sidecar o define SHAPE_AI_SIDECAR_COMMAND/SHAPE_AI_SIDECAR_BIN/SHAPE_AI_SIDECAR_SCRIPT.".to_string()
    })?;
    let python = env_non_empty("SHAPE_AI_PYTHON").unwrap_or_else(default_python_command);
    let args = vec![
        script.display().to_string(),
        "--host".to_string(),
        host,
        "--port".to_string(),
        port.to_string(),
    ];

    Ok((
        python.clone(),
        args,
        format!("{python} {}", script.display()),
    ))
}

fn bundled_sidecar_binary_path() -> Option<PathBuf> {
    let mut search_dirs = Vec::new();

    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            search_dirs.push(parent.to_path_buf());
            search_dirs.push(parent.join("binaries"));

            if let Some(contents_dir) = parent.parent() {
                search_dirs.push(contents_dir.join("Resources"));
                search_dirs.push(contents_dir.join("Resources").join("binaries"));
            }
        }
    }

    if let Ok(current_dir) = env::current_dir() {
        for ancestor in current_dir.ancestors() {
            search_dirs.push(
                ancestor
                    .join("apps")
                    .join("desktop")
                    .join("src-tauri")
                    .join("binaries"),
            );
            search_dirs.push(ancestor.join("src-tauri").join("binaries"));
        }
    }

    for dir in search_dirs {
        if let Some(path) = find_sidecar_binary_in(&dir) {
            return Some(path);
        }
    }

    None
}

fn find_sidecar_binary_in(dir: &Path) -> Option<PathBuf> {
    let exact = dir.join(sidecar_runtime_binary_name());
    if exact.is_file() {
        return Some(exact);
    }

    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let file_name = path.file_name()?.to_string_lossy();
        if file_name.starts_with(&format!("{AI_SIDECAR_BINARY_NAME}-"))
            && (!cfg!(windows) || file_name.ends_with(".exe"))
        {
            return Some(path);
        }
    }

    None
}

fn sidecar_runtime_binary_name() -> String {
    if cfg!(windows) {
        format!("{AI_SIDECAR_BINARY_NAME}.exe")
    } else {
        AI_SIDECAR_BINARY_NAME.to_string()
    }
}

fn sidecar_command_description() -> String {
    sidecar_command()
        .map(|(_, _, description)| description)
        .unwrap_or_else(|error| error)
}

fn shell_command(command: String) -> (String, Vec<String>) {
    if cfg!(windows) {
        ("cmd".to_string(), vec!["/C".to_string(), command])
    } else {
        ("sh".to_string(), vec!["-lc".to_string(), command])
    }
}

fn default_python_command() -> String {
    if cfg!(windows) {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

fn sidecar_host_port() -> (String, u16) {
    parse_http_url(&ai_endpoint())
        .map(|(host, port, _)| (host, port))
        .unwrap_or_else(|_| ("127.0.0.1".to_string(), 7851))
}

fn sidecar_script_path() -> Option<PathBuf> {
    if let Some(path) = env_non_empty("SHAPE_AI_SIDECAR_SCRIPT").map(PathBuf::from) {
        if path.exists() {
            return Some(path);
        }
    }

    let mut roots = Vec::new();
    if let Ok(current_dir) = env::current_dir() {
        roots.push(current_dir);
    }
    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            roots.push(parent.to_path_buf());
        }
    }

    for root in roots {
        if let Some(path) = find_sidecar_script_from(&root) {
            return Some(path);
        }
    }

    None
}

fn find_sidecar_script_from(root: &Path) -> Option<PathBuf> {
    for ancestor in root.ancestors() {
        let candidate = ancestor.join("apps").join("ai-sidecar").join("server.py");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn sidecar_log_path() -> PathBuf {
    env::temp_dir()
        .join("shape-meet-debug")
        .join("ai-sidecar.log")
}

fn open_sidecar_log_file() -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(sidecar_log_path())
        .map_err(|error| error.to_string())
}

fn append_sidecar_log(message: &str) -> Result<(), String> {
    let mut file = open_sidecar_log_file()?;
    let timestamp = utc_timestamp().unwrap_or_else(|_| "unknown-time".to_string());
    writeln!(file, "[{timestamp}] {message}").map_err(|error| error.to_string())
}

fn read_sidecar_log_tail(max_lines: usize) -> Vec<String> {
    let Ok(content) = fs::read_to_string(sidecar_log_path()) else {
        return Vec::new();
    };
    let mut lines = content
        .lines()
        .rev()
        .take(max_lines)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.reverse();
    lines
}

fn read_http_json(url: &str) -> Result<Value, String> {
    let (host, port, path) = parse_http_url(url)?;
    let address = first_socket_addr(&host, port)?;
    let timeout = Duration::from_millis(HTTP_TIMEOUT_MS);
    let mut stream =
        TcpStream::connect_timeout(&address, timeout).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;

    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "respuesta HTTP inválida".to_string())?;

    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        return Err(headers.lines().next().unwrap_or("HTTP error").to_string());
    }

    serde_json::from_str(body).map_err(|error| error.to_string())
}

fn parse_http_url(url: &str) -> Result<(String, u16, String), String> {
    let without_scheme = url
        .strip_prefix("http://")
        .ok_or_else(|| "solo se soporta http:// para el sidecar local".to_string())?;
    let (authority, path) = without_scheme
        .split_once('/')
        .unwrap_or((without_scheme, "health"));
    let (host, port) = authority
        .rsplit_once(':')
        .map(|(host, port)| {
            let parsed_port = port.parse::<u16>().unwrap_or(80);
            (host.to_string(), parsed_port)
        })
        .unwrap_or_else(|| (authority.to_string(), 80));

    Ok((host, port, format!("/{path}")))
}

fn first_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| "no se pudo resolver el endpoint local".to_string())
}

fn redacted_environment() -> Value {
    let runtime_env = read_ai_runtime_env_file().ok();
    json!({
        "sentryDsnConfigured": sentry_dsn().is_some(),
        "aiServiceUrl": ai_endpoint(),
        "identityArtifactCacheDir": identity_cache_dir().map(|path| path.display().to_string()).unwrap_or_else(|error| error),
        "aiRuntimeEnv": runtime_env.map(|file| json!({
            "path": file.path,
            "exists": file.exists,
            "configuredKeys": file.configured_keys,
            "warnings": file.warnings
        })),
        "sentryEnvironment": sentry_environment(),
        "sentryRelease": sentry_release()
    })
}

fn sentry_dsn() -> Option<String> {
    local_config_value(&["SENTRY_DSN", "VITE_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"])
}

fn sentry_environment() -> String {
    local_config_value(&[
        "SENTRY_ENVIRONMENT",
        "VITE_SENTRY_ENVIRONMENT",
        "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
    ])
    .unwrap_or_else(|| "development".to_string())
}

fn sentry_release() -> String {
    local_config_value(&[
        "SENTRY_RELEASE",
        "VITE_SENTRY_RELEASE",
        "NEXT_PUBLIC_SENTRY_RELEASE",
    ])
    .unwrap_or_else(|| format!("shape-meet-desktop@{}", env!("CARGO_PKG_VERSION")))
}

fn sentry_traces_sample_rate() -> f32 {
    local_config_value(&[
        "SENTRY_TRACES_SAMPLE_RATE",
        "VITE_SENTRY_TRACES_SAMPLE_RATE",
        "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE",
    ])
    .and_then(|value| value.parse::<f32>().ok())
    .filter(|value| (0.0..=1.0).contains(value))
    .unwrap_or(1.0)
}

fn sentry_debug() -> bool {
    local_config_value(&[
        "SENTRY_DEBUG",
        "VITE_SENTRY_DEBUG",
        "NEXT_PUBLIC_SENTRY_DEBUG",
    ])
    .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
    .unwrap_or(false)
}

fn local_config_value(keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = env_non_empty(key) {
            return Some(value);
        }
    }

    for path in local_env_file_candidates() {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };

        if let Some(value) = parse_local_env_value(&content, keys) {
            return Some(value);
        }
    }

    None
}

fn local_env_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(current_dir) = env::current_dir() {
        push_env_file_candidates(&mut candidates, &current_dir);
    }

    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        push_env_file_candidates(&mut candidates, &PathBuf::from(manifest_dir));
    }

    let mut deduped = Vec::new();
    for path in candidates {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }

    deduped
}

fn push_env_file_candidates(candidates: &mut Vec<PathBuf>, start: &Path) {
    let mut current = Some(start);
    for _ in 0..4 {
        let Some(dir) = current else {
            break;
        };
        candidates.push(dir.join(".env.local"));
        current = dir.parent();
    }
}

fn parse_local_env_value(content: &str, keys: &[&str]) -> Option<String> {
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };

        let key = raw_key.trim();
        if !keys.iter().any(|candidate| *candidate == key) {
            continue;
        }

        let value = unquote_env_value(raw_value.trim());
        if !value.is_empty() {
            return Some(value);
        }
    }

    None
}

fn ai_endpoint() -> String {
    env::var("SHAPE_AI_SERVICE_URL").unwrap_or_else(|_| DEFAULT_AI_ENDPOINT.to_string())
}

fn env_non_empty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn utc_timestamp() -> Result<String, String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_allowed_ai_runtime_env_keys() {
        let parsed = parse_ai_runtime_env(
            r#"
            # comment
            SHAPE_AI_MODE=adapter-contract
            SHAPE_VIDEO_FRAME_COMMAND="C:\models\video.exe --input {input} --output {output}"
            CUDA_VISIBLE_DEVICES=0
            ORT_LOGGING_LEVEL=3
            "#,
        );

        assert!(parsed.errors.is_empty());
        assert!(parsed.warnings.is_empty());
        assert_eq!(
            parsed.keys,
            vec![
                "SHAPE_AI_MODE",
                "SHAPE_VIDEO_FRAME_COMMAND",
                "CUDA_VISIBLE_DEVICES",
                "ORT_LOGGING_LEVEL"
            ]
        );
        assert_eq!(
            parsed.values[1].1,
            r"C:\models\video.exe --input {input} --output {output}"
        );
    }

    #[test]
    fn rejects_duplicate_ai_runtime_env_keys() {
        let parsed = parse_ai_runtime_env(
            r#"
            SHAPE_AI_MODE=adapter-contract
            SHAPE_AI_MODE=development-passthrough
            "#,
        );

        assert_eq!(parsed.errors.len(), 1);
        assert!(parsed.errors[0].contains("duplicada"));
    }

    #[test]
    fn warns_on_unrelated_ai_runtime_env_keys() {
        let parsed = parse_ai_runtime_env(
            r#"
            DATABASE_URL=postgres://example
            SHAPE_VOICE_ENGINE=vcclient000
            "#,
        );

        assert!(parsed.errors.is_empty());
        assert_eq!(parsed.values.len(), 1);
        assert_eq!(parsed.values[0].0, "SHAPE_VOICE_ENGINE");
        assert_eq!(parsed.warnings.len(), 1);
        assert!(parsed.warnings[0].contains("no permitida"));
    }
}
