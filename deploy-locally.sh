#!/usr/bin/env bash
# Inference Studio — deploy-locally.sh
# Supports: macOS (arm64/x86_64) · Debian/Ubuntu · Arch Linux · Fedora/RHEL/CentOS
# Run with: bash deploy-locally.sh

set -euo pipefail
IFS=$'\n\t'

# ─────────────────────────────────────────────────────────────────────────────
# Terminal colours + helpers
# ─────────────────────────────────────────────────────────────────────────────
B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[0;33m'
BLU=$'\033[0;34m'; CYN=$'\033[0;36m'; LIME=$'\033[38;5;154m'
GRY=$'\033[0;90m'

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
  printf "\r   ${GRN}✓${R}  %-55s\n" "$msg"
}

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_PORT=3000
API_PORT=3001

# ─────────────────────────────────────────────────────────────────────────────
# Banner
# ─────────────────────────────────────────────────────────────────────────────
print_banner() {
  printf "\n${B}${LIME}"
  printf "  ╔══════════════════════════════════════════╗\n"
  printf "  ║        INFERENCE  STUDIO  v1.0           ║\n"
  printf "  ║   Self-hosted AI inference — locally     ║\n"
  printf "  ╚══════════════════════════════════════════╝${R}\n\n"
}

# ─────────────────────────────────────────────────────────────────────────────
# OS + arch detection
# ─────────────────────────────────────────────────────────────────────────────
OS=""
ARCH=""
PKG=""

detect_os() {
  ARCH=$(uname -m)
  [[ "$ARCH" == "aarch64" ]] && ARCH="arm64"

  case "$(uname -s)" in
    Darwin)
      OS="macos"
      ;;
    Linux)
      if [[ -f /etc/debian_version ]]; then
        OS="debian"; PKG="apt-get"
      elif [[ -f /etc/arch-release ]]; then
        OS="arch"; PKG="pacman"
      elif [[ -f /etc/fedora-release ]] || [[ -f /etc/redhat-release ]]; then
        OS="fedora"; PKG="dnf"
      else
        die "Unsupported Linux distro. Supported: Debian/Ubuntu, Arch, Fedora/RHEL."
      fi
      ;;
    *)
      die "Unsupported OS: $(uname -s)"
      ;;
  esac

  log "OS: ${B}$OS${R} · arch: ${B}$ARCH${R}"
}

# ─────────────────────────────────────────────────────────────────────────────
# Sudo / admin
# ─────────────────────────────────────────────────────────────────────────────
SUDO=""
SUDO_KEEP_ALIVE=""

ensure_sudo() {
  [[ "$OS" == "macos" ]] && { SUDO="sudo"; return; }
  [[ $EUID -eq 0 ]] && { SUDO=""; return; }

  if ! sudo -n true 2>/dev/null; then
    printf "\n${YLW}Admin access is needed to install dependencies.${R}\n"
    sudo -v || die "sudo required"
  fi
  SUDO="sudo"
  # Keep-alive: refresh sudo every 50s
  (while true; do sudo -n true; sleep 50; done) 2>/dev/null &
  SUDO_KEEP_ALIVE=$!
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
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "NVIDIA GPU")
    local vram_mb
    vram_mb=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo 0)
    GPU_VRAM=$(( vram_mb / 1024 ))
    GPU_TYPE="nvidia"
    ok "NVIDIA GPU: ${B}$GPU_NAME${R} (${GPU_VRAM} GB VRAM)"
  elif [[ "$OS" == "macos" ]]; then
    if system_profiler SPDisplaysDataType 2>/dev/null | grep -qi "apple"; then
      GPU_TYPE="metal"
      GPU_NAME="Apple Silicon (Metal)"
      local total_ram
      total_ram=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
      GPU_VRAM=$(( total_ram / 1024 / 1024 / 1024 / 2 ))
      ok "Apple Silicon: ${B}Metal${R} (~${GPU_VRAM} GB unified memory)"
      warn "vLLM Metal support is experimental — performance may be limited."
    else
      GPU_TYPE="cpu"
      warn "No Apple Silicon GPU detected. Using CPU mode."
    fi
  else
    GPU_TYPE="cpu"
    warn "No NVIDIA GPU detected. Using CPU mode (slow, recommended: 7B models max)."
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Package helpers
# ─────────────────────────────────────────────────────────────────────────────
pkg_installed() { command -v "$1" &>/dev/null; }

install_pkg() {
  local cmd=$1 pkg=${2:-$1}
  pkg_installed "$cmd" && { ok "$cmd already installed"; return 0; }
  printf "   ${CYN}⋯${R}  Installing ${B}%s${R}…\n" "$pkg"
  case "$OS" in
    debian) $SUDO apt-get install -y -qq "$pkg" &>/dev/null & ;;
    arch)   $SUDO pacman -S --noconfirm --needed "$pkg" &>/dev/null & ;;
    fedora) $SUDO dnf install -y -q "$pkg" &>/dev/null & ;;
    macos)  brew install "$pkg" &>/dev/null & ;;
  esac
  spin $! "Installing $cmd"
}

# ─────────────────────────────────────────────────────────────────────────────
# Docker
# ─────────────────────────────────────────────────────────────────────────────
install_docker() {
  if pkg_installed docker && docker info &>/dev/null 2>&1; then
    ok "Docker is running"
    return
  fi

  section "Installing Docker"

  case "$OS" in
    debian)
      $SUDO apt-get install -y -qq ca-certificates curl gnupg &>/dev/null
      $SUDO install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" \
        | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
      $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
      printf "deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n" \
        "$(dpkg --print-architecture)" "$(. /etc/os-release && echo "$ID")" "$(. /etc/os-release && echo "$VERSION_CODENAME")" \
        | $SUDO tee /etc/apt/sources.list.d/docker.list &>/dev/null
      $SUDO apt-get update -qq &>/dev/null &
      spin $! "Updating package lists"
      $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin &>/dev/null &
      spin $! "Installing Docker Engine"
      ;;
    arch)
      $SUDO pacman -S --noconfirm --needed docker docker-compose &>/dev/null &
      spin $! "Installing Docker"
      ;;
    fedora)
      $SUDO dnf install -y -q dnf-plugins-core &>/dev/null
      $SUDO dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo &>/dev/null
      $SUDO dnf install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin &>/dev/null &
      spin $! "Installing Docker"
      ;;
    macos)
      if ! command -v brew &>/dev/null; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" &>/dev/null &
        spin $! "Installing Homebrew"
      fi
      brew install --cask docker &>/dev/null &
      spin $! "Installing Docker Desktop"
      printf "\n ${YLW}⚠${R}  Docker Desktop installed. Please:\n"
      printf "      1. Open Docker Desktop from your Applications folder\n"
      printf "      2. Wait for it to start (whale icon in menubar)\n"
      printf "      3. Run this script again\n\n"
      open -a Docker 2>/dev/null || true
      exit 0
      ;;
  esac

  if [[ "$OS" != "macos" ]]; then
    $SUDO systemctl enable --now docker &>/dev/null || true
    if [[ $EUID -ne 0 ]]; then
      $SUDO usermod -aG docker "$USER" 2>/dev/null || true
      # Activate group without re-login
      if ! docker info &>/dev/null 2>&1; then
        $SUDO chmod 666 /var/run/docker.sock 2>/dev/null || true
      fi
    fi
  fi

  docker info &>/dev/null 2>&1 || die "Docker installed but not accessible. Try: sudo chmod 666 /var/run/docker.sock"
  ok "Docker ready"
}

# ─────────────────────────────────────────────────────────────────────────────
# NVIDIA Container Toolkit
# ─────────────────────────────────────────────────────────────────────────────
install_nvidia_toolkit() {
  [[ "$GPU_TYPE" != "nvidia" ]] && return

  # Quick check: can Docker see the GPU?
  if docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 \
       nvidia-smi --query-gpu=name --format=csv,noheader &>/dev/null 2>&1; then
    ok "NVIDIA Container Toolkit already working"
    return
  fi

  section "Installing NVIDIA Container Toolkit"
  case "$OS" in
    debian)
      curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | $SUDO gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null
      curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        | $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list &>/dev/null
      $SUDO apt-get update -qq &>/dev/null
      $SUDO apt-get install -y -qq nvidia-container-toolkit &>/dev/null &
      spin $! "Installing NVIDIA Container Toolkit"
      ;;
    arch)
      $SUDO pacman -S --noconfirm --needed nvidia-container-toolkit &>/dev/null &
      spin $! "Installing NVIDIA Container Toolkit"
      ;;
    fedora)
      curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
        | $SUDO tee /etc/yum.repos.d/nvidia-container-toolkit.repo &>/dev/null
      $SUDO dnf install -y -q nvidia-container-toolkit &>/dev/null &
      spin $! "Installing NVIDIA Container Toolkit"
      ;;
    macos) return ;;
  esac

  $SUDO nvidia-ctk runtime configure --runtime=docker &>/dev/null || true
  $SUDO systemctl restart docker &>/dev/null || true
  ok "NVIDIA Container Toolkit installed"
}

# ─────────────────────────────────────────────────────────────────────────────
# cloudflared
# ─────────────────────────────────────────────────────────────────────────────
install_cloudflared() {
  pkg_installed cloudflared && { ok "cloudflared already installed"; return; }

  section "Installing Cloudflare Tunnel client (no account needed)"
  local base_url="https://github.com/cloudflare/cloudflared/releases/latest/download"

  case "$OS" in
    debian)
      local pkg_name="cloudflared-linux-amd64.deb"
      [[ "$ARCH" == "arm64" ]] && pkg_name="cloudflared-linux-arm64.deb"
      curl -fsSL "$base_url/$pkg_name" -o /tmp/cloudflared.deb &>/dev/null &
      spin $! "Downloading cloudflared"
      $SUDO dpkg -i /tmp/cloudflared.deb &>/dev/null \
        && ok "cloudflared installed" \
        || warn "cloudflared install failed — tunnel will be skipped"
      ;;
    arch)
      if command -v yay &>/dev/null; then
        yay -S --noconfirm cloudflared &>/dev/null &
        spin $! "Installing cloudflared"
      else
        _install_cloudflared_bin
      fi
      ;;
    fedora)
      local pkg_name="cloudflared-linux-x86_64.rpm"
      [[ "$ARCH" == "arm64" ]] && pkg_name="cloudflared-linux-aarch64.rpm"
      curl -fsSL "$base_url/$pkg_name" -o /tmp/cloudflared.rpm &>/dev/null &
      spin $! "Downloading cloudflared"
      $SUDO rpm -i /tmp/cloudflared.rpm &>/dev/null \
        && ok "cloudflared installed" \
        || warn "cloudflared install failed — tunnel will be skipped"
      ;;
    macos)
      brew install cloudflare/cloudflare/cloudflared &>/dev/null &
      spin $! "Installing cloudflared"
      ;;
  esac
}

_install_cloudflared_bin() {
  local bin="cloudflared-linux-amd64"
  [[ "$ARCH" == "arm64" ]] && bin="cloudflared-linux-arm64"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/$bin" \
    -o /tmp/cloudflared &>/dev/null &
  spin $! "Downloading cloudflared binary"
  $SUDO install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
  ok "cloudflared installed"
}

# ─────────────────────────────────────────────────────────────────────────────
# Full dependency installation
# ─────────────────────────────────────────────────────────────────────────────
install_all_deps() {
  section "Installing system dependencies"

  case "$OS" in
    debian)
      $SUDO apt-get update -qq &>/dev/null &
      spin $! "Updating package lists"
      for p in curl wget git jq; do install_pkg "$p"; done
      ;;
    arch)
      $SUDO pacman -Syu --noconfirm --needed &>/dev/null &
      spin $! "Syncing packages"
      for p in curl wget git jq; do install_pkg "$p"; done
      ;;
    fedora)
      $SUDO dnf makecache -q &>/dev/null &
      spin $! "Updating package cache"
      for p in curl wget git jq; do install_pkg "$p"; done
      ;;
    macos)
      if ! command -v brew &>/dev/null; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" &>/dev/null &
        spin $! "Installing Homebrew"
      fi
      for p in curl wget git jq; do install_pkg "$p"; done
      ;;
  esac

  install_docker
  install_nvidia_toolkit
  install_cloudflared

  ok "All dependencies ready"
}

# ─────────────────────────────────────────────────────────────────────────────
# Start Inference Studio via docker compose
# ─────────────────────────────────────────────────────────────────────────────
start_studio() {
  section "Starting Inference Studio"

  cd "$SCRIPT_DIR"
  mkdir -p data

  if [[ ! -f .env ]]; then
    cp .env.example .env
    log "Created .env from .env.example (edit it to change credentials)"
  fi

  # Kill any orphan containers on our ports
  for port in $WEB_PORT $API_PORT; do
    local cid
    cid=$(docker ps -q --filter "publish=$port" 2>/dev/null || true)
    [[ -n "$cid" ]] && docker stop "$cid" &>/dev/null || true
  done

  printf "   ${CYN}⋯${R}  Building containers (first run may take several minutes)…\n"
  docker compose build --pull 2>&1 | grep -v "^#" | tail -3 &
  spin $! "Building Docker images"

  docker compose up -d 2>/dev/null &
  spin $! "Starting services"

  # Wait for API
  local deadline=$(( $(date +%s) + 120 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    curl -sf "http://localhost:$API_PORT/health" &>/dev/null && break
    sleep 2
  done
  curl -sf "http://localhost:$API_PORT/health" &>/dev/null \
    && ok "API ready at http://localhost:$API_PORT" \
    || warn "API health check timed out — run: docker compose logs api"

  # Wait for web
  deadline=$(( $(date +%s) + 120 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    curl -sf "http://localhost:$WEB_PORT" &>/dev/null && break
    sleep 2
  done
  curl -sf "http://localhost:$WEB_PORT" &>/dev/null \
    && ok "Web UI ready at http://localhost:$WEB_PORT" \
    || warn "Web UI health check timed out — run: docker compose logs web"
}

# ─────────────────────────────────────────────────────────────────────────────
# Cloudflare Quick Tunnel
# ─────────────────────────────────────────────────────────────────────────────
TUNNEL_PID=""
TUNNEL_URL=""

start_tunnel() {
  if ! command -v cloudflared &>/dev/null; then
    warn "cloudflared not found — skipping tunnel. Your instance is only accessible locally."
    return
  fi

  section "Starting Cloudflare Quick Tunnel"
  log "No Cloudflare account required — using trycloudflare.com"

  local tmplog
  tmplog=$(mktemp)

  cloudflared tunnel --url "http://localhost:$WEB_PORT" --no-autoupdate \
    >"$tmplog" 2>&1 &
  TUNNEL_PID=$!

  # Extract tunnel URL from cloudflared output (up to 30s)
  local elapsed=0
  while [[ $elapsed -lt 30 ]]; do
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$tmplog" 2>/dev/null | head -1 || true)
    [[ -n "$TUNNEL_URL" ]] && break
    sleep 1; ((elapsed++)) || true
  done
  rm -f "$tmplog"

  if [[ -n "$TUNNEL_URL" ]]; then
    ok "Tunnel: ${B}${LIME}$TUNNEL_URL${R}"

    # Register with the API so the dashboard shows it
    local admin_token
    admin_token=$(get_admin_token 2>/dev/null || echo "")
    if [[ -n "$admin_token" ]]; then
      curl -sf -X POST "http://localhost:$API_PORT/setup/tunnel" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $admin_token" \
        -d "{\"url\": \"$TUNNEL_URL\"}" &>/dev/null || true
    fi
  else
    warn "Could not obtain tunnel URL. Remote access unavailable this session."
  fi
}

get_admin_token() {
  local user="${ADMIN_USERNAME:-admin}"
  local pass="${ADMIN_PASSWORD:-password}"
  # Override from .env if present
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    local u p
    u=$(grep '^ADMIN_USERNAME=' "$SCRIPT_DIR/.env" | cut -d= -f2 | tr -d '"' || true)
    p=$(grep '^ADMIN_PASSWORD=' "$SCRIPT_DIR/.env" | cut -d= -f2 | tr -d '"' || true)
    [[ -n "$u" ]] && user="$u"
    [[ -n "$p" ]] && pass="$p"
  fi

  curl -sf -X POST "http://localhost:$API_PORT/admin/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\": \"$user\", \"password\": \"$pass\"}" 2>/dev/null \
    | grep -oP '"token"\s*:\s*"\K[^"]+' || echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
# Open browser
# ─────────────────────────────────────────────────────────────────────────────
open_browser() {
  local url="http://localhost:$WEB_PORT"
  case "$OS" in
    macos) open "$url" 2>/dev/null || true ;;
    *)     xdg-open "$url" 2>/dev/null || \
           sensible-browser "$url" 2>/dev/null || \
           x-www-browser "$url" 2>/dev/null || true ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Print summary
# ─────────────────────────────────────────────────────────────────────────────
print_summary() {
  printf "\n"
  hr
  printf "\n"
  printf "  ${B}${LIME}Inference Studio is running!${R}\n\n"
  printf "  ${B}Web UI${R}   →  ${CYN}http://localhost:$WEB_PORT${R}\n"
  printf "  ${B}API${R}      →  ${CYN}http://localhost:$API_PORT${R}\n"
  printf "  ${B}Admin${R}    →  ${CYN}http://localhost:$WEB_PORT/admin${R}\n"
  [[ -n "$TUNNEL_URL" ]] && printf "  ${B}Public${R}   →  ${LIME}$TUNNEL_URL${R}\n"
  printf "\n"
  printf "  ${GRY}Admin credentials: admin / password  (change at /admin → Settings)${R}\n"
  printf "  ${GRY}GPU: $GPU_NAME${R}\n"
  printf "\n"
  hr
  printf "\n"
  printf "  ${GRY}Open the browser, select a model, and you're ready to go.${R}\n"
  printf "  ${GRY}Generate an API key at ${B}/admin${R}${GRY} → Keys.${R}\n"
  printf "\n  ${GRY}Press ${B}Ctrl+C${R}${GRY} to stop all services.${R}\n\n"
}

# ─────────────────────────────────────────────────────────────────────────────
# Cleanup on exit
# ─────────────────────────────────────────────────────────────────────────────
cleanup() {
  printf "\n${GRY}Shutting down Inference Studio…${R}\n"
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  [[ -n "$SUDO_KEEP_ALIVE" ]] && kill "$SUDO_KEEP_ALIVE" 2>/dev/null || true
  cd "$SCRIPT_DIR"
  docker compose stop &>/dev/null || true
  printf "${GRN}Done.${R}\n"
}
trap cleanup EXIT INT TERM

# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────
main() {
  print_banner
  detect_os
  ensure_sudo
  detect_gpu
  install_all_deps
  start_studio
  start_tunnel
  open_browser
  print_summary

  # Keep running so the tunnel (and trap) stay alive
  if [[ -n "$TUNNEL_PID" ]]; then
    wait "$TUNNEL_PID" 2>/dev/null || true
  else
    # No tunnel — just wait indefinitely for Ctrl+C
    while true; do sleep 30; done
  fi
}

main "$@"
