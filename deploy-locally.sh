#!/usr/bin/env bash
# Inference Studio — deploy-locally.sh
# Supports: macOS (arm64/x86_64) · Debian/Ubuntu · Arch/CachyOS · Fedora/RHEL/CentOS
# Usage:  bash deploy-locally.sh   (will prompt for your password if needed)

set -euo pipefail
IFS=$'\n\t'

# ─────────────────────────────────────────────────────────────────────────────
# Terminal colours + helpers
# ─────────────────────────────────────────────────────────────────────────────
B=$'\033[1m'; R=$'\033[0m'
RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[0;33m'
CYN=$'\033[0;36m'; LIME=$'\033[38;5;154m'; GRY=$'\033[0;90m'

log()     { printf "${GRY}[IS]${R} %s\n" "$*"; }
ok()      { printf " ${GRN}✓${R}  %s\n" "$*"; }
warn()    { printf " ${YLW}⚠${R}  %s\n" "$*"; }
err()     { printf " ${RED}✗${R}  %s\n" "$*" >&2; }
die()     { err "$*"; exit 1; }
section() { printf "\n${B}${LIME}▶ %s${R}\n" "$*"; }
hr()      { printf "${GRY}──────────────────────────────────────────────────────────${R}\n"; }

spin() {
  local pid=$1 msg=${2:-working}
  local -a frames=("⣾" "⣽" "⣻" "⢿" "⡿" "⣟" "⣯" "⣷")
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r   ${CYN}%s${R}  %s…" "${frames[$((i % 8))]}" "$msg"
    sleep 0.1; ((i++)) || true
  done
  printf "\r   ${GRN}✓${R}  %-60s\n" "$msg"
}

# ─────────────────────────────────────────────────────────────────────────────
# Sudo management — prompt once, keep alive
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_USER="$USER"
SUDO_KEEP_ALIVE=""

# S wraps sudo — empty if already root
if [[ $EUID -eq 0 ]]; then
  S=""
else
  S="sudo"
fi

ensure_sudo() {
  [[ -z "$S" ]] && return 0

  if $S -n true 2>/dev/null; then
    : # credentials already cached
  else
    printf "\n${LIME}▶ Admin access required${R} to install dependencies.\n"
    printf "${GRY}  Enter your password when prompted — asked only once:${R}\n\n"
    $S -v || die "Admin access denied."
  fi

  # Keep credentials alive in background
  (while true; do $S -n true 2>/dev/null; sleep 50; done) &
  SUDO_KEEP_ALIVE=$!
}

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────
WEB_PORT=3000
API_PORT=3001
VLLM_PORT=8000

# ─────────────────────────────────────────────────────────────────────────────
# Banner
# ─────────────────────────────────────────────────────────────────────────────
print_banner() {
  printf "\n${B}${LIME}"
  printf "  ╔══════════════════════════════════════════╗\n"
  printf "  ║        INFERENCE  STUDIO  v1.0           ║\n"
  printf "  ║        Self-hosted vLLM inference        ║\n"
  printf "  ╚══════════════════════════════════════════╝${R}\n\n"
}

# ─────────────────────────────────────────────────────────────────────────────
# OS + arch detection
# ─────────────────────────────────────────────────────────────────────────────
OS=""
ARCH=""

detect_os() {
  ARCH=$(uname -m)
  [[ "$ARCH" == "aarch64" ]] && ARCH="arm64"

  case "$(uname -s)" in
    Darwin)
      OS="macos"
      ;;
    Linux)
      local id_like id
      id_like=$(grep '^ID_LIKE=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
      id=$(grep '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || true)

      if [[ -f /etc/arch-release ]] || [[ "$id" == "arch" ]] || echo "$id_like" | grep -q "arch"; then
        OS="arch"
      elif [[ -f /etc/debian_version ]] || [[ "$id" == "debian" ]] || [[ "$id" == "ubuntu" ]] || echo "$id_like" | grep -q "debian"; then
        OS="debian"
      elif [[ -f /etc/fedora-release ]] || [[ "$id" == "fedora" ]] || [[ -f /etc/redhat-release ]]; then
        OS="fedora"
      else
        die "Unsupported Linux distribution. Supported: Debian/Ubuntu, Arch/CachyOS, Fedora/RHEL."
      fi
      ;;
    *)
      die "Unsupported OS: $(uname -s)"
      ;;
  esac

  log "OS: ${B}$OS${R} · arch: ${B}$ARCH${R}"
}

# ─────────────────────────────────────────────────────────────────────────────
# GPU detection
# ─────────────────────────────────────────────────────────────────────────────
GPU_TYPE="cpu"
GPU_VRAM=0
GPU_NAME="None (CPU mode)"

detect_gpu() {
  section "Detecting GPU"

  if command -v nvidia-smi &>/dev/null 2>&1; then
    local gpu_name vram_mb
    gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "NVIDIA GPU")
    vram_mb=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo 0)
    GPU_VRAM=$(( vram_mb / 1024 ))
    GPU_TYPE="nvidia"
    GPU_NAME="$gpu_name (${GPU_VRAM}GB VRAM)"
    ok "NVIDIA GPU: ${B}$gpu_name${R} · ${GPU_VRAM} GB VRAM"
  elif [[ "$OS" == "macos" ]]; then
    if system_profiler SPDisplaysDataType 2>/dev/null | grep -qi "apple"; then
      GPU_TYPE="metal"
      GPU_NAME="Apple Silicon (Metal)"
      local total_ram
      total_ram=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
      GPU_VRAM=$(( total_ram / 1024 / 1024 / 1024 / 2 ))
      ok "Apple Silicon · ~${GPU_VRAM}GB unified memory"
      warn "Docker cannot use Apple Metal — vLLM runs on CPU inside Docker (slow)."
    else
      GPU_TYPE="cpu"
      warn "No Metal GPU detected. Using CPU mode."
    fi
  else
    GPU_TYPE="cpu"
    warn "No NVIDIA GPU detected. Using CPU mode (slow; max 7B models recommended)."
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Package helpers
# ─────────────────────────────────────────────────────────────────────────────
pkg_ok() { command -v "$1" &>/dev/null; }

install_pkg() {
  local cmd=$1 pkg=${2:-$1}
  pkg_ok "$cmd" && { ok "$cmd already installed"; return 0; }
  case "$OS" in
    debian) $S apt-get install -y -qq "$pkg" >/dev/null 2>&1 & ;;
    arch)   $S pacman -S --noconfirm --needed "$pkg" >/dev/null 2>&1 & ;;
    fedora) $S dnf install -y -q "$pkg" >/dev/null 2>&1 & ;;
    macos)  brew install "$pkg" >/dev/null 2>&1 & ;;
  esac
  spin $! "Installing $cmd"
}

# ─────────────────────────────────────────────────────────────────────────────
# Docker installation
# ─────────────────────────────────────────────────────────────────────────────
install_docker() {
  if pkg_ok docker && docker info >/dev/null 2>&1; then
    ok "Docker is already running"
    return 0
  fi

  section "Installing Docker Engine"

  case "$OS" in
    debian)
      $S apt-get install -y -qq ca-certificates curl gnupg >/dev/null 2>&1
      $S install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" \
        | $S gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
      $S chmod a+r /etc/apt/keyrings/docker.gpg
      printf "deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n" \
        "$(dpkg --print-architecture)" \
        "$(. /etc/os-release && echo "$ID")" \
        "$(. /etc/os-release && echo "$VERSION_CODENAME")" \
        | $S tee /etc/apt/sources.list.d/docker.list >/dev/null
      $S apt-get update -qq >/dev/null 2>&1 &
      spin $! "Updating package lists"
      $S apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1 &
      spin $! "Installing Docker Engine"
      ;;
    arch)
      $S pacman -S --noconfirm --needed docker docker-compose >/dev/null 2>&1 &
      spin $! "Installing Docker"
      ;;
    fedora)
      $S dnf install -y -q dnf-plugins-core >/dev/null 2>&1
      $S dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo >/dev/null 2>&1
      $S dnf install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1 &
      spin $! "Installing Docker Engine"
      ;;
    macos)
      if ! pkg_ok brew; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
          </dev/null >/dev/null 2>&1 &
        spin $! "Installing Homebrew"
      fi
      brew install --cask docker >/dev/null 2>&1 &
      spin $! "Installing Docker Desktop"
      printf "\n ${YLW}⚠${R}  Docker Desktop installed.\n"
      printf "      Please open it from Applications and wait for the whale icon,\n"
      printf "      then run this script again.\n\n"
      open -a Docker 2>/dev/null || true
      exit 0
      ;;
  esac

  if [[ "$OS" != "macos" ]]; then
    $S systemctl enable --now docker >/dev/null 2>&1 || true
    # Make socket accessible without sudo for the current session
    $S chmod 666 /var/run/docker.sock 2>/dev/null || true
    # Add user to docker group for future sessions
    [[ -n "$REAL_USER" && "$REAL_USER" != "root" ]] && \
      $S usermod -aG docker "$REAL_USER" 2>/dev/null || true
  fi

  docker info >/dev/null 2>&1 || \
    die "Docker installed but not accessible. Try: $S chmod 666 /var/run/docker.sock"
  ok "Docker is running"
}

# ─────────────────────────────────────────────────────────────────────────────
# NVIDIA Container Toolkit
# ─────────────────────────────────────────────────────────────────────────────
install_nvidia_toolkit() {
  [[ "$GPU_TYPE" != "nvidia" ]] && return 0

  # Quick toolkit check: try nvidia-ctk or the runtime config file
  if nvidia-ctk --version >/dev/null 2>&1 || \
     [[ -f /etc/docker/daemon.json ]] && grep -q nvidia /etc/docker/daemon.json 2>/dev/null; then
    ok "NVIDIA Container Toolkit already installed"
    return 0
  fi

  section "Installing NVIDIA Container Toolkit"

  case "$OS" in
    debian)
      curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | $S gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null
      curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        | $S tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
      $S apt-get update -qq >/dev/null 2>&1
      $S apt-get install -y -qq nvidia-container-toolkit >/dev/null 2>&1 &
      spin $! "Installing NVIDIA Container Toolkit"
      ;;
    arch)
      $S pacman -S --noconfirm --needed nvidia-container-toolkit >/dev/null 2>&1 &
      spin $! "Installing NVIDIA Container Toolkit"
      ;;
    fedora)
      curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
        | $S tee /etc/yum.repos.d/nvidia-container-toolkit.repo >/dev/null
      $S dnf install -y -q nvidia-container-toolkit >/dev/null 2>&1 &
      spin $! "Installing NVIDIA Container Toolkit"
      ;;
    macos) return 0 ;;
  esac

  $S nvidia-ctk runtime configure --runtime=docker >/dev/null 2>&1 || true
  $S systemctl restart docker >/dev/null 2>&1 || true
  sleep 3
  $S chmod 666 /var/run/docker.sock 2>/dev/null || true
  ok "NVIDIA Container Toolkit configured"
}

# ─────────────────────────────────────────────────────────────────────────────
# cloudflared — binary download (no AUR, no package manager complexity)
# ─────────────────────────────────────────────────────────────────────────────
install_cloudflared() {
  if pkg_ok cloudflared; then
    ok "cloudflared already installed"
    return 0
  fi

  section "Installing Cloudflare Tunnel client"
  log "No Cloudflare account required — trycloudflare.com"

  local base="https://github.com/cloudflare/cloudflared/releases/latest/download"
  local tmpdir; tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" RETURN

  case "$OS" in
    debian)
      local pkg="cloudflared-linux-amd64.deb"
      [[ "$ARCH" == "arm64" ]] && pkg="cloudflared-linux-arm64.deb"
      curl -fsSL "$base/$pkg" -o "$tmpdir/cloudflared.deb" >/dev/null 2>&1 &
      spin $! "Downloading cloudflared"
      $S dpkg -i "$tmpdir/cloudflared.deb" >/dev/null 2>&1 \
        && ok "cloudflared installed" \
        || { warn "deb install failed, trying binary"; _cloudflared_bin "$tmpdir"; }
      ;;
    arch|fedora)
      _cloudflared_bin "$tmpdir"
      ;;
    macos)
      brew install cloudflare/cloudflare/cloudflared >/dev/null 2>&1 &
      spin $! "Installing cloudflared"
      ok "cloudflared installed"
      ;;
  esac
}

_cloudflared_bin() {
  local tmpdir=${1:-/tmp}
  local bin="cloudflared-linux-amd64"
  [[ "$ARCH" == "arm64" ]] && bin="cloudflared-linux-arm64"
  local base="https://github.com/cloudflare/cloudflared/releases/latest/download"
  curl -fsSL "$base/$bin" -o "$tmpdir/cloudflared" >/dev/null 2>&1 &
  spin $! "Downloading cloudflared binary"
  $S install -m 0755 "$tmpdir/cloudflared" /usr/local/bin/cloudflared
  ok "cloudflared installed"
}

# ─────────────────────────────────────────────────────────────────────────────
# All dependencies
# ─────────────────────────────────────────────────────────────────────────────
install_all_deps() {
  section "Installing system dependencies"

  # Only prompt for sudo if something actually needs installing.
  # Running in non-interactive shells (no TTY) fails if sudo isn't cached,
  # so skip the prompt entirely when every dep is already present.
  local _needs_sudo=false
  for _p in curl wget git jq; do pkg_ok "$_p" || { _needs_sudo=true; break; }; done
  if ! $_needs_sudo; then
    { pkg_ok docker && docker info >/dev/null 2>&1; } || _needs_sudo=true
  fi
  if ! $_needs_sudo && [[ "$GPU_TYPE" == "nvidia" ]]; then
    { nvidia-ctk --version >/dev/null 2>&1 || \
      { [[ -f /etc/docker/daemon.json ]] && grep -q nvidia /etc/docker/daemon.json 2>/dev/null; }; } \
      || _needs_sudo=true
  fi
  if ! $_needs_sudo; then pkg_ok cloudflared || _needs_sudo=true; fi
  $_needs_sudo && ensure_sudo

  if $_needs_sudo; then
    case "$OS" in
      debian)
        $S apt-get update -qq >/dev/null 2>&1 &
        spin $! "Updating package lists"
        for p in curl wget git jq; do install_pkg "$p"; done
        ;;
      arch)
        $S pacman -Sy --noconfirm >/dev/null 2>&1 &
        spin $! "Syncing package database"
        for p in curl wget git jq; do install_pkg "$p"; done
        ;;
      fedora)
        $S dnf makecache -q >/dev/null 2>&1 &
        spin $! "Updating package cache"
        for p in curl wget git jq; do install_pkg "$p"; done
        ;;
      macos)
        if ! pkg_ok brew; then
          /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
            </dev/null >/dev/null 2>&1 &
          spin $! "Installing Homebrew"
        fi
        for p in curl wget git jq; do install_pkg "$p"; done
        ;;
    esac
  else
    for p in curl wget git jq; do ok "$p already installed"; done
  fi

  install_docker
  install_nvidia_toolkit
  install_cloudflared

  ok "All dependencies ready"
}

# ─────────────────────────────────────────────────────────────────────────────
# docker compose command detection
# ─────────────────────────────────────────────────────────────────────────────
COMPOSE_CMD=()

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    die "docker compose not found. Install docker-compose-plugin."
  fi
  log "Compose: ${B}$(IFS=' '; echo "${COMPOSE_CMD[*]}")${R}"
}

# ─────────────────────────────────────────────────────────────────────────────
# Docker Desktop settings proxy (enables admin memory control from containers)
# Docker Desktop blocks bind-mounting its backend.sock from ~/Library/Containers,
# so we run a small host-side TCP proxy and reach it via host.docker.internal.
# ─────────────────────────────────────────────────────────────────────────────
DOCKER_DESKTOP_PROXY_PORT=23760

find_docker_desktop_socket() {
  if [[ "$OS" == "macos" && -S "$HOME/Library/Containers/com.docker.docker/Data/backend.sock" ]]; then
    echo "$HOME/Library/Containers/com.docker.docker/Data/backend.sock"
  elif [[ -S "$HOME/.docker/desktop/backend.sock" ]]; then
    echo "$HOME/.docker/desktop/backend.sock"
  fi
}

stop_docker_desktop_proxy() {
  local pid_file="$SCRIPT_DIR/data/docker-desktop-proxy.pid"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid=$(cat "$pid_file" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  rm -f "$pid_file"
}

start_docker_desktop_proxy() {
  local socket override="$SCRIPT_DIR/docker-compose.override.yml"
  socket=$(find_docker_desktop_socket)

  stop_docker_desktop_proxy
  rm -f "$override"

  [[ -n "$socket" ]] || return 0

  mkdir -p "$SCRIPT_DIR/data"
  DOCKER_DESKTOP_SOCKET="$socket" \
    DOCKER_DESKTOP_PROXY_PORT="$DOCKER_DESKTOP_PROXY_PORT" \
    python3 "$SCRIPT_DIR/scripts/docker-desktop-proxy.py" \
    >"$SCRIPT_DIR/data/docker-desktop-proxy.log" 2>&1 &
  echo $! > "$SCRIPT_DIR/data/docker-desktop-proxy.pid"
  sleep 0.3

  if ! kill -0 "$(cat "$SCRIPT_DIR/data/docker-desktop-proxy.pid")" 2>/dev/null; then
    warn "Docker Desktop proxy failed to start — admin memory control unavailable."
    rm -f "$SCRIPT_DIR/data/docker-desktop-proxy.pid"
    return 0
  fi

  cat > "$override" <<EOF
# Auto-generated by deploy-locally.sh — Docker Desktop admin settings API
services:
  api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - DOCKER_DESKTOP_PROXY=http://host.docker.internal:${DOCKER_DESKTOP_PROXY_PORT}
EOF
  ok "Docker Desktop settings API enabled (host proxy :${DOCKER_DESKTOP_PROXY_PORT})"
}

write_docker_desktop_override() {
  start_docker_desktop_proxy
}

# ─────────────────────────────────────────────────────────────────────────────
# Docker memory check (CPU / Apple Silicon)
# ─────────────────────────────────────────────────────────────────────────────
check_docker_memory() {
  [[ "$GPU_TYPE" == "nvidia" ]] && return 0

  local mem_bytes mem_gb
  mem_bytes=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  [[ "$mem_bytes" == "0" ]] && return 0
  mem_gb=$(( mem_bytes / 1024 / 1024 / 1024 ))

  log "Docker memory: ${B}${mem_gb} GB${R}"
  if [[ "$mem_gb" -lt 12 ]]; then
    warn "Phi-4 Mini needs ~11GB total on CPU (weights + overhead)."
    warn "Increase Docker Desktop → Settings → Resources → Memory to 16GB+."
    warn "TinyLlama (~5GB total) fits at the current ${mem_gb}GB limit."
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Start Inference Studio
# ─────────────────────────────────────────────────────────────────────────────
start_studio() {
  section "Starting Inference Studio"

  detect_compose
  write_docker_desktop_override
  check_docker_memory
  cd "$SCRIPT_DIR"
  mkdir -p data

  [[ ! -f .env ]] && { cp .env.example .env; log "Created .env from .env.example"; }

  # Pass GPU type into compose environment (nvidia-smi → nvidia, else metal/cpu)
  export GPU_TYPE VLLM_PORT

  # Free up ports if other containers are using them
  for port in $WEB_PORT $API_PORT; do
    local cid
    cid=$(docker ps -q --filter "publish=$port" 2>/dev/null || true)
    [[ -n "$cid" ]] && docker stop "$cid" >/dev/null 2>&1 || true
  done

  printf "   ${CYN}⋯${R}  Building containers (first run: several minutes)…\n"
  local _build_log; _build_log=$(mktemp)
  "${COMPOSE_CMD[@]}" build --pull >"$_build_log" 2>&1 &
  local _build_pid=$!
  spin $_build_pid "Building Docker images"
  wait $_build_pid || {
    printf "\r   ${RED}✗${R}  Docker build failed:\n"
    cat "$_build_log"
    rm -f "$_build_log"
    die "Fix the build errors above and re-run."
  }
  rm -f "$_build_log"

  local _up_log; _up_log=$(mktemp)
  "${COMPOSE_CMD[@]}" up -d >"$_up_log" 2>&1 &
  local _up_pid=$!
  spin $_up_pid "Starting services"
  wait $_up_pid || {
    printf "\r   ${RED}✗${R}  docker compose up failed:\n"
    cat "$_up_log"
    rm -f "$_up_log"
    die "Containers failed to start — see errors above."
  }
  rm -f "$_up_log"

  # Wait for API (up to 3 min)
  local deadline=$(( $(date +%s) + 180 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1 \
    && ok "API ready  →  http://localhost:$API_PORT" \
    || warn "API health check timed out — run: $(IFS=' '; echo "${COMPOSE_CMD[*]}") logs api"

  # Wait for web (up to 3 min)
  deadline=$(( $(date +%s) + 180 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    curl -sf "http://localhost:$WEB_PORT" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -sf "http://localhost:$WEB_PORT" >/dev/null 2>&1 \
    && ok "Web UI ready  →  http://localhost:$WEB_PORT" \
    || warn "Web UI health check timed out — run: $(IFS=' '; echo "${COMPOSE_CMD[*]}") logs web"
}

# ─────────────────────────────────────────────────────────────────────────────
# Cloudflare Quick Tunnel (no account needed)
# ─────────────────────────────────────────────────────────────────────────────
TUNNEL_PID=""
TUNNEL_URL=""

start_tunnel() {
  if ! pkg_ok cloudflared; then
    warn "cloudflared not found — skipping tunnel. Instance is local-only."
    return 0
  fi

  section "Starting Cloudflare Quick Tunnel"
  log "No Cloudflare account required — powered by trycloudflare.com"

  local tmplog; tmplog=$(mktemp)

  cloudflared tunnel --url "http://localhost:$WEB_PORT" --no-autoupdate \
    >"$tmplog" 2>&1 &
  TUNNEL_PID=$!

  local elapsed=0
  while [[ $elapsed -lt 40 ]]; do
    TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$tmplog" 2>/dev/null | head -1 || true)
    [[ -n "$TUNNEL_URL" ]] && break
    sleep 1; ((elapsed++)) || true
  done
  rm -f "$tmplog"

  if [[ -n "$TUNNEL_URL" ]]; then
    ok "Tunnel: ${B}${LIME}$TUNNEL_URL${R}"

    # Register with API
    local admin_token
    admin_token=$(get_admin_token 2>/dev/null || echo "")
    if [[ -n "$admin_token" ]]; then
      curl -sf -X POST "http://localhost:$API_PORT/setup/tunnel" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $admin_token" \
        -d "{\"url\": \"$TUNNEL_URL\"}" >/dev/null 2>&1 || true
    fi
  else
    warn "Could not obtain tunnel URL. Remote access unavailable this session."
  fi
}

get_admin_token() {
  local user="admin" pass="password"
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    local u p
    u=$(grep '^ADMIN_USERNAME=' "$SCRIPT_DIR/.env" | cut -d= -f2 | tr -d '"' 2>/dev/null || true)
    p=$(grep '^ADMIN_PASSWORD=' "$SCRIPT_DIR/.env" | cut -d= -f2 | tr -d '"' 2>/dev/null || true)
    [[ -n "$u" ]] && user="$u"
    [[ -n "$p" ]] && pass="$p"
  fi
  curl -sf -X POST "http://localhost:$API_PORT/admin/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\": \"$user\", \"password\": \"$pass\"}" 2>/dev/null \
    | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
# Open browser
# ─────────────────────────────────────────────────────────────────────────────
open_browser() {
  local url="http://localhost:$WEB_PORT"
  case "$OS" in
    macos) open "$url" 2>/dev/null || true ;;
    *)
      xdg-open "$url" 2>/dev/null || \
      sensible-browser "$url" 2>/dev/null || true
      ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
print_summary() {
  printf "\n"; hr; printf "\n"
  printf "  ${B}${LIME}Inference Studio is running!${R}\n\n"
  printf "  ${B}Web UI${R}   →  ${CYN}http://localhost:$WEB_PORT${R}\n"
  printf "  ${B}API${R}      →  ${CYN}http://localhost:$API_PORT${R}\n"
  printf "  ${B}Admin${R}    →  ${CYN}http://localhost:$WEB_PORT/admin${R}\n"
  [[ -n "$TUNNEL_URL" ]] && \
    printf "  ${B}Public${R}   →  ${LIME}$TUNNEL_URL${R}\n"
  printf "\n"
  printf "  ${GRY}Default login: admin / password  (change at /admin → Settings)${R}\n"
  printf "  ${GRY}GPU: $GPU_NAME${R}\n\n"
  hr
  printf "\n  ${GRY}Select a model in the browser and generate an API key at ${B}/admin${R}${GRY}.${R}\n"
  printf "  ${GRY}Press ${B}Ctrl+C${R}${GRY} to stop.${R}\n\n"
}

# ─────────────────────────────────────────────────────────────────────────────
# Cleanup
# ─────────────────────────────────────────────────────────────────────────────
cleanup() {
  printf "\n${GRY}Shutting down Inference Studio…${R}\n"
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  [[ -n "$SUDO_KEEP_ALIVE" ]] && kill "$SUDO_KEEP_ALIVE" 2>/dev/null || true
  cd "$SCRIPT_DIR"
  if [[ ${#COMPOSE_CMD[@]} -gt 0 ]]; then
    "${COMPOSE_CMD[@]}" stop >/dev/null 2>&1 || true
  else
    docker compose stop >/dev/null 2>&1 || true
  fi
  printf "${GRN}Done.${R}\n"
}
trap cleanup EXIT INT TERM

# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────
main() {
  print_banner
  detect_os
  detect_gpu
  install_all_deps
  start_studio
  start_tunnel
  open_browser
  print_summary

  if [[ -n "$TUNNEL_PID" ]]; then
    wait "$TUNNEL_PID" 2>/dev/null || true
  else
    while true; do sleep 30; done
  fi
}

main "$@"
