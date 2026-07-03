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
    except subprocess.TimeoutExpired:
        fail(f"comando agotó timeout: {command_label(args)}")
    except OSError as error:
        fail(f"no se pudo ejecutar {command_label(args)}: {error}")

    if result.stdout.strip():
        print(result.stdout.strip(), file=sys.stderr)
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)
    if result.returncode != 0:
        fail(f"comando falló con código {result.returncode}: {command_label(args)}")


def assert_output(path):
    current = Path(path)
    if not current.exists() or current.stat().st_size <= 0:
        fail(f"el wrapper no produjo output válido: {current}")


def command_label(args):
    return " ".join(shlex.quote(str(part)) for part in args[:8])


def fail(message, code=2):
    print(f"[shape-wrapper] {message}", file=sys.stderr)
    raise SystemExit(code)
