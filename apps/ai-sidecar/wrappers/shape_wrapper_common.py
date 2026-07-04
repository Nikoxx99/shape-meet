import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_value(name, fallback=None):
    value = os.environ.get(name)
    if value is None:
        return fallback
    value = value.strip()
    return value or fallback


def env_float(name, fallback, minimum=None, maximum=None):
    raw_value = env_value(name, str(fallback))
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        fail(f"{name} debe ser numérico; valor actual: {raw_value!r}.")

    if minimum is not None and value < minimum:
        fail(f"{name} debe ser >= {minimum}; valor actual: {value}.")
    if maximum is not None and value > maximum:
        fail(f"{name} debe ser <= {maximum}; valor actual: {value}.")
    return value


def split_args(value):
    if not value:
        return []
    return shlex.split(value, posix=os.name != "nt")


def template_args(template, replacements):
    return [
        replace_placeholders(part, replacements)
        for part in split_args(template)
    ]


def replace_placeholders(value, replacements):
    for key, replacement in replacements.items():
        value = value.replace("{" + key + "}", str(replacement or ""))
    return value


def ensure_file(path, label):
    if not path:
        fail(f"{label} no configurado.")
    current = Path(path)
    if not current.exists() or not current.is_file():
        fail(f"{label} no existe: {current}")
    return current


def ensure_parent(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)


def copy_passthrough(input_path, output_path, reason):
    ensure_parent(output_path)
    shutil.copyfile(input_path, output_path)
    print(f"[shape-wrapper] passthrough: {reason}", file=sys.stderr)
    return 0


def run_checked(args, cwd=None, timeout=None):
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        detail = captured_output_tail(error.stdout, error.stderr)
        message = f"comando agotó timeout {timeout}s: {command_label(args)}"
        if detail:
            message = f"{message} | salida: {detail}"
        fail(message)
    except OSError as error:
        fail(
            f"no se pudo ejecutar {command_label(args)}: {error}. "
            "Revisa rutas, permisos y PATH del runtime de modelos."
        )

    if result.returncode != 0:
        detail = captured_output_tail(result.stdout, result.stderr)
        message = f"comando falló con código {result.returncode}: {command_label(args)}"
        if detail:
            message = f"{message} | salida: {detail}"
        fail(message)

    if result.stdout.strip():
        print(result.stdout.strip(), file=sys.stderr)
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)


def assert_output(path):
    current = Path(path)
    if not current.exists():
        fail(f"el wrapper no produjo output: {current}")
    if current.stat().st_size <= 0:
        fail(f"el wrapper produjo output vacío: {current}")


def command_label(args):
    return " ".join(shlex.quote(str(part)) for part in args[:8])


def captured_output_tail(stdout, stderr, limit=360):
    text = "\n".join(
        part
        for part in (
            normalize_output(stderr),
            normalize_output(stdout),
        )
        if part
    )
    if not text:
        return ""

    text = " ".join(text.split())
    return text[-limit:]


def normalize_output(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def fail(message, code=2):
    print(f"[shape-wrapper] {message}", file=sys.stderr)
    raise SystemExit(code)
