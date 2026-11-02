#!/usr/bin/env bash
# Fresh source installation on macOS / Linux. Bash 3.2 compatible.
# curl -fsSL https://lime.heysuman.com/install.sh | bash
# Help: curl -fsSL https://lime.heysuman.com/install.sh | bash -s -- --help
# Optional: LIME_INSTALL_DIR=/absolute/path/lime LIME_REF=v2.0.0
# Run as your ordinary user; sudo is requested only where necessary.
set -euo pipefail

fail() { printf 'LIME installer: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

print_help() {
  printf '%s\n' \
    'LIME installer — fresh Docker installation on macOS or Linux/VPS' \
    '' \
    'Usage:' \
    '  curl -fsSL https://lime.heysuman.com/install.sh | bash' \
    '  curl -fsSL https://lime.heysuman.com/install.sh | bash -s -- --help' \
    '  bash scripts/install.sh [--help | -h]' \
    '' \
    'Options:' \
    '  -h, --help       Print this help and exit without installing anything.' \
    '' \
    'Platforms:' \
    '  macOS           Docker Desktop/Homebrew setup; first-run dialogs may require approval.' \
    '  Ubuntu/Debian   Automatic Docker Engine and Compose prerequisite setup.' \
    '  Other Linux     Docker must already be installed; dependencies use apt-get, dnf or yum.' \
    '' \
    'Configuration (environment variables):' \
    '  LIME_INSTALL_DIR  Fresh destination directory (default: $PWD/lime).' \
    '  LIME_REF          Git branch, tag or commit (default: main).' \
    '  LIME_UI_PORT      Dashboard port (default: 3000).' \
    '  LIME_API_PORT     Backend port (default: 8080).' \
    '  LIME_DB_PORT      PostgreSQL port (default: 5432).' \
    '' \
    'Example with custom localhost ports:' \
    '  curl -fsSL https://lime.heysuman.com/install.sh | LIME_UI_PORT=3100 LIME_API_PORT=8180 LIME_DB_PORT=55432 bash' \
    '' \
    'What it does:' \
    '  Checks prerequisites, clones sumanbasuli/lime, creates a private .env,' \
    '  then builds/starts Docker Compose and verifies readiness.' \
    '  All service ports bind to localhost. Use an SSH tunnel to access a remote VPS.' \
    '  Requires a local Unix-socket Docker context and Compose 2.24.4+.' \
    '  Existing install directories, LIME containers and default data volumes are not reused.' \
    '  This is a fresh installer, not an updater or a systemd deployment tool.' \
    '  Run as your ordinary user; administrator approval is requested when needed.'
}

# Read the entire script before executing it. A truncated outer curl|bash must
# never install packages or create an installation. The final sentinel is
# checked by this function after bash has parsed its complete definition.
lime_install_main() {
  [[ "${LIME_INSTALL_SCRIPT_COMPLETE:-}" == 'lime-installer-v1-complete' ]] || fail 'Incomplete installer download. Download the file successfully before running bash.'
  if [[ "$#" -gt 0 ]]; then
    [[ "$#" -eq 1 ]] || fail 'Expected no arguments or --help. Run with --help for usage.'
    case "$1" in
      -h|--help) print_help; return 0 ;;
      *) fail "Unknown argument: $1. Run with --help for usage." ;;
    esac
  fi
  local target="${LIME_INSTALL_DIR:-${PWD}/lime}"
  local ref="${LIME_REF:-main}"
  local kernel docker_path compose_version major minor patch password temporary_directory version commit
  local ui_port="${LIME_UI_PORT:-3000}" api_port="${LIME_API_PORT:-8080}" db_port="${LIME_DB_PORT:-5432}" port project
  [[ "$target" == /* ]] || target="${PWD}/${target}"
  [[ ! -e "$target" && ! -L "$target" ]] || fail "Install destination already exists: $target. Existing files, .env and data were not changed. Choose a fresh LIME_INSTALL_DIR."
  [[ "$target" != *$'\n'* && "$target" != *$'\r'* ]] || fail 'Install path must not contain line breaks.'
  [[ "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || fail 'LIME_REF must be a branch, tag or commit ID, not command options.'
  for port in "$ui_port" "$api_port" "$db_port"; do
    [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || fail 'LIME_UI_PORT, LIME_API_PORT and LIME_DB_PORT must be integers from 1 to 65535.'
  done
  [[ "$ui_port" != "$api_port" && "$ui_port" != "$db_port" && "$api_port" != "$db_port" ]] || fail 'Choose three different UI/API/database ports.'
  kernel="$(uname -s)"
  case "$kernel" in Darwin|Linux) ;; *) fail "Unsupported platform: $kernel. Use the documented Docker installation." ;; esac

  # Do not execute partially downloaded third-party installation scripts.
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/lime-installer.XXXXXX")"
  LIME_INSTALL_TEMP="$temporary_directory"
  trap 'if [[ -n "${LIME_INSTALL_TEMP:-}" ]]; then rm -rf "$LIME_INSTALL_TEMP"; fi' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  elevated() {
    if [[ "$(id -u)" == 0 ]]; then "$@";
    elif command_exists sudo; then sudo "$@";
    else fail 'sudo is required to install system packages/start Docker. Ask your administrator to install prerequisites.'; fi
  }
  checked_download() {
    local source="$1" destination="$2"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$source" --output "$destination" || fail "Download failed: $source. Nothing from this download was executed."
    [[ -s "$destination" ]] || fail "Empty download: $source"
    /bin/bash -n "$destination" || fail "Downloaded installer is not valid shell: $source"
  }
  linux_packages() {
    if command_exists apt-get; then
      elevated apt-get update
      elevated env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y --no-upgrade "$@"
    elif command_exists dnf; then elevated dnf install -y "$@"
    elif command_exists yum; then elevated yum install -y "$@"
    else fail 'Automatic Linux dependencies support apt-get, dnf or yum. Install git, make, curl, openssl, Docker Engine and its Compose plugin manually, then rerun.'; fi
  }
  local docker_endpoint="${DOCKER_HOST:-}"
  require_local_docker() {
    # Docker gives DOCKER_CONTEXT precedence over DOCKER_HOST. Inspect that
    # context even when a local-looking host variable is also present.
    if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
      docker_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' "$DOCKER_CONTEXT")" || fail 'Cannot inspect DOCKER_CONTEXT.'
    elif [[ -z "$docker_endpoint" ]]; then
      docker_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" || fail 'Cannot inspect the active Docker context.'
    fi
    [[ "$docker_endpoint" == unix://* ]] || fail 'This installer requires a local Unix-socket Docker context. Switch away from remote/SSH/TCP Docker before installing; no application containers were created.'
  }
  install_linux_docker() {
    local distro codename architecture conflicting
    distro="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')"
    case "$distro" in
      ubuntu|debian)
        codename="$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release | tr -d '"')"
        architecture="$(dpkg --print-architecture)"
        [[ "$codename" =~ ^[a-z][a-z0-9]+$ && "$architecture" =~ ^[a-z0-9]+$ ]] || fail 'Cannot safely identify the official Docker apt repository for this distribution.'
        conflicting="$(dpkg-query -W -f='${db:Status-Status}\n' docker.io docker-compose docker-doc docker-buildx podman-docker containerd runc 2>/dev/null | grep '^installed$' || true)"
        [[ -z "$conflicting" ]] || fail 'Conflicting Docker/containerd packages exist. Nothing was removed. Follow the official Docker Engine instructions before rerunning.'
        [[ ! -e /etc/apt/keyrings/docker.asc && ! -e /etc/apt/sources.list.d/docker.sources && ! -e /etc/apt/sources.list.d/docker.list ]] || fail 'Docker apt repository configuration already exists but its CLI is missing. Repair that installation manually; existing repository configuration was not overwritten.'
        linux_packages ca-certificates
        curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://download.docker.com/linux/${distro}/gpg" --output "$temporary_directory/docker.asc" || fail 'Docker signing-key download failed; no repository was installed.'
        grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$temporary_directory/docker.asc" || fail 'Docker signing-key download was not an armored public key.'
        printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$distro" "$codename" "$architecture" > "$temporary_directory/docker.sources"
        elevated install -m 0755 -d /etc/apt/keyrings
        elevated install -m 0644 "$temporary_directory/docker.asc" /etc/apt/keyrings/docker.asc
        elevated install -m 0644 "$temporary_directory/docker.sources" /etc/apt/sources.list.d/docker.sources
        linux_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        ;;
      *) fail 'Automatic Docker Engine installation supports Ubuntu/Debian. Install Docker and its Compose plugin using https://docs.docker.com/engine/install/ for your distribution, then rerun. Existing Docker works on other Linux distributions.' ;;
    esac
  }

  if [[ "$kernel" == Darwin ]]; then
    # Apple's git/make shims can exist even when Command Line Tools do not.
    if ! xcode-select -p >/dev/null 2>&1; then
      xcode-select --install >/dev/null 2>&1 || true
      fail 'Finish the Xcode Command Line Tools dialog, then rerun this installer. No LIME directory has been created.'
    fi
    for dependency in git make curl openssl; do command_exists "$dependency" || fail "Missing $dependency. Finish Xcode Command Line Tools installation and rerun."; done
    if ! command_exists docker; then
      if ! command_exists brew; then
        if [[ -x /opt/homebrew/bin/brew ]]; then export PATH="/opt/homebrew/bin:$PATH";
        elif [[ -x /usr/local/bin/brew ]]; then export PATH="/usr/local/bin:$PATH"; fi
      fi
      if ! command_exists brew; then
        [[ "$(id -u)" != 0 ]] || fail 'Homebrew/Docker Desktop installation must run as your ordinary macOS user.'
        say 'Installing Homebrew using its official installer (administrator approval may be required)'
        checked_download https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh "$temporary_directory/homebrew.sh"
        if [[ -r /dev/tty ]]; then
          /bin/bash "$temporary_directory/homebrew.sh" </dev/tty || fail 'Complete Homebrew installation interactively at https://brew.sh, then rerun.'
        else NONINTERACTIVE=1 /bin/bash "$temporary_directory/homebrew.sh" || fail 'Complete Homebrew installation interactively at https://brew.sh, then rerun.'; fi
        export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
        command_exists brew || fail 'Homebrew installation needs interactive approval. Complete https://brew.sh installation and rerun.'
      fi
      say 'Installing Docker Desktop with Homebrew'
      brew install --cask docker || fail 'Docker Desktop installation failed. Install it from https://docs.docker.com/desktop/setup/install/mac-install/ and rerun.'
      export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
    fi
    command_exists docker || fail 'Docker CLI is unavailable. Start Docker Desktop and enable its CLI tools, then rerun.'
    require_local_docker
    if ! docker info >/dev/null 2>&1; then
      say 'Starting Docker Desktop. Complete any license/first-start dialogs in its window.'
      open -a Docker || fail 'Open Docker Desktop manually, complete setup and rerun.'
      for attempt in $(seq 1 60); do
        docker info >/dev/null 2>&1 && break
        sleep 5
      done
      docker info >/dev/null 2>&1 || fail 'Docker Desktop is not ready. Finish its setup dialogs/start the engine, then rerun; no LIME directory was created.'
    fi
  else
    local missing=() dependency
    for dependency in git make curl openssl; do command_exists "$dependency" || missing+=("$dependency"); done
    if [[ "${#missing[@]}" -gt 0 ]]; then say 'Installing missing Linux prerequisites'; linux_packages "${missing[@]}"; fi
    if ! command_exists docker; then
      say 'Installing Docker Engine and Compose from its official apt repository'
      say 'This changes system packages and starts a privileged Docker service; see https://docs.docker.com/engine/install/.'
      install_linux_docker
    fi
    command_exists docker || fail 'Docker installation did not provide its CLI. Complete the official Docker Engine installation and rerun.'
    require_local_docker
    if ! docker info >/dev/null 2>&1; then
      # Socket permissions are not evidence of a stopped daemon. Probe the
      # selected socket first, without starting an unrelated system service.
      if ! elevated docker --host "$docker_endpoint" info >/dev/null 2>&1; then
        if command_exists systemctl; then elevated systemctl start docker || true; fi
      fi
      if ! docker info >/dev/null 2>&1; then
        elevated docker --host "$docker_endpoint" info >/dev/null 2>&1 || fail 'Docker daemon is not available. Start Docker Engine (or your rootless daemon), then rerun.'
        say 'Docker socket requires administrator permission; Docker calls will use sudo. No group memberships are changed.'
        docker_path="$(command -v docker)"
        [[ "$(id -u)" != 0 ]] || fail 'Root cannot reach Docker. Check the daemon and DOCKER_HOST.'
        command_exists sudo || fail 'sudo is required to access this Docker socket.'
        # Make expects a command, not a shell function. This wrapper forwards
        # exact argv to sudo; it does not source configuration or interpolate it.
        printf '#!/usr/bin/env bash\nexec sudo %q --host %q "$@"\n' "$docker_path" "$docker_endpoint" > "$temporary_directory/docker-for-lime"
        chmod 700 "$temporary_directory/docker-for-lime"
      fi
    fi
  fi
  local docker_command="${temporary_directory}/docker-for-lime"
  [[ -x "$docker_command" ]] || docker_command="$(command -v docker)"
  if ! "$docker_command" compose version >/dev/null 2>&1; then
    if [[ "$kernel" == Linux ]]; then say 'Installing the Docker Compose plugin'; linux_packages docker-compose-plugin;
    else fail 'Docker Desktop lacks its Compose plugin. Update Docker Desktop, then rerun.'; fi
  fi
  compose_version="$("$docker_command" compose version --short)" || fail 'Docker Compose plugin is still unavailable. Complete its official installation and rerun.'
  compose_version="${compose_version#v}"
  IFS=. read -r major minor patch <<< "$compose_version"
  patch="${patch%%[^0-9]*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "${patch:-0}" =~ ^[0-9]+$ ]] || fail "Cannot validate Docker Compose version: $compose_version"
  # !override replaces, rather than merges, published ports. Never start with
  # an old Compose version that could retain the original public bindings.
  if (( major < 2 || (major == 2 && minor < 24) || (major == 2 && minor == 24 && ${patch:-0} < 4) )); then
    fail 'Docker Compose 2.24.4+ is required for safe localhost-only port overrides. Update its plugin/Desktop and rerun.'
  fi
  for dependency in git make curl openssl; do command_exists "$dependency" || fail "Missing required command after setup: $dependency"; done
  if [[ -n "$("$docker_command" ps -a --filter name='^/lime-(db|shopkeeper|ui)$' --format '{{.Names}}')" ]]; then
    fail 'A lime-db, lime-shopkeeper or lime-ui container already exists. Nothing was stopped. Use the existing deployment/update guide instead.'
  fi
  if [[ -n "$("$docker_command" volume ls --filter name='^lime_(pgdata|screenshots)$' --format '{{.Name}}')" ]]; then
    fail 'Existing lime_pgdata/lime_screenshots volumes were found. They were not changed. Use the existing deployment/update guide instead.'
  fi
  say 'Checking localhost port availability with a disposable, volume-free container'
  "$docker_command" run --rm --entrypoint /bin/true \
    -p "127.0.0.1:${db_port}:5432" -p "127.0.0.1:${api_port}:8080" -p "127.0.0.1:${ui_port}:3000" postgres:17.11-alpine || fail 'Local ports are occupied or Docker cannot start a container. Choose different LIME_DB_PORT/LIME_API_PORT/LIME_UI_PORT values. No LIME clone or data was created.'
  say "Cloning sumanbasuli/lime into $target (ref: $ref)"
  mkdir -p "$(dirname "$target")"
  git clone -- https://github.com/sumanbasuli/lime.git "$target"
  # Keep the default source install on its tracking branch, as git clone does.
  # Explicit version/tag/commit installs are intentionally pinned.
  if [[ "$ref" == main ]]; then
    git -C "$target" checkout main
  elif git -C "$target" rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
    git -C "$target" checkout --detach "$ref"
  else git -C "$target" checkout --detach "origin/${ref}"; fi
  [[ -f "$target/.env.example" && -f "$target/Makefile" && -f "$target/docker-compose.yml" && -f "$target/VERSION" ]] || fail 'Selected revision lacks the expected source deployment files. Its clone was retained for inspection.'
  [[ ! -e "$target/.env" ]] || fail 'Clone unexpectedly contains .env. It was not overwritten.'
  # Only this fresh clone's public JSON catalogs are bind-mounted into two
  # non-root containers. Keep them readable even if the caller uses umask 077;
  # do not broaden permissions on the checkout, configuration, or captures.
  [[ ! -L "$target/data" ]] || fail 'The cloned data directory must not be a symlink.'
  if [[ -d "$target/data" ]]; then
    local catalog
    for catalog in "$target/data/"*.json; do
      [[ -e "$catalog" || -L "$catalog" ]] || continue
      [[ -f "$catalog" && ! -L "$catalog" ]] || fail 'Public catalog paths must be ordinary JSON files.'
    done
    chmod 0755 "$target/data"
    for catalog in "$target/data/"*.json; do
      [[ -f "$catalog" ]] || continue
      chmod 0644 "$catalog"
    done
  fi
  version="$(tr -d '[:space:]' < "$target/VERSION")"
  commit="$(git -C "$target" rev-parse --short HEAD)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ && "$commit" =~ ^[0-9a-fA-F]{7,40}$ ]] || fail 'Selected revision has invalid version/commit metadata.'
  password="$(openssl rand -hex 24)"
  [[ "$password" =~ ^[0-9a-fA-F]{48}$ ]] || fail 'OpenSSL failed to generate a database password.'
  project="lime-install-$(openssl rand -hex 4)"
  [[ "$project" =~ ^lime-install-[0-9a-fA-F]{8}$ ]] || fail 'Could not generate an isolated Compose project name.'
  umask 077
  cp "$target/.env.example" "$target/.env"
  # Generated values are restricted hex; no user-controlled env file is sourced.
  sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${password}/" \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://lime:${password}@localhost:${db_port}/lime_db?sslmode=disable|" \
    -e "s|^SHOPKEEPER_URL=.*|SHOPKEEPER_URL=http://localhost:${api_port}|" \
    -e "s|^LIME_API_PORT=.*|LIME_API_PORT=${api_port}|" \
    -e "s|^LIME_UI_PORT=.*|LIME_UI_PORT=${ui_port}|" \
    "$target/.env" > "$temporary_directory/lime.env"
  cp "$temporary_directory/lime.env" "$target/.env"
  printf '\nLIME_DB_PORT=%s\nCOMPOSE_PROJECT_NAME=%s\nCOMPOSE_FILE=docker-compose.yml:docker-compose.install.yml\nLIME_VERSION=%s\nLIME_COMMIT=%s\n' "$db_port" "$project" "$version" "$commit" >> "$target/.env"
  chmod 600 "$target/.env"
  printf '%s\n' \
    'services:' '  db:' '    ports: !override' "      - \"127.0.0.1:${db_port}:5432\"" \
    '  shopkeeper:' '    build:' '      args:' '        LIME_VERSION: ${LIME_VERSION}' '        LIME_COMMIT: ${LIME_COMMIT}' \
    '    ports: !override' "      - \"127.0.0.1:${api_port}:8080\"" \
    '  ui:' '    build:' '      args:' '        LIME_VERSION: ${LIME_VERSION}' '        LIME_COMMIT: ${LIME_COMMIT}' \
    '    ports: !override' "      - \"127.0.0.1:${ui_port}:3000\"" > "$target/docker-compose.install.yml"
  local compose_command="$docker_command compose -f docker-compose.yml -f docker-compose.install.yml"
  # The temporary sudo wrapper has a mktemp path without spaces; refuse unsafe
  # executable paths because Make's DOCKER_COMPOSE is a command string.
  [[ "$docker_command" != *' '* ]] || fail 'Docker executable path contains spaces. Use a standard CLI installation path.'
  say 'Building and starting LIME. First builds can take several minutes.'
  if ! make -C "$target" DOCKER_COMPOSE="$compose_command" COMPOSE_PROJECT_NAME="$project" start-all; then
    fail "LIME build/start failed. Clone/config/data were retained at $target. Inspect Docker logs; do not delete volumes or rerun over this directory."
  fi
  local container installed_project
  for container in lime-db lime-shopkeeper lime-ui; do
    installed_project="$("$docker_command" inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
    [[ "$installed_project" == "$project" ]] || fail "Container $container is not owned by this installation. Inspect the retained installation before continuing."
  done
  say 'Checking backend, dashboard proxy and database-backed scan list readiness'
  local ready=false
  for attempt in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${api_port}/api/health" > "$temporary_directory/backend.json" 2>/dev/null &&
       curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${ui_port}/api/health" > "$temporary_directory/ui.json" 2>/dev/null &&
       curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${ui_port}/api/scans" > "$temporary_directory/scans.json" 2>/dev/null &&
       curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${ui_port}/" > "$temporary_directory/dashboard.html" 2>/dev/null &&
       curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${ui_port}/logo.svg" > "$temporary_directory/logo.svg" 2>/dev/null &&
       grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' "$temporary_directory/backend.json" &&
       grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' "$temporary_directory/ui.json" &&
       grep -q '^\[' "$temporary_directory/scans.json" && grep -qi '<html' "$temporary_directory/dashboard.html" && grep -qi '<svg' "$temporary_directory/logo.svg"; then
      ready=true; break
    fi
    sleep 5
  done
  [[ "$ready" == true ]] || fail "LIME did not become ready. Installation was retained at $target; inspect its Compose logs before retrying startup."
  say "LIME is ready at http://localhost:${ui_port}"
  printf 'Installed in: %s\nAll database/API/UI ports are bound to localhost, not the public network.\n' "$target"
  printf 'For a remote VPS, run on your computer: ssh -L %s:127.0.0.1:%s USER@SERVER\nThen open http://localhost:%s.\n' "$ui_port" "$ui_port" "$ui_port"
  printf 'Start/stop later with the same overrides:\n  cd %q\n  ' "$target"
  if [[ -x "$temporary_directory/docker-for-lime" ]]; then
    printf 'sudo %q --host %q ' "$docker_path" "$docker_endpoint"
  else printf '%q ' "$docker_command"; fi
  printf 'compose -f docker-compose.yml -f docker-compose.install.yml up -d\n'
  printf 'Use down without -v for shutdown. Preserve .env, database and screenshot volumes.\n'
}

# Do not move the invocation above this sentinel. bash parses the function but
# performs no system/installation actions until the final lines arrive.
LIME_INSTALL_SCRIPT_COMPLETE=lime-installer-v1-complete
lime_install_main "$@"
