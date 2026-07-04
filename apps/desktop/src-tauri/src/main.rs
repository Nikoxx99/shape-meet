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
const DEFAULT_SHAPE_PUBLIC_URL: &str = "https://shape-meet-admin.15.235.86.211.sslip.io";
const DEFAULT_DESKTOP_API_URL: &str = DEFAULT_SHAPE_PUBLIC_URL;
const DEFAULT_DESKTOP_APP_URL: &str = DEFAULT_SHAPE_PUBLIC_URL;
const DEFAULT_SENTRY_DSN: &str =
    "https://5fce4a869b7ce84b0e8e7ff1cdef7c4a@o905297.ingest.us.sentry.io/5843617";
const HTTP_TIMEOUT_MS: u64 = 1200;
const ARTIFACT_DOWNLOAD_TIMEOUT_SECS: u64 = 900;
const AI_SIDECAR_BINARY_NAME: &str = "shape-ai-sidecar";
const AI_PROCESSOR_BINARY_NAME: &str = "shape-ai-processor";
const AI_MODEL_ENDPOINT_BINARY_NAME: &str = "shape-model-endpoint";

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
struct DesktopRuntimeConfig {
    api_base_url: String,
    app_base_url: String,
    meeting_base_url: String,
    ai_service_url: String,
    host_identifier: Option<String>,
    demo_data_enabled: bool,
    sentry_dsn: Option<String>,
    sentry_environment: String,
    sentry_release: String,
    sentry_traces_sample_rate: f32,
    sentry_debug: bool,
    config_path: Option<String>,
    warnings: Vec<String>,
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
struct ModelEndpointState {
    supervisor: Mutex<ModelEndpointSupervisor>,
}

#[derive(Default)]
struct SidecarSupervisor {
    child: Option<Child>,
    last_exit: Option<String>,
}

#[derive(Default)]
struct ModelEndpointSupervisor {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRuntimeDoctorReport {
    ok: bool,
    status: String,
    profile: String,
    runtime_path: String,
    runtime_exists: bool,
    passthrough_enabled: bool,
    real_models_configured: bool,
    checks: Vec<AiRuntimeDoctorCheck>,
    next_steps: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRuntimeDoctorCheck {
    id: String,
    label: String,
    status: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAiRuntimeEnvInput {
    content: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PrepareDemoAiRuntimeEnvInput {
    video_processor_port: Option<String>,
    audio_processor_port: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PrepareModelAiRuntimeEnvInput {
    runtime_preset: Option<String>,
    workstation_profile: Option<String>,
    wrapper_passthrough: Option<bool>,
    video_processor_port: Option<String>,
    audio_processor_port: Option<String>,
    model_endpoint_host: Option<String>,
    model_endpoint_port: Option<String>,
    video_frame_endpoint: Option<String>,
    face_endpoint: Option<String>,
    background_endpoint: Option<String>,
    audio_chunk_endpoint: Option<String>,
    voice_endpoint: Option<String>,
    facefusion_dir: Option<String>,
    facefusion_python: Option<String>,
    facefusion_providers: Option<String>,
    facefusion_processors: Option<String>,
    facefusion_extra_args: Option<String>,
    bmv2_repo_dir: Option<String>,
    bmv2_python: Option<String>,
    bmv2_checkpoint: Option<String>,
    bmv2_device: Option<String>,
    bmv2_extra_args: Option<String>,
    vcclient000_http_endpoint: Option<String>,
    vcclient000_http_mode: Option<String>,
    model_timeout_secs: Option<String>,
    processor_timeout_secs: Option<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityArtifactCacheResult {
    identity_id: String,
    cached: bool,
    local_path: Option<String>,
    uri: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
    package_dir: Option<String>,
    package_manifest: Option<Value>,
    face_source_path: Option<String>,
    voice_model_path: Option<String>,
    voice_index_path: Option<String>,
    voice_config_path: Option<String>,
    background_assets_path: Option<String>,
    warnings: Vec<String>,
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
fn get_desktop_runtime_config() -> DesktopRuntimeConfig {
    desktop_runtime_config()
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
fn get_model_endpoint_runtime(state: State<'_, ModelEndpointState>) -> AiSidecarRuntime {
    let mut supervisor = state
        .supervisor
        .lock()
        .expect("model endpoint supervisor lock poisoned");
    supervisor.runtime_status()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StartModelEndpointInput {
    passthrough: Option<bool>,
    demo_effects: Option<bool>,
}

#[tauri::command]
fn start_model_endpoint(
    state: State<'_, ModelEndpointState>,
    input: Option<StartModelEndpointInput>,
) -> Result<AiSidecarRuntime, String> {
    let mut supervisor = state.supervisor.lock().map_err(|error| error.to_string())?;
    supervisor.start(input.unwrap_or_default())
}

#[tauri::command]
fn stop_model_endpoint(state: State<'_, ModelEndpointState>) -> Result<AiSidecarRuntime, String> {
    let mut supervisor = state.supervisor.lock().map_err(|error| error.to_string())?;
    supervisor.stop()
}

#[tauri::command]
fn get_ai_runtime_env() -> Result<AiRuntimeEnvFile, String> {
    read_ai_runtime_env_file()
}

#[tauri::command]
fn doctor_ai_runtime_env() -> Result<AiRuntimeDoctorReport, String> {
    let path = ai_runtime_env_path()?;
    let exists = path.exists();
    let content = if exists {
        fs::read_to_string(&path).map_err(|error| error.to_string())?
    } else {
        default_ai_runtime_env_template()
    };

    Ok(doctor_ai_runtime_env_report(&path, exists, &content))
}

#[tauri::command]
fn save_ai_runtime_env(input: SaveAiRuntimeEnvInput) -> Result<AiRuntimeEnvFile, String> {
    write_ai_runtime_env_file(&input.content)?;
    read_ai_runtime_env_file()
}

#[tauri::command]
fn prepare_demo_ai_runtime_env(
    input: Option<PrepareDemoAiRuntimeEnvInput>,
) -> Result<AiRuntimeEnvFile, String> {
    let ports = ai_runtime_processor_ports(
        input
            .as_ref()
            .and_then(|value| value.video_processor_port.as_deref()),
        input
            .as_ref()
            .and_then(|value| value.audio_processor_port.as_deref()),
    )?;
    let content = demo_ai_runtime_env_content(&processor_command_for_demo()?, ports);
    write_ai_runtime_env_file(&content)?;
    read_ai_runtime_env_file()
}

#[tauri::command]
fn prepare_model_ai_runtime_env(
    input: Option<PrepareModelAiRuntimeEnvInput>,
) -> Result<AiRuntimeEnvFile, String> {
    let content = model_ai_runtime_env_content(&processor_command_for_demo()?, input.as_ref())?;
    write_ai_runtime_env_file(&content)?;
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
        "aiRuntimeDoctor": doctor_ai_runtime_env().ok(),
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
        .manage(ModelEndpointState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_gpu_profile,
            get_observability_status,
            get_desktop_runtime_config,
            capture_native_debug_event,
            get_ai_service_status,
            get_ai_sidecar_runtime,
            start_ai_sidecar,
            stop_ai_sidecar,
            get_model_endpoint_runtime,
            start_model_endpoint,
            stop_model_endpoint,
            get_ai_runtime_env,
            doctor_ai_runtime_env,
            save_ai_runtime_env,
            prepare_demo_ai_runtime_env,
            prepare_model_ai_runtime_env,
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

impl ModelEndpointSupervisor {
    fn runtime_status(&mut self) -> AiSidecarRuntime {
        self.reap_finished_child();

        if let Some(child) = self.child.as_mut() {
            return AiSidecarRuntime {
                endpoint: model_endpoint_url(),
                managed: true,
                running: true,
                pid: Some(child.id()),
                command: Some(model_endpoint_command_description()),
                log_path: model_endpoint_log_path().display().to_string(),
                message: "Servidor de endpoints IA gestionado por Shape Meet.".to_string(),
                last_exit: self.last_exit.clone(),
            };
        }

        let online = model_endpoint_online();
        AiSidecarRuntime {
            endpoint: model_endpoint_url(),
            managed: false,
            running: online,
            pid: None,
            command: Some(model_endpoint_command_description()),
            log_path: model_endpoint_log_path().display().to_string(),
            message: if online {
                "Servidor de endpoints IA externo detectado.".to_string()
            } else {
                "Servidor de endpoints IA detenido.".to_string()
            },
            last_exit: self.last_exit.clone(),
        }
    }

    fn start(&mut self, input: StartModelEndpointInput) -> Result<AiSidecarRuntime, String> {
        self.reap_finished_child();

        if self.child.is_some() {
            return Ok(self.runtime_status());
        }

        if model_endpoint_online() {
            return Ok(AiSidecarRuntime {
                endpoint: model_endpoint_url(),
                managed: false,
                running: true,
                pid: None,
                command: Some(model_endpoint_command_description()),
                log_path: model_endpoint_log_path().display().to_string(),
                message: "Servidor de endpoints IA externo ya está activo.".to_string(),
                last_exit: self.last_exit.clone(),
            });
        }

        let log_path = model_endpoint_log_path();
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        append_model_endpoint_log("starting model endpoint server")?;

        let (program, args, description) = model_endpoint_command()?;
        let mut runtime_env = load_ai_runtime_env()?;
        if input.demo_effects.unwrap_or(false) {
            upsert_env_value(
                &mut runtime_env,
                "SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS",
                "true",
            );
            upsert_env_value(
                &mut runtime_env,
                "SHAPE_MODEL_ENDPOINT_PASSTHROUGH",
                "false",
            );
            upsert_env_value(&mut runtime_env, "SHAPE_WRAPPER_PASSTHROUGH", "false");
        } else if let Some(passthrough) = input.passthrough {
            upsert_env_value(
                &mut runtime_env,
                "SHAPE_MODEL_ENDPOINT_PASSTHROUGH",
                if passthrough { "true" } else { "false" },
            );
        }
        if !runtime_env.is_empty() {
            append_model_endpoint_log(&format!(
                "loading model endpoint env keys: {}",
                runtime_env
                    .iter()
                    .map(|(key, _)| key.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))?;
        }

        let stdout_log = open_model_endpoint_log_file()?;
        let stderr_log = stdout_log.try_clone().map_err(|error| error.to_string())?;
        let mut command = Command::new(&program);
        command
            .args(&args)
            .envs(runtime_env.iter().map(|(key, value)| (key, value)))
            .stdout(Stdio::from(stdout_log))
            .stderr(Stdio::from(stderr_log))
            .stdin(Stdio::null());
        let child = command.spawn().map_err(|error| {
            format!("No se pudo iniciar servidor de endpoints IA con {description}: {error}")
        })?;

        self.child = Some(child);
        self.last_exit = None;

        for _ in 0..12 {
            thread::sleep(Duration::from_millis(250));
            self.reap_finished_child();
            if model_endpoint_online() || self.child.is_none() {
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
            append_model_endpoint_log(&format!(
                "stopped managed model endpoint pid {pid}: {status}"
            ))?;
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
                let _ = append_model_endpoint_log(&format!(
                    "managed model endpoint pid {pid} exited: {status}"
                ));
                self.child = None;
            }
            Ok(None) => {}
            Err(error) => {
                self.last_exit = Some(format!("error consultando endpoint IA: {error}"));
                let _ = append_model_endpoint_log(&format!(
                    "managed model endpoint status error: {error}"
                ));
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
    if let Err(error) = validate_artifact_integrity(input, size_bytes, &actual_sha) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp_path, target_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("No se pudo finalizar cache de artefacto: {error}"));
    }

    let mut result = identity_artifact_result(
        identity_id,
        true,
        Some(target_path),
        Some(uri),
        Some(&actual_sha),
        Some(size_bytes),
        "Artefacto cacheado y validado localmente.",
    );
    attach_identity_package_metadata(&mut result, target_path)?;
    Ok(result)
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

    let mut result = identity_artifact_result(
        identity_id,
        true,
        Some(target_path),
        Some(uri),
        actual_sha.as_deref().or(input.artifact_sha256.as_deref()),
        Some(metadata.len()),
        "Artefacto reutilizado desde cache local.",
    );
    attach_identity_package_metadata(&mut result, target_path)?;
    Ok(Some(result))
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

fn doctor_ai_runtime_env_report(path: &Path, exists: bool, content: &str) -> AiRuntimeDoctorReport {
    let parsed = parse_ai_runtime_env(content);
    let profile = env_lookup(&parsed.values, "SHAPE_MODEL_WORKSTATION_PROFILE")
        .unwrap_or("manual")
        .to_string();
    let passthrough_enabled = env_bool(&parsed.values, "SHAPE_WRAPPER_PASSTHROUGH")
        .unwrap_or(false)
        || env_bool(&parsed.values, "SHAPE_PROCESSOR_DEMO_EFFECTS").unwrap_or(false);
    let mut checks = Vec::new();
    let mut next_steps = Vec::new();

    if exists {
        push_doctor_check(
            &mut checks,
            "runtime-file",
            "Runtime",
            "ok",
            format!("Archivo cargado: {}", path.display()),
        );
    } else {
        push_doctor_check(
            &mut checks,
            "runtime-file",
            "Runtime",
            "warn",
            "No existe archivo runtime IA; se está usando plantilla.".to_string(),
        );
        push_next_step(&mut next_steps, "Carga demo o wrappers antes de probar IA.");
    }

    for warning in &parsed.warnings {
        push_doctor_check(
            &mut checks,
            "runtime-warning",
            "Variables",
            "warn",
            warning.clone(),
        );
    }
    for error in &parsed.errors {
        push_doctor_check(
            &mut checks,
            "runtime-error",
            "Variables",
            "error",
            error.clone(),
        );
    }

    let video_pipeline_ready = check_command_or_endpoint(
        &mut checks,
        &mut next_steps,
        &parsed.values,
        CommandOrEndpointSpec {
            id: "video-pipeline",
            label: "Pipeline video",
            command_key: "SHAPE_VIDEO_PROCESSOR_COMMAND",
            endpoint_key: "SHAPE_VIDEO_PROCESSOR_ENDPOINT",
            next_step: "Configura SHAPE_VIDEO_PROCESSOR_COMMAND y SHAPE_VIDEO_PROCESSOR_ENDPOINT.",
        },
    );
    let audio_pipeline_ready = check_command_or_endpoint(
        &mut checks,
        &mut next_steps,
        &parsed.values,
        CommandOrEndpointSpec {
            id: "audio-pipeline",
            label: "Pipeline voz",
            command_key: "SHAPE_AUDIO_PROCESSOR_COMMAND",
            endpoint_key: "SHAPE_AUDIO_PROCESSOR_ENDPOINT",
            next_step: "Configura SHAPE_AUDIO_PROCESSOR_COMMAND y SHAPE_AUDIO_PROCESSOR_ENDPOINT.",
        },
    );

    if passthrough_enabled {
        push_doctor_check(
            &mut checks,
            "passthrough",
            "Passthrough",
            "warn",
            "Passthrough activo; el preflight valida transporte, no modelos reales.".to_string(),
        );
        push_next_step(
            &mut next_steps,
            "Desactiva SHAPE_WRAPPER_PASSTHROUGH cuando FaceFusion, BMV2 y vcclient000 estén instalados.",
        );
    } else {
        push_doctor_check(
            &mut checks,
            "passthrough",
            "Passthrough",
            "ok",
            "Passthrough desactivado para validar modelos reales.".to_string(),
        );
    }

    let face_ready = check_facefusion_runtime(&mut checks, &mut next_steps, &parsed.values);
    let background_ready = check_bmv2_runtime(&mut checks, &mut next_steps, &parsed.values);
    let voice_ready = check_vcclient_runtime(&mut checks, &mut next_steps, &parsed.values);
    let error_count = checks
        .iter()
        .filter(|check| check.status == "error")
        .count();
    let real_models_configured = !passthrough_enabled
        && video_pipeline_ready
        && audio_pipeline_ready
        && face_ready
        && background_ready
        && voice_ready
        && error_count == 0;
    let status = if error_count > 0 {
        "error"
    } else if real_models_configured {
        "ready"
    } else {
        "warning"
    };

    AiRuntimeDoctorReport {
        ok: error_count == 0,
        status: status.to_string(),
        profile,
        runtime_path: path.display().to_string(),
        runtime_exists: exists,
        passthrough_enabled,
        real_models_configured,
        checks,
        next_steps,
    }
}

struct CommandOrEndpointSpec<'a> {
    id: &'a str,
    label: &'a str,
    command_key: &'a str,
    endpoint_key: &'a str,
    next_step: &'a str,
}

fn check_command_or_endpoint(
    checks: &mut Vec<AiRuntimeDoctorCheck>,
    next_steps: &mut Vec<String>,
    values: &[(String, String)],
    spec: CommandOrEndpointSpec,
) -> bool {
    let command = env_lookup(values, spec.command_key);
    let endpoint = env_lookup(values, spec.endpoint_key);
    if command.is_some() && endpoint.is_some() {
        push_doctor_check(
            checks,
            spec.id,
            spec.label,
            "ok",
            format!("{} y {} configurados.", spec.command_key, spec.endpoint_key),
        );
        true
    } else {
        push_doctor_check(
            checks,
            spec.id,
            spec.label,
            "error",
            format!("Falta {} o {}.", spec.command_key, spec.endpoint_key),
        );
        push_next_step(next_steps, spec.next_step);
        false
    }
}

fn check_facefusion_runtime(
    checks: &mut Vec<AiRuntimeDoctorCheck>,
    next_steps: &mut Vec<String>,
    values: &[(String, String)],
) -> bool {
    let command_ready = check_command_placeholders(
        checks,
        next_steps,
        values,
        "face-command",
        "FaceFusion comando",
        "SHAPE_FACE_COMMAND",
        &["input", "output", "identity"],
        "Configura SHAPE_FACE_COMMAND con {input}, {output} e {identity}.",
    );
    let dir_ready = check_runtime_path(
        checks,
        next_steps,
        env_lookup(values, "FACEFUSION_DIR"),
        "facefusion-dir",
        "FaceFusion repo",
        true,
        "Configura FACEFUSION_DIR con el repo FaceFusion instalado.",
    );
    let python_ready = check_runtime_path(
        checks,
        next_steps,
        env_lookup(values, "FACEFUSION_PYTHON"),
        "facefusion-python",
        "FaceFusion Python",
        false,
        "Configura FACEFUSION_PYTHON con el venv de FaceFusion.",
    );

    command_ready && dir_ready && python_ready
}

fn check_bmv2_runtime(
    checks: &mut Vec<AiRuntimeDoctorCheck>,
    next_steps: &mut Vec<String>,
    values: &[(String, String)],
) -> bool {
    let command_ready = check_command_placeholders(
        checks,
        next_steps,
        values,
        "bmv2-command",
        "BMV2 comando",
        "SHAPE_BACKGROUND_COMMAND",
        &["input", "output", "clean_plate"],
        "Configura SHAPE_BACKGROUND_COMMAND con {input}, {output} y {clean_plate}.",
    );
    let repo_ready = check_runtime_path(
        checks,
        next_steps,
        env_lookup(values, "BMV2_REPO_DIR"),
        "bmv2-repo",
        "BMV2 repo",
        true,
        "Configura BMV2_REPO_DIR con BackgroundMattingV2 instalado.",
    );
    let python_ready = check_runtime_path(
        checks,
        next_steps,
        env_lookup(values, "BMV2_PYTHON"),
        "bmv2-python",
        "BMV2 Python",
        false,
        "Configura BMV2_PYTHON con el venv de BackgroundMattingV2.",
    );
    let checkpoint_ready = check_runtime_path(
        checks,
        next_steps,
        env_lookup(values, "BMV2_MODEL_CHECKPOINT"),
        "bmv2-checkpoint",
        "BMV2 checkpoint",
        false,
        "Configura BMV2_MODEL_CHECKPOINT antes de probar fondo real.",
    );

    command_ready && repo_ready && python_ready && checkpoint_ready
}

fn check_vcclient_runtime(
    checks: &mut Vec<AiRuntimeDoctorCheck>,
    next_steps: &mut Vec<String>,
    values: &[(String, String)],
) -> bool {
    let endpoint = env_lookup(values, "VCCLIENT000_HTTP_ENDPOINT");
    let chunk_command = env_lookup(values, "VCCLIENT000_CHUNK_COMMAND");
    let voice_command = env_lookup(values, "SHAPE_VOICE_COMMAND");
    let mut endpoint_ready = false;
    let mut command_ready = false;

    if let Some(endpoint) = endpoint {
        if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
            push_doctor_check(
                checks,
                "vcclient-endpoint",
                "vcclient000 REST",
                "ok",
                format!("Endpoint configurado: {endpoint}"),
            );
            endpoint_ready = true;
        } else {
            push_doctor_check(
                checks,
                "vcclient-endpoint",
                "vcclient000 REST",
                "error",
                "VCCLIENT000_HTTP_ENDPOINT debe iniciar con http:// o https://.".to_string(),
            );
            push_next_step(
                next_steps,
                "Corrige VCCLIENT000_HTTP_ENDPOINT para w-okada/VCClient.",
            );
        }
    }

    if chunk_command.is_some() || voice_command.is_some() {
        let command_key = if chunk_command.is_some() {
            "VCCLIENT000_CHUNK_COMMAND"
        } else {
            "SHAPE_VOICE_COMMAND"
        };
        command_ready = check_command_placeholders(
            checks,
            next_steps,
            values,
            "vcclient-command",
            "vcclient000 comando",
            command_key,
            &["input", "output", "sample_rate"],
            "Configura el comando de voz con {input}, {output} y {sample_rate}.",
        );
    }

    if endpoint_ready || command_ready {
        return true;
    }

    push_doctor_check(
        checks,
        "vcclient-ready",
        "vcclient000",
        "error",
        "No hay endpoint REST ni comando de voz válido.".to_string(),
    );
    push_next_step(
        next_steps,
        "Arranca vcclient000 localmente y configura VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18888/test.",
    );
    false
}

fn check_command_placeholders(
    checks: &mut Vec<AiRuntimeDoctorCheck>,
    next_steps: &mut Vec<String>,
    values: &[(String, String)],
    id: &str,
    label: &str,
    key: &str,
    placeholders: &[&str],
    next_step: &str,
) -> bool {
    let Some(command) = env_lookup(values, key) else {
        push_doctor_check(
            checks,
            id,
            label,
            "error",
            format!("{key} no está configurado."),
        );
        push_next_step(next_steps, next_step);
        return false;
    };
    let missing: Vec<&str> = placeholders
        .iter()
        .copied()
        .filter(|placeholder| !command.contains(&format!("{{{placeholder}}}")))
        .collect();
    if missing.is_empty() {
        push_doctor_check(
            checks,
            id,
            label,
            "ok",
            format!("{key} contiene placeholders requeridos."),
        );
        true
    } else {
        push_doctor_check(
            checks,
            id,
            label,
            "error",
            format!("{key} no incluye: {}.", missing.join(", ")),
        );
        push_next_step(next_steps, next_step);
        false
    }
}

fn check_runtime_path(
    checks: &mut Vec<AiRuntimeDoctorCheck>,
    next_steps: &mut Vec<String>,
    value: Option<&str>,
    id: &str,
    label: &str,
    directory: bool,
    next_step: &str,
) -> bool {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        push_doctor_check(
            checks,
            id,
            label,
            "error",
            format!("{label} no configurado."),
        );
        push_next_step(next_steps, next_step);
        return false;
    };
    let Some(path) = verifiable_runtime_path(value) else {
        push_doctor_check(
            checks,
            id,
            label,
            "warn",
            format!("{label} no verificable en este sistema: {value}"),
        );
        push_next_step(next_steps, next_step);
        return false;
    };
    let metadata = fs::metadata(&path);
    let exists = metadata
        .as_ref()
        .map(|metadata| {
            if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            }
        })
        .unwrap_or(false);
    if exists {
        push_doctor_check(checks, id, label, "ok", format!("{label} listo: {value}"));
        true
    } else {
        push_doctor_check(
            checks,
            id,
            label,
            "error",
            format!("{label} no existe o no es válido: {value}"),
        );
        push_next_step(next_steps, next_step);
        false
    }
}

fn push_doctor_check(
    checks: &mut Vec<AiRuntimeDoctorCheck>,
    id: &str,
    label: &str,
    status: &str,
    message: String,
) {
    checks.push(AiRuntimeDoctorCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        message,
    });
}

fn push_next_step(next_steps: &mut Vec<String>, message: &str) {
    if !next_steps.iter().any(|step| step == message) {
        next_steps.push(message.to_string());
    }
}

fn env_lookup<'a>(values: &'a [(String, String)], key: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.as_str())
}

fn env_bool(values: &[(String, String)], key: &str) -> Option<bool> {
    env_lookup(values, key).map(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn verifiable_runtime_path(value: &str) -> Option<PathBuf> {
    if is_windows_path_string(value) && !cfg!(windows) {
        return None;
    }
    if value == "~" {
        return home_dir().map(PathBuf::from);
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home_dir().map(|home| PathBuf::from(home).join(rest));
    }

    Some(PathBuf::from(value))
}

fn is_windows_path_string(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn home_dir() -> Option<String> {
    env::var("HOME")
        .ok()
        .or_else(|| env::var("USERPROFILE").ok())
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

fn upsert_env_value(values: &mut Vec<(String, String)>, key: &str, value: &str) {
    if let Some((_, current_value)) = values
        .iter_mut()
        .find(|(current_key, _)| current_key == key)
    {
        *current_value = value.to_string();
        return;
    }

    values.push((key.to_string(), value.to_string()));
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
        || key.starts_with("FACEFUSION_")
        || key.starts_with("BMV2_")
        || key.starts_with("VCCLIENT000_")
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
        "# SHAPE_MODEL_WORKSTATION_PROFILE=windows-nvidia",
        "# Demo sin modelos reales: pnpm demo:ai-runtime genera un archivo listo.",
        "# Wrappers locales: pnpm models:runtime -- --preset local-wrappers --passthrough.",
        "# SHAPE_PROCESSOR_DEMO_EFFECTS=true",
        "# SHAPE_VIDEO_PROCESSOR_COMMAND=shape-ai-processor --kind video --port 7860",
        "# Comando combinado de video: recibe frame, identidad y clean plate.",
        "# SHAPE_VIDEO_FRAME_COMMAND=C:\\\\shape-models\\\\video-wrapper.exe --input {input} --output {output} --identity {identity} --clean-plate {clean_plate}",
        "# O comandos separados por etapa; se ejecutan segun los efectos activos.",
        "# SHAPE_FACE_COMMAND=C:\\\\shape-models\\\\facefusion-wrapper.exe --input {input} --output {output} --identity {identity}",
        "# SHAPE_BACKGROUND_COMMAND=C:\\\\shape-models\\\\backgroundmattingv2-wrapper.exe --input {input} --output {output} --clean-plate {clean_plate}",
        "# SHAPE_AUDIO_PROCESSOR_COMMAND=shape-ai-processor --kind audio --port 7861",
        "# SHAPE_AUDIO_CHUNK_COMMAND=C:\\\\shape-models\\\\voice-wrapper.exe --input {input} --output {output} --sample-rate {sample_rate}",
        "# SHAPE_VOICE_COMMAND=C:\\\\shape-models\\\\vcclient000-wrapper.exe --input {input} --output {output} --sample-rate {sample_rate}",
        "# FACEFUSION_DIR=C:\\\\models\\\\FaceFusion",
        "# BMV2_REPO_DIR=C:\\\\models\\\\BackgroundMattingV2",
        "# BMV2_MODEL_CHECKPOINT=C:\\\\models\\\\BackgroundMattingV2\\\\pytorch_resnet50.pth",
        "# VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18888/test",
        "# VCCLIENT000_HTTP_MODE=w-okada-rest",
        "",
    ]
    .join("\n")
}

#[derive(Clone, Copy)]
struct AiRuntimeProcessorPorts {
    video: u16,
    audio: u16,
}

fn ai_runtime_processor_ports(
    video_value: Option<&str>,
    audio_value: Option<&str>,
) -> Result<AiRuntimeProcessorPorts, String> {
    let video = ai_runtime_processor_port(video_value, 7860, "Video")?;
    let audio = ai_runtime_processor_port(audio_value, 7861, "Audio")?;
    if video == audio {
        return Err("Los puertos de procesador de video y audio deben ser diferentes.".to_string());
    }

    Ok(AiRuntimeProcessorPorts { video, audio })
}

fn ai_runtime_processor_port(
    value: Option<&str>,
    default: u16,
    label: &str,
) -> Result<u16, String> {
    let Some(value) = trimmed_model_input_value(value) else {
        return Ok(default);
    };
    let port = value
        .parse::<u16>()
        .map_err(|_| format!("Puerto {label}: usa un número entre 1 y 65535."))?;
    if port == 0 {
        return Err(format!("Puerto {label}: usa un número entre 1 y 65535."));
    }

    Ok(port)
}

fn demo_ai_runtime_env_content(processor_command: &str, ports: AiRuntimeProcessorPorts) -> String {
    [
        "# Shape Meet demo AI runtime",
        "# Procesadores locales para validar el pipeline sin modelos reales.",
        "SHAPE_AI_MODE=adapter-contract",
        "SHAPE_FACE_ENGINE=shape-demo-facefusion",
        "SHAPE_BACKGROUND_ENGINE=shape-demo-backgroundmattingv2",
        "SHAPE_VOICE_ENGINE=shape-demo-vcclient000",
        "SHAPE_PROCESSOR_DEMO_EFFECTS=true",
        "SHAPE_PROCESSOR_TIMEOUT_SECS=2",
        &format!(
            "SHAPE_VIDEO_PROCESSOR_COMMAND={processor_command} --kind video --host 127.0.0.1 --port {}",
            ports.video
        ),
        &format!(
            "SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:{}/process-frame",
            ports.video
        ),
        &format!(
            "SHAPE_VIDEO_PROCESSOR_HEALTH_URL=http://127.0.0.1:{}/health",
            ports.video
        ),
        &format!(
            "SHAPE_AUDIO_PROCESSOR_COMMAND={processor_command} --kind audio --host 127.0.0.1 --port {}",
            ports.audio
        ),
        &format!(
            "SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:{}/process-audio",
            ports.audio
        ),
        &format!(
            "SHAPE_AUDIO_PROCESSOR_HEALTH_URL=http://127.0.0.1:{}/health",
            ports.audio
        ),
        "",
    ]
    .join("\n")
}

fn model_ai_runtime_env_content(
    processor_command: &str,
    input: Option<&PrepareModelAiRuntimeEnvInput>,
) -> Result<String, String> {
    let runtime_preset =
        trimmed_model_input_value(input.and_then(|value| value.runtime_preset.as_deref()))
            .unwrap_or_else(|| "local-wrappers".to_string());
    let endpoint_runtime = matches!(runtime_preset.as_str(), "local-endpoints" | "endpoints");
    let wrapper_passthrough = input
        .and_then(|value| value.wrapper_passthrough)
        .unwrap_or(true);
    let processor_timeout =
        trimmed_model_input_value(input.and_then(|value| value.processor_timeout_secs.as_deref()))
            .unwrap_or_else(|| "75".to_string());
    let model_timeout =
        trimmed_model_input_value(input.and_then(|value| value.model_timeout_secs.as_deref()))
            .unwrap_or_else(|| "8".to_string());
    let ports = ai_runtime_processor_ports(
        input.and_then(|value| value.video_processor_port.as_deref()),
        input.and_then(|value| value.audio_processor_port.as_deref()),
    )?;

    let mut lines = vec![
        "# Shape Meet model AI runtime".to_string(),
        if endpoint_runtime {
            "# Endpoints locales persistentes para FaceFusion, BackgroundMattingV2 y vcclient000."
                .to_string()
        } else {
            "# Wrappers locales para FaceFusion, BackgroundMattingV2 y vcclient000.".to_string()
        },
        "SHAPE_AI_MODE=adapter-contract".to_string(),
        "SHAPE_FACE_ENGINE=facefusion".to_string(),
        "SHAPE_BACKGROUND_ENGINE=backgroundmattingv2".to_string(),
        "SHAPE_VOICE_ENGINE=vcclient000".to_string(),
        format!(
            "SHAPE_MODEL_RUNTIME_PRESET={}",
            render_env_value(&runtime_preset)
        ),
        format!(
            "SHAPE_MODEL_WORKSTATION_PROFILE={}",
            render_env_value(
                &trimmed_model_input_value(
                    input.and_then(|value| value.workstation_profile.as_deref())
                )
                .unwrap_or_else(|| "manual".to_string())
            )
        ),
        format!(
            "SHAPE_PROCESSOR_TIMEOUT_SECS={}",
            render_env_value(&processor_timeout)
        ),
        format!(
            "SHAPE_MODEL_COMMAND_TIMEOUT_SECS={}",
            render_env_value(&model_timeout)
        ),
        format!(
            "SHAPE_VIDEO_PROCESSOR_COMMAND={processor_command} --kind video --host 127.0.0.1 --port {}",
            ports.video
        ),
        format!(
            "SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:{}/process-frame",
            ports.video
        ),
        format!(
            "SHAPE_VIDEO_PROCESSOR_HEALTH_URL=http://127.0.0.1:{}/health",
            ports.video
        ),
        format!(
            "SHAPE_AUDIO_PROCESSOR_COMMAND={processor_command} --kind audio --host 127.0.0.1 --port {}",
            ports.audio
        ),
        format!(
            "SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:{}/process-audio",
            ports.audio
        ),
        format!(
            "SHAPE_AUDIO_PROCESSOR_HEALTH_URL=http://127.0.0.1:{}/health",
            ports.audio
        ),
    ];

    if endpoint_runtime {
        let endpoint_host =
            trimmed_model_input_value(input.and_then(|value| value.model_endpoint_host.as_deref()))
                .unwrap_or_else(|| "127.0.0.1".to_string());
        let endpoint_port =
            trimmed_model_input_value(input.and_then(|value| value.model_endpoint_port.as_deref()))
                .unwrap_or_else(|| "9100".to_string());
        let endpoint_base_url = format!("http://{endpoint_host}:{endpoint_port}");
        let face_endpoint =
            trimmed_model_input_value(input.and_then(|value| value.face_endpoint.as_deref()))
                .unwrap_or_else(|| format!("{endpoint_base_url}/face"));
        let background_endpoint =
            trimmed_model_input_value(input.and_then(|value| value.background_endpoint.as_deref()))
                .unwrap_or_else(|| format!("{endpoint_base_url}/background"));
        let voice_endpoint =
            trimmed_model_input_value(input.and_then(|value| value.voice_endpoint.as_deref()))
                .unwrap_or_else(|| format!("{endpoint_base_url}/voice"));

        lines.push(format!(
            "SHAPE_MODEL_ENDPOINT_HOST={}",
            render_env_value(&endpoint_host)
        ));
        lines.push(format!(
            "SHAPE_MODEL_ENDPOINT_PORT={}",
            render_env_value(&endpoint_port)
        ));
        if wrapper_passthrough {
            lines.push("SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS=true".to_string());
        } else {
            lines.push("# SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS=true".to_string());
        }
        if let Some(video_frame_endpoint) =
            trimmed_model_input_value(input.and_then(|value| value.video_frame_endpoint.as_deref()))
        {
            lines.push(format!(
                "SHAPE_VIDEO_FRAME_ENDPOINT={}",
                render_env_value(&video_frame_endpoint)
            ));
        }
        lines.push(format!(
            "SHAPE_FACE_ENDPOINT={}",
            render_env_value(&face_endpoint)
        ));
        lines.push(format!(
            "SHAPE_BACKGROUND_ENDPOINT={}",
            render_env_value(&background_endpoint)
        ));
        if let Some(audio_chunk_endpoint) =
            trimmed_model_input_value(input.and_then(|value| value.audio_chunk_endpoint.as_deref()))
        {
            lines.push(format!(
                "SHAPE_AUDIO_CHUNK_ENDPOINT={}",
                render_env_value(&audio_chunk_endpoint)
            ));
        }
        lines.push(format!(
            "SHAPE_VOICE_ENDPOINT={}",
            render_env_value(&voice_endpoint)
        ));
    } else {
        let python =
            shell_quote(&env_non_empty("SHAPE_AI_PYTHON").unwrap_or_else(default_python_command));
        let face_wrapper = wrapper_script_path("facefusion_frame.py").ok_or_else(|| {
            "No se encontró wrapper FaceFusion. Define SHAPE_AI_WRAPPERS_DIR o ejecuta desde el repo."
                .to_string()
        })?;
        let background_wrapper =
            wrapper_script_path("backgroundmattingv2_frame.py").ok_or_else(|| {
                "No se encontró wrapper BackgroundMattingV2. Define SHAPE_AI_WRAPPERS_DIR o ejecuta desde el repo."
                    .to_string()
            })?;
        let voice_wrapper = wrapper_script_path("vcclient000_chunk.py").ok_or_else(|| {
            "No se encontró wrapper vcclient000. Define SHAPE_AI_WRAPPERS_DIR o ejecuta desde el repo."
                .to_string()
        })?;

        lines.push(format!(
            "SHAPE_FACE_COMMAND={python} {} --input {{input}} --output {{output}} --identity {{identity}}",
            shell_quote_path(&face_wrapper)
        ));
        lines.push(format!(
            "SHAPE_BACKGROUND_COMMAND={python} {} --input {{input}} --output {{output}} --clean-plate {{clean_plate}}",
            shell_quote_path(&background_wrapper)
        ));
        lines.push(format!(
            "SHAPE_VOICE_COMMAND={python} {} --input {{input}} --output {{output}} --sample-rate {{sample_rate}} --channels {{channels}} --format {{format}}",
            shell_quote_path(&voice_wrapper)
        ));
        lines.push(format!("SHAPE_WRAPPER_PASSTHROUGH={wrapper_passthrough}"));
    }

    push_model_env_line(
        &mut lines,
        "FACEFUSION_DIR",
        input.and_then(|value| value.facefusion_dir.as_deref()),
        "C:\\\\models\\\\FaceFusion",
    );
    push_model_env_line(
        &mut lines,
        "FACEFUSION_PYTHON",
        input.and_then(|value| value.facefusion_python.as_deref()),
        "C:\\\\models\\\\FaceFusion\\\\.venv\\\\Scripts\\\\python.exe",
    );
    push_model_env_line(
        &mut lines,
        "FACEFUSION_EXECUTION_PROVIDERS",
        input.and_then(|value| value.facefusion_providers.as_deref()),
        "cuda",
    );
    push_model_env_line(
        &mut lines,
        "FACEFUSION_PROCESSORS",
        input.and_then(|value| value.facefusion_processors.as_deref()),
        "face_swapper face_enhancer",
    );
    push_model_env_line(
        &mut lines,
        "FACEFUSION_EXTRA_ARGS",
        input.and_then(|value| value.facefusion_extra_args.as_deref()),
        "--execution-thread-count 4",
    );
    push_model_env_line(
        &mut lines,
        "BMV2_REPO_DIR",
        input.and_then(|value| value.bmv2_repo_dir.as_deref()),
        "C:\\\\models\\\\BackgroundMattingV2",
    );
    push_model_env_line(
        &mut lines,
        "BMV2_PYTHON",
        input.and_then(|value| value.bmv2_python.as_deref()),
        "C:\\\\models\\\\BackgroundMattingV2\\\\.venv\\\\Scripts\\\\python.exe",
    );
    push_model_env_line(
        &mut lines,
        "BMV2_MODEL_CHECKPOINT",
        input.and_then(|value| value.bmv2_checkpoint.as_deref()),
        "C:\\\\models\\\\BackgroundMattingV2\\\\pytorch_resnet50.pth",
    );
    push_model_env_line(
        &mut lines,
        "BMV2_DEVICE",
        input.and_then(|value| value.bmv2_device.as_deref()),
        "cuda",
    );
    push_model_env_line(
        &mut lines,
        "BMV2_EXTRA_ARGS",
        input.and_then(|value| value.bmv2_extra_args.as_deref()),
        "--model-refine-sample-pixels 80000",
    );
    push_model_env_line(
        &mut lines,
        "VCCLIENT000_HTTP_ENDPOINT",
        input.and_then(|value| value.vcclient000_http_endpoint.as_deref()),
        "http://127.0.0.1:18888/test",
    );
    let vcclient000_http_mode =
        trimmed_model_input_value(input.and_then(|value| value.vcclient000_http_mode.as_deref()));
    if let Some(mode) = vcclient000_http_mode {
        lines.push(format!("VCCLIENT000_HTTP_MODE={}", render_env_value(&mode)));
    } else if input
        .and_then(|value| value.vcclient000_http_endpoint.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        lines.push("VCCLIENT000_HTTP_MODE=w-okada-rest".to_string());
    } else {
        lines.push("# VCCLIENT000_HTTP_MODE=w-okada-rest".to_string());
    }
    lines.push(String::new());

    Ok(lines.join("\n"))
}

fn trimmed_model_input_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn push_model_env_line(lines: &mut Vec<String>, key: &str, value: Option<&str>, example: &str) {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if let Some(value) = value {
        lines.push(format!("{key}={}", render_env_value(value)));
    } else {
        lines.push(format!("# {key}={example}"));
    }
}

fn render_env_value(value: &str) -> String {
    if value
        .chars()
        .any(|character| character.is_whitespace() || character == '#')
    {
        format!("\"{}\"", value.replace('"', "'"))
    } else {
        value.to_string()
    }
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
        package_dir: None,
        package_manifest: None,
        face_source_path: None,
        voice_model_path: None,
        voice_index_path: None,
        voice_config_path: None,
        background_assets_path: None,
        warnings: Vec::new(),
        message: message.to_string(),
    }
}

fn attach_identity_package_metadata(
    result: &mut IdentityArtifactCacheResult,
    artifact_path: &Path,
) -> Result<(), String> {
    if artifact_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("zip"))
        .unwrap_or(true)
    {
        return Ok(());
    }

    let package_dir = artifact_path.with_extension("package");
    let manifest_path = package_dir.join("manifest.json");
    if !manifest_path.exists() {
        if package_dir.exists() {
            fs::remove_dir_all(&package_dir)
                .map_err(|error| format!("No se pudo limpiar paquete de identidad previo: {error}"))?;
        }
        fs::create_dir_all(&package_dir)
            .map_err(|error| format!("No se pudo crear cache de paquete de identidad: {error}"))?;
        extract_identity_package_zip(artifact_path, &package_dir)?;
    }

    result.package_dir = Some(package_dir.display().to_string());

    if !manifest_path.exists() {
        result
            .warnings
            .push("identity_package_manifest_missing".to_string());
        return Ok(());
    }

    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("No se pudo leer manifest de identidad: {error}"))?;
    let manifest: Value = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("Manifest de identidad inválido: {error}"))?;

    result.face_source_path = identity_package_path(
        &package_dir,
        first_manifest_string(
            &manifest,
            &[
                "/engines/face/entry",
                "/engines/face/source",
                "/engines/face/sourcePath",
            ],
        ),
    );
    result.voice_model_path = identity_package_path(
        &package_dir,
        first_manifest_string(
            &manifest,
            &[
                "/engines/voice/model",
                "/engines/voice/modelPath",
                "/engines/voice/pth",
            ],
        ),
    );
    result.voice_index_path = identity_package_path(
        &package_dir,
        first_manifest_string(
            &manifest,
            &[
                "/engines/voice/index",
                "/engines/voice/indexPath",
            ],
        ),
    );
    result.voice_config_path = identity_package_path(
        &package_dir,
        first_manifest_string(
            &manifest,
            &[
                "/engines/voice/config",
                "/engines/voice/configPath",
            ],
        ),
    );
    result.background_assets_path = identity_package_path(
        &package_dir,
        first_manifest_string(
            &manifest,
            &[
                "/engines/background/assets",
                "/engines/background/assetsPath",
            ],
        ),
    );
    result.package_manifest = Some(manifest);

    Ok(())
}

fn extract_identity_package_zip(artifact_path: &Path, package_dir: &Path) -> Result<(), String> {
    let file = File::open(artifact_path)
        .map_err(|error| format!("No se pudo abrir paquete de identidad: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("ZIP de identidad inválido: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("No se pudo leer entrada ZIP: {error}"))?;
        let Some(enclosed_name) = entry.enclosed_name().map(PathBuf::from) else {
            continue;
        };
        let target = package_dir.join(enclosed_name);
        let relative_target = target
            .strip_prefix(package_dir)
            .map_err(|_| "Ruta ZIP fuera del paquete.".to_string())?;
        if relative_target
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err("Paquete de identidad contiene ruta insegura.".to_string());
        }

        if entry.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("No se pudo crear carpeta del paquete: {error}"))?;
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("No se pudo crear carpeta del paquete: {error}"))?;
        }
        let mut output = File::create(&target)
            .map_err(|error| format!("No se pudo extraer archivo del paquete: {error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("No se pudo escribir archivo del paquete: {error}"))?;
    }

    Ok(())
}

fn first_manifest_string<'a>(manifest: &'a Value, pointers: &[&str]) -> Option<&'a str> {
    pointers
        .iter()
        .find_map(|pointer| manifest.pointer(pointer).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn identity_package_path(package_dir: &Path, relative_path: Option<&str>) -> Option<String> {
    let relative_path = relative_path?;
    let relative = PathBuf::from(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }

    let path = package_dir.join(relative);
    if path.exists() {
        Some(path.display().to_string())
    } else {
        None
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
    for dir in bundled_binary_search_dirs() {
        if let Some(path) = find_sidecar_binary_in(&dir) {
            return Some(path);
        }
    }

    None
}

fn bundled_processor_binary_path() -> Option<PathBuf> {
    for dir in bundled_binary_search_dirs() {
        if let Some(path) = find_processor_binary_in(&dir) {
            return Some(path);
        }
    }

    None
}

fn bundled_model_endpoint_binary_path() -> Option<PathBuf> {
    for dir in bundled_binary_search_dirs() {
        if let Some(path) = find_model_endpoint_binary_in(&dir) {
            return Some(path);
        }
    }

    None
}

fn bundled_binary_search_dirs() -> Vec<PathBuf> {
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

    search_dirs
}

fn find_sidecar_binary_in(dir: &Path) -> Option<PathBuf> {
    find_named_binary_in(dir, AI_SIDECAR_BINARY_NAME)
}

fn find_processor_binary_in(dir: &Path) -> Option<PathBuf> {
    find_named_binary_in(dir, AI_PROCESSOR_BINARY_NAME)
}

fn find_model_endpoint_binary_in(dir: &Path) -> Option<PathBuf> {
    find_named_binary_in(dir, AI_MODEL_ENDPOINT_BINARY_NAME)
}

fn find_named_binary_in(dir: &Path, base_name: &str) -> Option<PathBuf> {
    let exact = dir.join(runtime_binary_name(base_name));
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
        if file_name.starts_with(&format!("{base_name}-"))
            && (!cfg!(windows) || file_name.ends_with(".exe"))
        {
            return Some(path);
        }
    }

    None
}

fn runtime_binary_name(base_name: &str) -> String {
    if cfg!(windows) {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    }
}

fn processor_command_for_demo() -> Result<String, String> {
    if let Some(command) = env_non_empty("SHAPE_DEMO_PROCESSOR_COMMAND") {
        return Ok(command);
    }

    let source = processor_script_path();

    if let Some(binary) = bundled_processor_binary_path() {
        if source
            .as_ref()
            .map(|source_path| binary_is_fresh(&binary, source_path))
            .unwrap_or(true)
        {
            return Ok(shell_quote_path(&binary));
        }
    }

    let script = source.ok_or_else(|| {
        "No se encontró procesador IA local. Ejecuta pnpm build:ai-sidecar o define SHAPE_DEMO_PROCESSOR_COMMAND.".to_string()
    })?;
    let python = env_non_empty("SHAPE_AI_PYTHON").unwrap_or_else(default_python_command);
    Ok(format!(
        "{} {}",
        shell_quote(&python),
        shell_quote_path(&script)
    ))
}

fn processor_script_path() -> Option<PathBuf> {
    if let Some(path) = env_non_empty("SHAPE_AI_PROCESSOR_SCRIPT").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let current_dir = env::current_dir().ok()?;
    for ancestor in current_dir.ancestors() {
        let candidate = ancestor
            .join("apps")
            .join("ai-sidecar")
            .join("processors")
            .join("shape_processor_command.py");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn model_endpoint_command() -> Result<(String, Vec<String>, String), String> {
    let (host, port) = model_endpoint_host_port();

    if let Some(command) = env_non_empty("SHAPE_MODEL_ENDPOINT_COMMAND") {
        let (program, args) = shell_command(command.clone());
        return Ok((program, args, command));
    }

    if let Some(binary) = env_non_empty("SHAPE_MODEL_ENDPOINT_BIN") {
        let args = vec![
            "--host".to_string(),
            host,
            "--port".to_string(),
            port.to_string(),
        ];
        return Ok((binary.clone(), args, binary));
    }

    if let Some(binary) = bundled_model_endpoint_binary_path() {
        let args = vec![
            "--host".to_string(),
            host,
            "--port".to_string(),
            port.to_string(),
        ];
        let description = binary.display().to_string();
        return Ok((description.clone(), args, description));
    }

    let script = model_endpoint_script_path().ok_or_else(|| {
        "No se encontró servidor de endpoints IA. Ejecuta pnpm build:ai-sidecar o define SHAPE_MODEL_ENDPOINT_COMMAND/SHAPE_MODEL_ENDPOINT_BIN/SHAPE_MODEL_ENDPOINT_SCRIPT.".to_string()
    })?;
    let python = env_non_empty("SHAPE_MODEL_ENDPOINT_PYTHON")
        .or_else(|| env_non_empty("SHAPE_AI_PYTHON"))
        .unwrap_or_else(default_python_command);
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

fn model_endpoint_command_description() -> String {
    model_endpoint_command()
        .map(|(_, _, description)| description)
        .unwrap_or_else(|error| error)
}

fn model_endpoint_script_path() -> Option<PathBuf> {
    if let Some(path) = env_non_empty("SHAPE_MODEL_ENDPOINT_SCRIPT").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let current_dir = env::current_dir().ok()?;
    for ancestor in current_dir.ancestors() {
        let candidate = ancestor
            .join("apps")
            .join("ai-sidecar")
            .join("processors")
            .join("shape_model_endpoint_server.py");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn wrapper_script_path(file_name: &str) -> Option<PathBuf> {
    if let Some(dir) = env_non_empty("SHAPE_AI_WRAPPERS_DIR").map(PathBuf::from) {
        let candidate = dir.join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    for dir in bundled_wrapper_search_dirs() {
        let candidate = dir.join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn bundled_wrapper_search_dirs() -> Vec<PathBuf> {
    let mut search_dirs = Vec::new();

    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            search_dirs.push(parent.join("resources").join("ai-wrappers"));
            search_dirs.push(parent.join("ai-wrappers"));

            if let Some(contents_dir) = parent.parent() {
                search_dirs.push(contents_dir.join("Resources").join("ai-wrappers"));
                search_dirs.push(
                    contents_dir
                        .join("Resources")
                        .join("resources")
                        .join("ai-wrappers"),
                );
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
                    .join("resources")
                    .join("ai-wrappers"),
            );
            search_dirs.push(
                ancestor
                    .join("src-tauri")
                    .join("resources")
                    .join("ai-wrappers"),
            );
            search_dirs.push(ancestor.join("apps").join("ai-sidecar").join("wrappers"));
        }
    }

    search_dirs
}

fn binary_is_fresh(binary: &Path, source: &Path) -> bool {
    let Ok(binary_modified) = binary.metadata().and_then(|metadata| metadata.modified()) else {
        return false;
    };
    let Ok(source_modified) = source.metadata().and_then(|metadata| metadata.modified()) else {
        return true;
    };

    binary_modified >= source_modified
}

fn shell_quote_path(path: &Path) -> String {
    shell_quote(&path.display().to_string())
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "_./:=@+-".contains(character))
    {
        return value.to_string();
    }

    if cfg!(windows) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        format!(
            "\"{}\"",
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('$', "\\$")
                .replace('`', "\\`")
        )
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

fn model_endpoint_url() -> String {
    let (host, port) = model_endpoint_host_port();
    format!("http://{host}:{port}")
}

fn model_endpoint_health_url() -> String {
    format!("{}/health", model_endpoint_url().trim_end_matches('/'))
}

fn model_endpoint_online() -> bool {
    read_http_json(&model_endpoint_health_url())
        .ok()
        .and_then(|value| {
            value
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .map(|status| status == "ready")
        .unwrap_or(false)
}

fn model_endpoint_host_port() -> (String, u16) {
    let runtime_env = load_ai_runtime_env().unwrap_or_default();

    if let Some(host_port) = model_endpoint_host_port_from_runtime_env(&runtime_env) {
        return host_port;
    }

    if let (Some(host), Some(port)) = (
        env_non_empty("SHAPE_MODEL_ENDPOINT_HOST"),
        env_non_empty("SHAPE_MODEL_ENDPOINT_PORT"),
    ) {
        if let Ok(port) = port.parse::<u16>() {
            return (host, port);
        }
    }

    ("127.0.0.1".to_string(), 9100)
}

fn model_endpoint_host_port_from_runtime_env(
    runtime_env: &[(String, String)],
) -> Option<(String, u16)> {
    if let (Some(host), Some(port)) = (
        env_lookup(runtime_env, "SHAPE_MODEL_ENDPOINT_HOST"),
        env_lookup(runtime_env, "SHAPE_MODEL_ENDPOINT_PORT"),
    ) {
        if let Ok(port) = port.parse::<u16>() {
            return Some((host.to_string(), port));
        }
    }

    for key in [
        "SHAPE_VIDEO_FRAME_ENDPOINT",
        "SHAPE_FACE_ENDPOINT",
        "SHAPE_BACKGROUND_ENDPOINT",
        "SHAPE_AUDIO_CHUNK_ENDPOINT",
        "SHAPE_VOICE_ENDPOINT",
    ] {
        if let Some(url) = env_lookup(runtime_env, key) {
            if let Ok((host, port, _)) = parse_http_url(url) {
                return Some((host, port));
            }
        }
    }

    None
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

fn model_endpoint_log_path() -> PathBuf {
    env::temp_dir()
        .join("shape-meet-debug")
        .join("model-endpoint.log")
}

fn open_sidecar_log_file() -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(sidecar_log_path())
        .map_err(|error| error.to_string())
}

fn open_model_endpoint_log_file() -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(model_endpoint_log_path())
        .map_err(|error| error.to_string())
}

fn append_sidecar_log(message: &str) -> Result<(), String> {
    let mut file = open_sidecar_log_file()?;
    let timestamp = utc_timestamp().unwrap_or_else(|_| "unknown-time".to_string());
    writeln!(file, "[{timestamp}] {message}").map_err(|error| error.to_string())
}

fn append_model_endpoint_log(message: &str) -> Result<(), String> {
    let mut file = open_model_endpoint_log_file()?;
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
    let desktop_config = desktop_runtime_config();
    json!({
        "sentryDsnConfigured": sentry_dsn().is_some(),
        "aiServiceUrl": ai_endpoint(),
        "desktopRuntimeConfig": {
            "apiBaseUrl": desktop_config.api_base_url,
            "appBaseUrl": desktop_config.app_base_url,
            "meetingBaseUrl": desktop_config.meeting_base_url,
            "aiServiceUrl": desktop_config.ai_service_url,
            "hostIdentifierConfigured": desktop_config.host_identifier.is_some(),
            "demoDataEnabled": desktop_config.demo_data_enabled,
            "configPath": desktop_config.config_path,
            "warnings": desktop_config.warnings
        },
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

fn desktop_runtime_config() -> DesktopRuntimeConfig {
    let api_base_url = local_config_value(&["SHAPE_API_URL", "VITE_SHAPE_API_URL"])
        .unwrap_or_else(|| DEFAULT_DESKTOP_API_URL.to_string());
    let app_base_url = local_config_value(&["SHAPE_APP_URL", "VITE_SHAPE_APP_URL"])
        .unwrap_or_else(|| DEFAULT_DESKTOP_APP_URL.to_string());
    let meeting_base_url = local_config_value(&[
        "SHAPE_MEETING_URL",
        "VITE_SHAPE_MEETING_URL",
        "SHAPE_APP_URL",
        "VITE_SHAPE_APP_URL",
    ])
    .unwrap_or_else(|| app_base_url.clone());
    let ai_service_url = ai_endpoint();
    let host_identifier =
        local_config_value(&["SHAPE_HOST_IDENTIFIER", "VITE_SHAPE_HOST_IDENTIFIER"]);
    let demo_data_enabled = local_config_bool(&["SHAPE_DEMO_DATA", "VITE_SHAPE_DEMO_DATA"]);
    let sentry_dsn = sentry_dsn();
    let sentry_environment = sentry_environment();
    let sentry_release = sentry_release();
    let sentry_traces_sample_rate = sentry_traces_sample_rate();
    let sentry_debug = sentry_debug();
    let config_path = first_existing_local_config_path().map(|path| path.display().to_string());
    let mut warnings = Vec::new();

    for (label, url) in [
        ("apiBaseUrl", api_base_url.as_str()),
        ("appBaseUrl", app_base_url.as_str()),
        ("meetingBaseUrl", meeting_base_url.as_str()),
        ("aiServiceUrl", ai_service_url.as_str()),
    ] {
        if !looks_like_http_url(url) {
            warnings.push(format!("{label} no parece una URL http(s) válida."));
        }
    }

    DesktopRuntimeConfig {
        api_base_url,
        app_base_url,
        meeting_base_url,
        ai_service_url,
        host_identifier,
        demo_data_enabled,
        sentry_dsn,
        sentry_environment,
        sentry_release,
        sentry_traces_sample_rate,
        sentry_debug,
        config_path,
        warnings,
    }
}

fn sentry_dsn() -> Option<String> {
    local_config_value(&["SENTRY_DSN", "VITE_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"])
        .or_else(|| Some(DEFAULT_SENTRY_DSN.to_string()))
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

fn local_config_bool(keys: &[&str]) -> bool {
    local_config_value(keys)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn first_existing_local_config_path() -> Option<PathBuf> {
    local_env_file_candidates()
        .into_iter()
        .find(|path| path.exists())
}

fn local_env_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env_non_empty("SHAPE_DESKTOP_CONFIG_FILE").map(PathBuf::from) {
        candidates.push(path);
    }

    push_bundled_desktop_config_candidates(&mut candidates);

    if let Ok(data_dir) = shape_meet_data_dir() {
        candidates.push(data_dir.join("shape-meet.env"));
        candidates.push(data_dir.join(".env.local"));
    }

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

fn push_bundled_desktop_config_candidates(candidates: &mut Vec<PathBuf>) {
    let Ok(current_exe) = env::current_exe() else {
        return;
    };
    let Some(parent) = current_exe.parent() else {
        return;
    };

    candidates.push(parent.join("resources").join("shape-meet.env"));
    candidates.push(parent.join("shape-meet.env"));

    if let Some(contents_dir) = parent.parent() {
        candidates.push(contents_dir.join("Resources").join("shape-meet.env"));
        candidates.push(
            contents_dir
                .join("Resources")
                .join("resources")
                .join("shape-meet.env"),
        );
    }
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
    local_config_value(&["SHAPE_AI_SERVICE_URL", "VITE_SHAPE_AI_SERVICE_URL"])
        .unwrap_or_else(|| DEFAULT_AI_ENDPOINT.to_string())
}

fn env_non_empty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn looks_like_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
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
            SHAPE_MODEL_WORKSTATION_PROFILE=windows-nvidia
            FACEFUSION_DIR=C:\models\FaceFusion
            BMV2_MODEL_CHECKPOINT=C:\models\BackgroundMattingV2\pytorch_resnet50.pth
            VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18888/test
            VCCLIENT000_HTTP_MODE=w-okada-rest
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
                "SHAPE_MODEL_WORKSTATION_PROFILE",
                "FACEFUSION_DIR",
                "BMV2_MODEL_CHECKPOINT",
                "VCCLIENT000_HTTP_ENDPOINT",
                "VCCLIENT000_HTTP_MODE",
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

    #[test]
    fn demo_ai_runtime_env_is_parseable() {
        let content = demo_ai_runtime_env_content(
            "python3 /tmp/shape_processor_command.py",
            AiRuntimeProcessorPorts {
                video: 7860,
                audio: 7861,
            },
        );
        let parsed = parse_ai_runtime_env(&content);

        assert!(parsed.errors.is_empty());
        assert!(parsed.warnings.is_empty());
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_PROCESSOR_DEMO_EFFECTS" && value == "true"));
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "SHAPE_VIDEO_PROCESSOR_COMMAND"
                && value.contains("--kind video")
                && value.contains("--port 7860")
        }));
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "SHAPE_AUDIO_PROCESSOR_COMMAND"
                && value.contains("--kind audio")
                && value.contains("--port 7861")
        }));
    }

    #[test]
    fn ai_runtime_processor_ports_reject_invalid_values() {
        assert!(ai_runtime_processor_ports(Some("abc"), Some("7861")).is_err());
        assert!(ai_runtime_processor_ports(Some("7860"), Some("7860")).is_err());
        assert!(ai_runtime_processor_ports(Some("0"), Some("7861")).is_err());
    }

    #[test]
    fn model_ai_runtime_env_is_parseable() {
        let content = model_ai_runtime_env_content("python3 /tmp/shape_processor_command.py", None)
            .expect("model runtime content should render from repo wrappers");
        let parsed = parse_ai_runtime_env(&content);

        assert!(parsed.errors.is_empty());
        assert!(parsed.warnings.is_empty());
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "SHAPE_FACE_COMMAND" && value.contains("facefusion_frame.py")
        }));
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "SHAPE_BACKGROUND_COMMAND" && value.contains("backgroundmattingv2_frame.py")
        }));
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "SHAPE_VOICE_COMMAND" && value.contains("vcclient000_chunk.py")
        }));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_WRAPPER_PASSTHROUGH" && value == "true"));
    }

    #[test]
    fn model_ai_runtime_env_accepts_real_paths() {
        let input = PrepareModelAiRuntimeEnvInput {
            runtime_preset: None,
            workstation_profile: Some("windows-nvidia".to_string()),
            wrapper_passthrough: Some(false),
            video_processor_port: Some("7960".to_string()),
            audio_processor_port: Some("7961".to_string()),
            model_endpoint_host: None,
            model_endpoint_port: None,
            video_frame_endpoint: None,
            face_endpoint: None,
            background_endpoint: None,
            audio_chunk_endpoint: None,
            voice_endpoint: None,
            facefusion_dir: Some(r"C:\models\FaceFusion".to_string()),
            facefusion_python: Some(r"C:\models\FaceFusion\.venv\Scripts\python.exe".to_string()),
            facefusion_providers: Some("cuda".to_string()),
            facefusion_processors: Some("face_swapper face_enhancer".to_string()),
            facefusion_extra_args: Some("--execution-thread-count 4".to_string()),
            bmv2_repo_dir: Some(r"C:\models\BackgroundMattingV2".to_string()),
            bmv2_python: Some(
                r"C:\models\BackgroundMattingV2\.venv\Scripts\python.exe".to_string(),
            ),
            bmv2_checkpoint: Some(
                r"C:\models\BackgroundMattingV2\pytorch_resnet50.pth".to_string(),
            ),
            bmv2_device: Some("cuda".to_string()),
            bmv2_extra_args: Some("--model-refine-sample-pixels 80000".to_string()),
            vcclient000_http_endpoint: Some("http://127.0.0.1:18888/test".to_string()),
            vcclient000_http_mode: Some("w-okada-rest".to_string()),
            model_timeout_secs: Some("30".to_string()),
            processor_timeout_secs: Some("75".to_string()),
        };
        let content =
            model_ai_runtime_env_content("python3 /tmp/shape_processor_command.py", Some(&input))
                .expect("model runtime content should render from repo wrappers");
        let parsed = parse_ai_runtime_env(&content);

        assert!(parsed.errors.is_empty());
        assert!(parsed.warnings.is_empty());
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_MODEL_WORKSTATION_PROFILE"
                && value == "windows-nvidia"));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_WRAPPER_PASSTHROUGH" && value == "false"));
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "SHAPE_VIDEO_PROCESSOR_COMMAND" && value.contains("--port 7960")
        }));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_AUDIO_PROCESSOR_ENDPOINT"
                && value == "http://127.0.0.1:7961/process-audio"));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "FACEFUSION_DIR" && value == r"C:\models\FaceFusion"));
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "FACEFUSION_PYTHON" && value == r"C:\models\FaceFusion\.venv\Scripts\python.exe"
        }));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "FACEFUSION_EXECUTION_PROVIDERS" && value == "cuda"));
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "BMV2_MODEL_CHECKPOINT"
                && value == r"C:\models\BackgroundMattingV2\pytorch_resnet50.pth"
        }));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "BMV2_DEVICE" && value == "cuda"));
        assert!(parsed.values.iter().any(|(key, value)| {
            key == "VCCLIENT000_HTTP_ENDPOINT" && value == "http://127.0.0.1:18888/test"
        }));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "VCCLIENT000_HTTP_MODE" && value == "w-okada-rest"));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_MODEL_COMMAND_TIMEOUT_SECS" && value == "30"));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_PROCESSOR_TIMEOUT_SECS" && value == "75"));
    }

    #[test]
    fn model_ai_runtime_env_accepts_local_endpoints() {
        let input = PrepareModelAiRuntimeEnvInput {
            runtime_preset: Some("local-endpoints".to_string()),
            workstation_profile: Some("manual".to_string()),
            wrapper_passthrough: Some(false),
            video_processor_port: Some("8060".to_string()),
            audio_processor_port: Some("8061".to_string()),
            model_endpoint_host: Some("127.0.0.1".to_string()),
            model_endpoint_port: Some("9200".to_string()),
            video_frame_endpoint: None,
            face_endpoint: None,
            background_endpoint: None,
            audio_chunk_endpoint: None,
            voice_endpoint: None,
            facefusion_dir: None,
            facefusion_python: None,
            facefusion_providers: None,
            facefusion_processors: None,
            facefusion_extra_args: None,
            bmv2_repo_dir: None,
            bmv2_python: None,
            bmv2_checkpoint: None,
            bmv2_device: None,
            bmv2_extra_args: None,
            vcclient000_http_endpoint: None,
            vcclient000_http_mode: None,
            model_timeout_secs: Some("30".to_string()),
            processor_timeout_secs: Some("75".to_string()),
        };
        let content =
            model_ai_runtime_env_content("python3 /tmp/shape_processor_command.py", Some(&input))
                .expect("endpoint runtime content should render without wrappers");
        let parsed = parse_ai_runtime_env(&content);

        assert!(parsed.errors.is_empty());
        assert!(parsed.warnings.is_empty());
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_MODEL_RUNTIME_PRESET" && value == "local-endpoints"));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_FACE_ENDPOINT"
                && value == "http://127.0.0.1:9200/face"));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_BACKGROUND_ENDPOINT"
                && value == "http://127.0.0.1:9200/background"));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_VOICE_ENDPOINT"
                && value == "http://127.0.0.1:9200/voice"));
        assert!(!parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS" && value == "true"));
        assert!(!parsed
            .values
            .iter()
            .any(|(key, _)| key == "SHAPE_FACE_COMMAND"));
        assert!(!parsed
            .values
            .iter()
            .any(|(key, _)| key == "SHAPE_WRAPPER_PASSTHROUGH"));
    }

    #[test]
    fn model_ai_runtime_env_enables_demo_effects_for_endpoint_passthrough() {
        let input = PrepareModelAiRuntimeEnvInput {
            runtime_preset: Some("local-endpoints".to_string()),
            wrapper_passthrough: Some(true),
            model_endpoint_host: Some("127.0.0.1".to_string()),
            model_endpoint_port: Some("9300".to_string()),
            ..Default::default()
        };
        let content =
            model_ai_runtime_env_content("python3 /tmp/shape_processor_command.py", Some(&input))
                .expect("endpoint demo runtime content should render");
        let parsed = parse_ai_runtime_env(&content);

        assert!(parsed.errors.is_empty());
        assert!(parsed.warnings.is_empty());
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_MODEL_ENDPOINT_DEMO_EFFECTS" && value == "true"));
        assert!(parsed
            .values
            .iter()
            .any(|(key, value)| key == "SHAPE_FACE_ENDPOINT"
                && value == "http://127.0.0.1:9300/face"));
        assert!(!parsed
            .values
            .iter()
            .any(|(key, _)| key == "SHAPE_WRAPPER_PASSTHROUGH"));
    }

    #[test]
    fn model_endpoint_host_port_accepts_combined_video_endpoint() {
        let parsed =
            parse_ai_runtime_env("SHAPE_VIDEO_FRAME_ENDPOINT=http://127.0.0.1:9410/video-frame");

        assert_eq!(
            model_endpoint_host_port_from_runtime_env(&parsed.values),
            Some(("127.0.0.1".to_string(), 9410))
        );
    }

    #[test]
    fn model_endpoint_host_port_accepts_combined_audio_endpoint() {
        let parsed = parse_ai_runtime_env("SHAPE_AUDIO_CHUNK_ENDPOINT=http://localhost:9420/audio");

        assert_eq!(
            model_endpoint_host_port_from_runtime_env(&parsed.values),
            Some(("localhost".to_string(), 9420))
        );
    }

    #[test]
    fn model_endpoint_host_port_prefers_explicit_endpoint_host() {
        let parsed = parse_ai_runtime_env(
            r#"
            SHAPE_MODEL_ENDPOINT_HOST=127.0.0.1
            SHAPE_MODEL_ENDPOINT_PORT=9500
            SHAPE_VIDEO_FRAME_ENDPOINT=http://127.0.0.1:9410/video-frame
            "#,
        );

        assert_eq!(
            model_endpoint_host_port_from_runtime_env(&parsed.values),
            Some(("127.0.0.1".to_string(), 9500))
        );
    }

    #[test]
    fn ai_runtime_doctor_accepts_ready_local_runtime() {
        let root = test_temp_dir("ready-runtime");
        let facefusion_dir = root.join("FaceFusion");
        let bmv2_dir = root.join("BackgroundMattingV2");
        let facefusion_python = facefusion_dir.join("python");
        let bmv2_python = bmv2_dir.join("python");
        let checkpoint = bmv2_dir.join("pytorch_resnet50.pth");
        fs::create_dir_all(&facefusion_dir).expect("create FaceFusion dir");
        fs::create_dir_all(&bmv2_dir).expect("create BMV2 dir");
        fs::write(&facefusion_python, "python").expect("write FaceFusion python");
        fs::write(&bmv2_python, "python").expect("write BMV2 python");
        fs::write(&checkpoint, "checkpoint").expect("write checkpoint");

        let content = format!(
            r#"
            SHAPE_AI_MODE=adapter-contract
            SHAPE_MODEL_WORKSTATION_PROFILE=apple-silicon
            SHAPE_VIDEO_PROCESSOR_COMMAND=shape-ai-processor --kind video
            SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:7860/process-frame
            SHAPE_AUDIO_PROCESSOR_COMMAND=shape-ai-processor --kind audio
            SHAPE_AUDIO_PROCESSOR_ENDPOINT=http://127.0.0.1:7861/process-audio
            SHAPE_FACE_COMMAND=python facefusion_frame.py --input {{input}} --output {{output}} --identity {{identity}}
            SHAPE_BACKGROUND_COMMAND=python backgroundmattingv2_frame.py --input {{input}} --output {{output}} --clean-plate {{clean_plate}}
            SHAPE_VOICE_COMMAND=python vcclient000_chunk.py --input {{input}} --output {{output}} --sample-rate {{sample_rate}}
            SHAPE_WRAPPER_PASSTHROUGH=false
            FACEFUSION_DIR={}
            FACEFUSION_PYTHON={}
            BMV2_REPO_DIR={}
            BMV2_PYTHON={}
            BMV2_MODEL_CHECKPOINT={}
            VCCLIENT000_HTTP_ENDPOINT=http://127.0.0.1:18888/test
            "#,
            render_env_value(&facefusion_dir.display().to_string()),
            render_env_value(&facefusion_python.display().to_string()),
            render_env_value(&bmv2_dir.display().to_string()),
            render_env_value(&bmv2_python.display().to_string()),
            render_env_value(&checkpoint.display().to_string()),
        );

        let report =
            doctor_ai_runtime_env_report(&root.join("shape-ai-runtime.env"), true, &content);
        fs::remove_dir_all(root).ok();

        assert!(report.ok);
        assert_eq!(report.status, "ready");
        assert!(report.real_models_configured);
        assert!(!report.passthrough_enabled);
        assert!(report.checks.iter().all(|check| check.status == "ok"));
    }

    #[test]
    fn ai_runtime_doctor_flags_incomplete_passthrough_runtime() {
        let root = test_temp_dir("incomplete-runtime");
        let content = r#"
            SHAPE_AI_MODE=adapter-contract
            SHAPE_PROCESSOR_DEMO_EFFECTS=true
            SHAPE_WRAPPER_PASSTHROUGH=true
            SHAPE_VIDEO_PROCESSOR_COMMAND=shape-ai-processor --kind video
            SHAPE_VIDEO_PROCESSOR_ENDPOINT=http://127.0.0.1:7860/process-frame
        "#;

        let report =
            doctor_ai_runtime_env_report(&root.join("shape-ai-runtime.env"), true, content);
        fs::remove_dir_all(root).ok();

        assert!(report.ok == false);
        assert_eq!(report.status, "error");
        assert!(report.passthrough_enabled);
        assert!(!report.real_models_configured);
        assert!(report
            .checks
            .iter()
            .any(|check| check.id == "audio-pipeline" && check.status == "error"));
        assert!(report
            .next_steps
            .iter()
            .any(|step| step.contains("Desactiva SHAPE_WRAPPER_PASSTHROUGH")));
    }

    #[test]
    fn identity_artifact_cache_validates_and_reuses_local_artifacts() {
        let root = test_temp_dir("identity-cache");
        let cache_dir = root.join("cache");
        let artifact_path = root.join("identity.jpg");
        let payload = b"shape meet identity artifact";
        fs::write(&artifact_path, payload).expect("write identity artifact");
        env::set_var("SHAPE_IDENTITY_CACHE_DIR", &cache_dir);

        let sha = sha256_string(payload);
        let input = CacheIdentityArtifactInput {
            identity_id: "identity/host:demo".to_string(),
            artifact_uri: Some(artifact_path.display().to_string()),
            artifact_sha256: Some(sha.clone()),
            artifact_size_bytes: Some(payload.len() as u64),
        };

        let cached = prepare_identity_artifact(input).expect("cache identity artifact");
        assert!(cached.cached);
        assert_eq!(cached.sha256.as_deref(), Some(sha.as_str()));
        assert_eq!(cached.size_bytes, Some(payload.len() as u64));
        let local_path = PathBuf::from(cached.local_path.as_ref().expect("local path"));
        assert_eq!(
            fs::read(&local_path).expect("read cached artifact"),
            payload
        );

        let reused = prepare_identity_artifact(CacheIdentityArtifactInput {
            identity_id: "identity/host:demo".to_string(),
            artifact_uri: Some(artifact_path.display().to_string()),
            artifact_sha256: Some(sha.clone()),
            artifact_size_bytes: Some(payload.len() as u64),
        })
        .expect("reuse cached artifact");
        assert_eq!(reused.local_path, cached.local_path);
        assert!(reused.message.contains("reutilizado"));

        let bad_sha = "0".repeat(64);
        let bad_sha_result = prepare_identity_artifact(CacheIdentityArtifactInput {
            identity_id: "identity/host:demo".to_string(),
            artifact_uri: Some(artifact_path.display().to_string()),
            artifact_sha256: Some(bad_sha),
            artifact_size_bytes: Some(payload.len() as u64),
        });
        assert!(bad_sha_result
            .expect_err("bad sha should fail")
            .contains("Checksum SHA-256 inválido"));

        let bad_size_result = prepare_identity_artifact(CacheIdentityArtifactInput {
            identity_id: "identity/host:demo".to_string(),
            artifact_uri: Some(artifact_path.display().to_string()),
            artifact_sha256: Some(sha),
            artifact_size_bytes: Some((payload.len() + 1) as u64),
        });
        assert!(bad_size_result
            .expect_err("bad size should fail")
            .contains("Tamaño inválido"));

        let part_files = list_files_with_extension(&cache_dir, "part");
        fs::remove_dir_all(root).ok();
        env::remove_var("SHAPE_IDENTITY_CACHE_DIR");

        assert!(
            part_files.is_empty(),
            "invalid artifacts left temp files: {part_files:?}"
        );
    }

    #[test]
    fn identity_artifact_cache_extracts_package_manifest_paths() {
        let root = test_temp_dir("identity-package-cache");
        let cache_dir = root.join("cache");
        let package_path = root.join("shape-identity-package.zip");
        write_identity_package_fixture(&package_path);
        env::set_var("SHAPE_IDENTITY_CACHE_DIR", &cache_dir);

        let package_bytes = fs::read(&package_path).expect("read package");
        let sha = sha256_string(&package_bytes);
        let cached = prepare_identity_artifact(CacheIdentityArtifactInput {
            identity_id: "identity-package".to_string(),
            artifact_uri: Some(package_path.display().to_string()),
            artifact_sha256: Some(sha.clone()),
            artifact_size_bytes: Some(package_bytes.len() as u64),
        })
        .expect("cache package artifact");

        let package_dir = PathBuf::from(cached.package_dir.as_ref().expect("package dir"));
        assert!(package_dir.join("manifest.json").exists());
        assert_eq!(
            fs::read(cached.face_source_path.as_ref().expect("face source"))
                .expect("read face source"),
            b"fixture-face"
        );
        assert_eq!(
            fs::read(cached.voice_model_path.as_ref().expect("voice model"))
                .expect("read voice model"),
            b"fixture-pth"
        );
        assert_eq!(
            fs::read(cached.voice_index_path.as_ref().expect("voice index"))
                .expect("read voice index"),
            b"fixture-index"
        );
        assert_eq!(
            cached
                .package_manifest
                .as_ref()
                .and_then(|manifest| manifest.pointer("/packageId"))
                .and_then(Value::as_str),
            Some("shape-fixture")
        );

        let reused = prepare_identity_artifact(CacheIdentityArtifactInput {
            identity_id: "identity-package".to_string(),
            artifact_uri: Some(package_path.display().to_string()),
            artifact_sha256: Some(sha),
            artifact_size_bytes: Some(package_bytes.len() as u64),
        })
        .expect("reuse package artifact");
        assert_eq!(reused.package_dir, cached.package_dir);
        assert_eq!(reused.face_source_path, cached.face_source_path);

        fs::remove_dir_all(root).ok();
        env::remove_var("SHAPE_IDENTITY_CACHE_DIR");
    }

    fn write_identity_package_fixture(path: &Path) {
        let file = File::create(path).expect("create package fixture");
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let manifest = r#"{
          "schemaVersion": 1,
          "packageId": "shape-fixture",
          "packageVersion": "2026.07.04.test",
          "engines": {
            "face": { "kind": "facefusion_source", "entry": "face/source.jpg" },
            "voice": {
              "kind": "vcclient000_rvc",
              "model": "voice/model.pth",
              "index": "voice/model.index",
              "config": "voice/config.json"
            }
          }
        }"#;
        for (name, content) in [
            ("manifest.json", manifest.as_bytes()),
            ("face/source.jpg", b"fixture-face".as_slice()),
            ("voice/model.pth", b"fixture-pth".as_slice()),
            ("voice/model.index", b"fixture-index".as_slice()),
            ("voice/config.json", br#"{"sampleRate":48000}"#.as_slice()),
        ] {
            zip.start_file(name, options).expect("start zip file");
            zip.write_all(content).expect("write zip file");
        }
        zip.finish().expect("finish package fixture");
    }

    fn test_temp_dir(label: &str) -> PathBuf {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = env::temp_dir().join(format!("shape-meet-{label}-{id}"));
        fs::create_dir_all(&path).expect("create test temp dir");
        path
    }

    fn list_files_with_extension(root: &Path, extension: &str) -> Vec<PathBuf> {
        let mut matches = Vec::new();
        if !root.exists() {
            return matches;
        }

        let mut pending = vec![root.to_path_buf()];
        while let Some(path) = pending.pop() {
            let Ok(entries) = fs::read_dir(&path) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value == extension)
                {
                    matches.push(path);
                }
            }
        }

        matches
    }
}
