#!/usr/bin/env bash
#
# InfiniBot installer (macOS / Linux / WSL)
#
#   curl -fsSL https://infinibotos.com/install.sh | bash
#
# What it does:
#   1. Makes sure Node.js >= 22.12 and git are available (installs them if missing;
#      npm needs git for one WhatsApp dependency that is fetched from GitHub).
#   2. npm install -g infinibot   (the published npm package; no git clone, no build)
#   3. Launches the setup wizard: infinibot onboard --install-daemon
#
# It never touches ~/.infinibot (your config, sessions and keys).
#
# Options (after `bash -s --`) and matching env vars:
#   --no-onboard          INFINIBOT_NO_ONBOARD=1     install only, skip the wizard
#   --version <x.y.z>     INFINIBOT_VERSION=x.y.z    install a specific version or dist-tag (default: latest)
#   --dry-run             INFINIBOT_DRY_RUN=1        print what would run, change nothing
#   -h, --help
#
# Advanced:
#   INFINIBOT_NPM_SPEC    full npm spec to install instead of infinibot@<version>
#                         (a tarball path or URL; used by the release smoke tests)
#

set -euo pipefail

PACKAGE="infinibot"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=12
VERSION="${INFINIBOT_VERSION:-latest}"
NO_ONBOARD="${INFINIBOT_NO_ONBOARD:-0}"
DRY_RUN="${INFINIBOT_DRY_RUN:-0}"
DOCS_URL="https://infinibotos.com/docs/install"

if [[ -t 1 ]]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
    BLUE=$'\033[0;34m'; GOLD=$'\033[0;33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
    RED=""; GREEN=""; YELLOW=""; BLUE=""; GOLD=""; BOLD=""; NC=""
fi

log_info()    { echo "${BLUE}[info]${NC} $1"; }
log_success() { echo "${GREEN}[ ok ]${NC} $1"; }
log_warn()    { echo "${YELLOW}[warn]${NC} $1"; }
log_error()   { echo "${RED}[fail]${NC} $1" >&2; }
log_step()    { echo ""; echo "${GOLD}==>${NC} ${BOLD}$1${NC}"; }

usage() {
    sed -n '3,23p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//' || true
    echo "Docs: $DOCS_URL"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-onboard) NO_ONBOARD=1 ;;
        --version)
            [[ $# -ge 2 ]] || { log_error "--version needs a value"; exit 2; }
            VERSION="$2"; shift ;;
        --version=*) VERSION="${1#*=}" ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) usage; exit 0 ;;
        *) log_error "Unknown option: $1"; usage; exit 2 ;;
    esac
    shift
done

NPM_SPEC="${INFINIBOT_NPM_SPEC:-${PACKAGE}@${VERSION}}"

command_exists() { command -v "$1" >/dev/null 2>&1; }

run() {
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "  [dry-run] $*"
    else
        "$@"
    fi
}

as_root() {
    if [[ "$(id -u)" == "0" ]]; then
        run "$@"
    elif command_exists sudo; then
        run sudo "$@"
    else
        log_error "Need root to run: $* (install sudo, or run this installer as root)"
        exit 1
    fi
}

get_os() {
    case "$(uname -s)" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "macos" ;;
        *)       echo "unknown" ;;
    esac
}

get_distro() {
    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        (. /etc/os-release && echo "${ID:-unknown} ${ID_LIKE:-}")
    else
        echo "unknown"
    fi
}

# True when the node on PATH satisfies engines (>= 22.12).
node_ok() {
    command_exists node || return 1
    local v major minor
    v="$(node -v 2>/dev/null | sed 's/^v//')"
    major="${v%%.*}"
    minor="$(echo "$v" | cut -d. -f2)"
    [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
    if (( major > NODE_MIN_MAJOR )); then return 0; fi
    (( major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR ))
}

install_node_nvm() {
    log_info "Installing Node.js $NODE_MIN_MAJOR with nvm (no root needed)..."
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "  [dry-run] install nvm, then: nvm install $NODE_MIN_MAJOR"
        return 0
    fi
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    set +u
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install "$NODE_MIN_MAJOR"
    nvm use "$NODE_MIN_MAJOR"
    set -u
}

install_node() {
    log_step "Node.js"

    if node_ok; then
        log_success "Node.js $(node -v) found (need >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR)"
        return 0
    fi
    if command_exists node; then
        log_warn "Node.js $(node -v) is too old (need >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR)"
    else
        log_info "Node.js not found"
    fi

    local os distro
    os="$(get_os)"
    if [[ "$os" == "macos" ]]; then
        if command_exists brew; then
            log_info "Installing Node.js $NODE_MIN_MAJOR with Homebrew..."
            run brew install "node@$NODE_MIN_MAJOR"
            run brew link "node@$NODE_MIN_MAJOR" --force --overwrite || true
        else
            install_node_nvm
        fi
    else
        distro="$(get_distro)"
        case " $distro " in
            *" ubuntu "*|*" debian "*)
                log_info "Installing Node.js $NODE_MIN_MAJOR from NodeSource (apt)..."
                if [[ "$DRY_RUN" == "1" ]]; then
                    echo "  [dry-run] curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo -E bash - && sudo apt-get install -y nodejs"
                elif [[ "$(id -u)" == "0" ]]; then
                    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | bash -
                    apt-get install -y nodejs
                elif command_exists sudo; then
                    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | sudo -E bash -
                    sudo apt-get install -y nodejs
                else
                    install_node_nvm
                fi
                ;;
            *" fedora "*|*" rhel "*|*" centos "*)
                log_info "Installing Node.js $NODE_MIN_MAJOR from NodeSource (rpm)..."
                if [[ "$DRY_RUN" == "1" ]]; then
                    echo "  [dry-run] curl -fsSL https://rpm.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo bash - && sudo dnf install -y nodejs"
                elif [[ "$(id -u)" == "0" ]] || command_exists sudo; then
                    local sudo_cmd=""
                    [[ "$(id -u)" == "0" ]] || sudo_cmd="sudo"
                    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | $sudo_cmd bash -
                    $sudo_cmd dnf install -y nodejs || $sudo_cmd yum install -y nodejs
                else
                    install_node_nvm
                fi
                ;;
            *" arch "*)
                as_root pacman -Sy --noconfirm nodejs npm
                ;;
            *)
                install_node_nvm
                ;;
        esac
    fi

    [[ "$DRY_RUN" == "1" ]] && return 0
    hash -r 2>/dev/null || true
    if node_ok; then
        log_success "Node.js $(node -v) installed"
    else
        log_error "Could not install Node.js >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR automatically."
        log_error "Install it from https://nodejs.org and re-run this installer."
        exit 1
    fi
}

# npm shells out to git for a git-hosted transitive dependency (libsignal, via
# the WhatsApp library), so `npm install -g infinibot` fails without it.
install_git() {
    if command_exists git; then
        return 0
    fi
    log_info "git not found (npm needs it to fetch one dependency); installing..."

    if [[ "$(get_os)" == "macos" ]]; then
        if command_exists brew; then
            run brew install git
        else
            log_error "git is required. Run 'xcode-select --install', then re-run this installer."
            exit 1
        fi
    else
        local distro
        distro="$(get_distro)"
        case " $distro " in
            *" ubuntu "*|*" debian "*)
                as_root apt-get update -qq
                as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git
                ;;
            *" fedora "*|*" rhel "*|*" centos "*)
                as_root dnf install -y git || as_root yum install -y git
                ;;
            *" arch "*)
                as_root pacman -Sy --noconfirm git
                ;;
            *" alpine "*)
                as_root apk add --no-cache git
                ;;
            *" suse "*|*" opensuse "*)
                as_root zypper --non-interactive install git
                ;;
            *)
                log_error "git is required. Install it with your package manager and re-run this installer."
                exit 1
                ;;
        esac
    fi

    [[ "$DRY_RUN" == "1" ]] && return 0
    hash -r 2>/dev/null || true
    if command_exists git; then
        log_success "git installed"
    else
        log_error "Could not install git automatically. Install it and re-run this installer."
        exit 1
    fi
}

# Global installs must not need sudo: if the npm prefix is not writable by the
# current user, switch to a per-user prefix and put it on PATH.
ensure_user_npm_prefix() {
    local prefix
    prefix="$(npm config get prefix 2>/dev/null || true)"
    if [[ -n "$prefix" && -w "$prefix" ]] && { [[ ! -e "$prefix/lib/node_modules" ]] || [[ -w "$prefix/lib/node_modules" ]]; }; then
        return 0
    fi
    if [[ -n "$prefix" && ! -e "$prefix" ]] && mkdir -p "$prefix" 2>/dev/null; then
        return 0
    fi

    local user_prefix="$HOME/.npm-global"
    log_info "npm prefix '$prefix' is not writable; using $user_prefix instead"
    run mkdir -p "$user_prefix"
    run npm config set prefix "$user_prefix"
    export PATH="$user_prefix/bin:$PATH"

    [[ "$DRY_RUN" == "1" ]] && return 0
    local rc line='export PATH="$HOME/.npm-global/bin:$PATH"'
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
        if [[ -f "$rc" ]] && ! grep -q '.npm-global/bin' "$rc"; then
            printf '\n# Added by the InfiniBot installer\n%s\n' "$line" >> "$rc"
            log_info "Added $user_prefix/bin to PATH in $rc"
        fi
    done
}

install_infinibot() {
    log_step "InfiniBot"

    if ! command_exists npm; then
        if [[ "$DRY_RUN" == "1" ]]; then
            echo "  [dry-run] npm install -g $NPM_SPEC"
            return 0
        fi
        log_error "npm not found even though Node.js is installed. Install npm and re-run."
        exit 1
    fi

    install_git
    ensure_user_npm_prefix

    log_info "npm install -g $NPM_SPEC"
    SHARP_IGNORE_GLOBAL_LIBVIPS=1 run npm install -g "$NPM_SPEC" --no-fund --no-audit

    [[ "$DRY_RUN" == "1" ]] && return 0
    hash -r 2>/dev/null || true
    INFINIBOT_BIN="$(command -v infinibot || true)"
    if [[ -z "$INFINIBOT_BIN" ]]; then
        INFINIBOT_BIN="$(npm config get prefix)/bin/infinibot"
        if [[ ! -x "$INFINIBOT_BIN" ]]; then
            log_error "Installed, but the 'infinibot' command was not found."
            log_error "Add \"$(npm config get prefix)/bin\" to your PATH and run: infinibot onboard"
            exit 1
        fi
        PATH_HINT=1
    fi
    log_success "InfiniBot $("$INFINIBOT_BIN" --version 2>/dev/null | tail -n 1) installed ($INFINIBOT_BIN)"
}

run_onboarding() {
    log_step "Setup"

    if [[ "$NO_ONBOARD" == "1" ]]; then
        log_info "Skipping the setup wizard (--no-onboard). Run it later with: infinibot onboard"
        return 0
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "  [dry-run] infinibot onboard --install-daemon"
        return 0
    fi

    # Under `curl … | bash` stdin is the script itself, so the wizard reads
    # the keyboard from the controlling terminal instead.
    if [[ -t 0 ]]; then
        "$INFINIBOT_BIN" onboard --install-daemon
    elif { : </dev/tty; } 2>/dev/null; then
        "$INFINIBOT_BIN" onboard --install-daemon </dev/tty
    else
        log_warn "No terminal available, so the setup wizard was skipped."
        log_info "Finish setup with: infinibot onboard --install-daemon"
        log_info "Or unattended:     infinibot onboard --non-interactive --accept-risk (see $DOCS_URL)"
    fi
}

print_done() {
    echo ""
    echo "${GREEN}${BOLD}InfiniBot is installed.${NC}"
    echo ""
    echo "  ${BLUE}infinibot onboard${NC}     set up (or re-run) the wizard in this terminal"
    echo "  ${BLUE}infinibot quickstart${NC}  same setup, in your browser"
    echo "  ${BLUE}infinibot gateway${NC}     start the gateway  ->  http://127.0.0.1:18789"
    echo "  ${BLUE}infinibot doctor${NC}      diagnose problems"
    echo ""
    if [[ "${PATH_HINT:-0}" == "1" ]]; then
        echo "${YELLOW}Open a new terminal (or add \"$(npm config get prefix)/bin\" to PATH) to use the 'infinibot' command.${NC}"
        echo ""
    fi
    echo "Docs: $DOCS_URL"
}

main() {
    echo ""
    echo "${GOLD}${BOLD}InfiniBot installer${NC}"

    if [[ "$(get_os)" == "unknown" ]]; then
        log_error "Unsupported OS: $(uname -s). On Windows use PowerShell:"
        log_error "  iwr -useb https://infinibotos.com/install.ps1 | iex"
        exit 1
    fi

    install_node
    install_infinibot
    run_onboarding
    [[ "$DRY_RUN" == "1" ]] && { echo ""; log_info "Dry run complete; nothing was changed."; exit 0; }
    print_done
}

main
