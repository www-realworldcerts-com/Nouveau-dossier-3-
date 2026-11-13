#!/usr/bin/env bash
# =============================================================================
# JARVIS AI Agent System - Installation Script
# =============================================================================
# This script:
#   1. Detects the operating system
#   2. Installs system dependencies
#   3. Sets up Python virtual environment
#   4. Installs Node.js/bun
#   5. Initializes the database
#   6. Configures the environment
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
AGENT_DIR="${PROJECT_DIR}/python-agent"
WEB_DIR="${PROJECT_DIR}/../jarvis"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------------------------
log_info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()    { echo -e "${CYAN}[STEP]${NC} $1"; }
log_section() { echo -e "\n${BLUE}══════════════════════════════════════════════════════${NC}\n${BLUE}  $1${NC}\n${BLUE}══════════════════════════════════════════════════════${NC}"; }

command_exists() {
    command -v "$1" &> /dev/null
}

confirm_action() {
    local prompt="$1"
    local default="${2:-n}"

    if [ "${JARVIS_AUTO_YES:-}" = "1" ]; then
        return 0
    fi

    local suffix
    if [ "${default}" = "y" ]; then
        suffix="[Y/n]"
    else
        suffix="[y/N]"
    fi

    echo -ne "${YELLOW}${prompt} ${suffix}: ${NC}"
    read -r response

    response="${response:-${default}}"
    case "${response}" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

# ---------------------------------------------------------------------------
# OS Detection
# ---------------------------------------------------------------------------
detect_os() {
    log_step "Detecting operating system..."

    if [ -f /etc/os-release ]; then
        # shellcheck source=/dev/null
        source /etc/os-release
        OS_ID="${ID:-unknown}"
        OS_VERSION="${VERSION_ID:-unknown}"
        OS_NAME="${NAME:-Unknown}"
    elif [ -f /etc/redhat-release ]; then
        OS_ID="rhel"
        OS_VERSION=$(cut -d' ' -f3 < /etc/redhat-release)
        OS_NAME=$(cat /etc/redhat-release)
    elif command_exists sw_vers; then
        OS_ID="macos"
        OS_VERSION=$(sw_vers -productVersion)
        OS_NAME="macOS ${OS_VERSION}"
    else
        OS_ID="unknown"
        OS_VERSION="unknown"
        OS_NAME="Unknown"
    fi

    log_info "Detected OS: ${OS_NAME} (${OS_ID} ${OS_VERSION})"
}

# ---------------------------------------------------------------------------
# System Dependencies Installation
# ---------------------------------------------------------------------------
install_system_deps_ubuntu() {
    log_info "Installing system dependencies for Ubuntu/Debian..."

    sudo apt-get update

    sudo apt-get install -y \
        build-essential \
        portaudio19-dev \
        libasound2-dev \
        libsndfile1-dev \
        libffi-dev \
        libssl-dev \
        libpq-dev \
        python3-dev \
        python3-pip \
        python3-venv \
        curl \
        wget \
        git \
        redis-server \
        sox \
        ffmpeg \
        pkg-config \
        cmake

    sudo apt-get clean
}

install_system_deps_fedora() {
    log_info "Installing system dependencies for Fedora/RHEL..."

    sudo dnf groupinstall -y "Development Tools"

    sudo dnf install -y \
        portaudio-devel \
        alsa-lib-devel \
        libsndfile-devel \
        libffi-devel \
        openssl-devel \
        postgresql-devel \
        python3-devel \
        python3-pip \
        curl \
        wget \
        git \
        redis \
        sox \
        ffmpeg \
        pkgconfig \
        cmake

    sudo dnf clean all
}

install_system_deps_macos() {
    log_info "Installing system dependencies for macOS..."

    if ! command_exists brew; then
        log_warn "Homebrew not found. Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi

    brew update

    brew install \
        portaudio \
        libsndfile \
        ffmpeg \
        sox \
        redis \
        cmake \
        pkg-config \
        python@3.11

    brew link python@3.11 2>/dev/null || true
}

install_system_deps_arch() {
    log_info "Installing system dependencies for Arch Linux..."

    sudo pacman -Syu --noconfirm

    sudo pacman -S --noconfirm \
        base-devel \
        portaudio \
        alsa-lib \
        libsndfile \
        libffi \
        openssl \
        python \
        python-pip \
        curl \
        wget \
        git \
        redis \
        sox \
        ffmpeg \
        pkg-config \
        cmake
}

install_system_deps() {
    log_section "Installing System Dependencies"

    case "${OS_ID}" in
        ubuntu|debian|linuxmint|pop)
            install_system_deps_ubuntu
            ;;
        fedora|rhel|centos|rocky|alma)
            install_system_deps_fedora
            ;;
        macos)
            install_system_deps_macos
            ;;
        arch|manjaro|endeavouros)
            install_system_deps_arch
            ;;
        *)
            log_error "Unsupported OS: ${OS_ID}. Please install dependencies manually."
            log_error "Required packages: build-essential, portaudio19-dev, python3-dev, python3-pip, python3-venv, curl, git, redis"
            exit 1
            ;;
    esac

    log_info "System dependencies installed successfully"
}

# ---------------------------------------------------------------------------
# Python Setup
# ---------------------------------------------------------------------------
setup_python() {
    log_section "Setting Up Python Environment"

    # Determine Python command
    local python_cmd=""
    if command_exists python3.11; then
        python_cmd="python3.11"
    elif command_exists python3.12; then
        python_cmd="python3.12"
    elif command_exists python3; then
        python_cmd="python3"
    elif command_exists python; then
        python_cmd="python"
    else
        log_error "Python 3 not found. Please install Python 3.11+ first."
        exit 1
    fi

    local python_version
    python_version=$(${python_cmd} -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    log_info "Using Python ${python_version} (${python_cmd})"

    # Create virtual environment
    if [ ! -d "${AGENT_DIR}/venv" ]; then
        log_step "Creating Python virtual environment..."
        ${python_cmd} -m venv "${AGENT_DIR}/venv"
        log_info "Virtual environment created at ${AGENT_DIR}/venv"
    else
        log_info "Virtual environment already exists"
    fi

    # Activate virtual environment
    # shellcheck source=/dev/null
    source "${AGENT_DIR}/venv/bin/activate"

    # Upgrade pip
    log_step "Upgrading pip..."
    pip install --upgrade pip setuptools wheel

    # Install Python dependencies
    if [ -f "${AGENT_DIR}/requirements.txt" ]; then
        log_step "Installing Python dependencies..."
        pip install -r "${AGENT_DIR}/requirements.txt"
        log_info "Python dependencies installed"
    else
        log_warn "No requirements.txt found at ${AGENT_DIR}/requirements.txt"
        log_info "Installing common dependencies..."

        pip install \
            fastapi \
            uvicorn \
            uvloop \
            httptools \
            pydantic \
            python-dotenv \
            pyyaml \
            openai \
            SpeechRecognition \
            pyttsx3 \
            pyaudio \
            cryptography \
            PyJWT \
            bcrypt \
            websockets \
            aiohttp \
            redis \
            prisma
    fi

    # Install the JARVIS agent package
    if [ -f "${AGENT_DIR}/setup.py" ] || [ -f "${AGENT_DIR}/pyproject.toml" ]; then
        log_step "Installing JARVIS agent package..."
        cd "${AGENT_DIR}"
        pip install -e . 2>/dev/null || true
        cd "${PROJECT_DIR}"
    fi

    # Deactivate
    deactivate 2>/dev/null || true

    log_info "Python environment setup complete"
}

# ---------------------------------------------------------------------------
# Node.js / Bun Setup
# ---------------------------------------------------------------------------
setup_node() {
    log_section "Setting Up Node.js / Bun"

    # Check for bun first (preferred)
    if command_exists bun; then
        log_info "Bun is already installed: $(bun --version)"
    elif command_exists npm; then
        log_info "npm is already installed: $(npm --version)"
    else
        # Install Node.js
        if ! command_exists node; then
            log_step "Installing Node.js..."
            if [ "${OS_ID}" = "macos" ]; then
                brew install node@20
            else
                # Use NodeSource
                curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null || true
                sudo apt-get install -y nodejs 2>/dev/null || true
            fi
        fi

        # Verify Node.js
        if command_exists node; then
            log_info "Node.js installed: $(node --version)"
        else
            log_error "Failed to install Node.js. Please install it manually."
            exit 1
        fi
    fi

    # Install web dependencies
    if [ -d "${WEB_DIR}" ]; then
        log_step "Installing web application dependencies..."
        cd "${WEB_DIR}"

        if command_exists bun; then
            bun install
        else
            npm install
        fi

        cd "${PROJECT_DIR}"
        log_info "Web dependencies installed"
    else
        log_warn "Web directory not found at ${WEB_DIR}"
    fi
}

# ---------------------------------------------------------------------------
# Database Initialization
# ---------------------------------------------------------------------------
init_database() {
    log_section "Initializing Database"

    # Set up Prisma for the web application
    if [ -d "${WEB_DIR}" ] && [ -f "${WEB_DIR}/prisma/schema.prisma" ]; then
        log_step "Pushing Prisma schema to database..."
        cd "${WEB_DIR}"

        if command_exists bun; then
            bun run db:generate 2>/dev/null || true
            bun run db:push 2>/dev/null || true
        else
            npx prisma generate 2>/dev/null || true
            npx prisma db push 2>/dev/null || true
        fi

        cd "${PROJECT_DIR}"
        log_info "Database schema initialized"
    else
        log_warn "No Prisma schema found. Skipping database initialization."
    fi

    # Create SQLite database for the agent if needed
    local db_path="${PROJECT_DIR}/data/jarvis.db"
    if [ ! -f "${db_path}" ]; then
        mkdir -p "$(dirname "${db_path}")"
        log_info "Database will be created on first run"
    fi
}

# ---------------------------------------------------------------------------
# Environment Configuration
# ---------------------------------------------------------------------------
configure_environment() {
    log_section "Configuring Environment"

    # Create .env file from example
    if [ ! -f "${PROJECT_DIR}/.env" ]; then
        if [ -f "${PROJECT_DIR}/.env.example" ]; then
            cp "${PROJECT_DIR}/.env.example" "${PROJECT_DIR}/.env"
            log_info "Created .env from .env.example"
            log_warn "IMPORTANT: Review and update .env with your actual configuration!"
            log_warn "Key variables to update: JWT_SECRET, ENCRYPTION_KEY, API keys"
        else
            log_error "No .env.example found. Please create .env manually."
            exit 1
        fi
    else
        log_info ".env file already exists"
    fi

    # Generate secure JWT secret if placeholder
    if grep -q "change_this" "${PROJECT_DIR}/.env" 2>/dev/null; then
        log_step "Generating secure secrets..."

        local jwt_secret
        jwt_secret=$(python3 -c "import secrets; print(secrets.token_urlsafe(64))" 2>/dev/null || openssl rand -base64 64 | head -c 64)

        local encryption_key
        encryption_key=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null || openssl rand -base64 32 | head -c 32)

        # Replace placeholders on Linux
        if [[ "$(uname)" == "Linux" ]]; then
            sed -i "s|JWT_SECRET=change_this.*|JWT_SECRET=${jwt_secret}|" "${PROJECT_DIR}/.env"
            sed -i "s|ENCRYPTION_KEY=change_this.*|ENCRYPTION_KEY=${encryption_key}|" "${PROJECT_DIR}/.env"
        elif [[ "$(uname)" == "Darwin" ]]; then
            sed -i '' "s|JWT_SECRET=change_this.*|JWT_SECRET=${jwt_secret}|" "${PROJECT_DIR}/.env"
            sed -i '' "s|ENCRYPTION_KEY=change_this.*|ENCRYPTION_KEY=${encryption_key}|" "${PROJECT_DIR}/.env"
        fi

        log_info "Generated secure JWT_SECRET and ENCRYPTION_KEY"
    fi

    # Create necessary directories
    mkdir -p "${PROJECT_DIR}/data"
    mkdir -p "${PROJECT_DIR}/logs"
    mkdir -p "${PROJECT_DIR}/uploads"
    mkdir -p "${PROJECT_DIR}/cache"
    mkdir -p "${PROJECT_DIR}/config"

    log_info "Environment configured"
}

# ---------------------------------------------------------------------------
# Post-Install Verification
# ---------------------------------------------------------------------------
verify_installation() {
    log_section "Verifying Installation"

    local all_good=true

    # Check Python
    if [ -d "${AGENT_DIR}/venv" ]; then
        log_info "Python venv: OK"
    else
        log_error "Python venv: MISSING"
        all_good=false
    fi

    # Check Node/bun
    if command_exists bun || command_exists node; then
        log_info "Node.js/bun: OK"
    else
        log_error "Node.js/bun: MISSING"
        all_good=false
    fi

    # Check .env
    if [ -f "${PROJECT_DIR}/.env" ]; then
        log_info "Environment config: OK"
    else
        log_error "Environment config: MISSING"
        all_good=false
    fi

    # Check directories
    if [ -d "${PROJECT_DIR}/data" ] && [ -d "${PROJECT_DIR}/logs" ]; then
        log_info "Application directories: OK"
    else
        log_error "Application directories: MISSING"
        all_good=false
    fi

    echo ""
    if [ "${all_good}" = true ]; then
        echo -e "${GREEN}  ✓ All checks passed!${NC}"
    else
        echo -e "${RED}  ✗ Some checks failed. Please review above.${NC}"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Print Next Steps
# ---------------------------------------------------------------------------
print_next_steps() {
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  JARVIS AI Agent System - Installation Complete!${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${GREEN}Next Steps:${NC}"
    echo ""
    echo -e "  1. Review and update your configuration:"
    echo -e "     ${YELLOW}nano ${PROJECT_DIR}/.env${NC}"
    echo ""
    echo -e "  2. Start JARVIS (Docker):"
    echo -e "     ${YELLOW}cd ${PROJECT_DIR} && docker compose up -d${NC}"
    echo ""
    echo -e "  3. Start JARVIS (Manual):"
    echo -e "     ${YELLOW}cd ${PROJECT_DIR} && ./scripts/start.sh${NC}"
    echo ""
    echo -e "  4. Start JARVIS (Development):"
    echo -e "     ${YELLOW}cd ${PROJECT_DIR} && make dev${NC}"
    echo ""
    echo -e "  5. Access the application:"
    echo -e "     ${GREEN}Web UI:${NC}    http://localhost:3000"
    echo -e "     ${GREEN}Agent API:${NC} http://localhost:8000"
    echo -e "     ${GREEN}API Docs:${NC}  http://localhost:8000/docs"
    echo ""
    echo -e "  ${YELLOW}Important:${NC} Make sure to update JWT_SECRET and ENCRYPTION_KEY in .env"
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
}

# =============================================================================
# Main
# =============================================================================
main() {
    echo -e "${CYAN}"
    echo "  ╔══════════════════════════════════════════════════════╗"
    echo "  ║     JARVIS AI Agent System - Installer v2.0.0       ║"
    echo "  ║     Just A Rather Very Intelligent System           ║"
    echo "  ╚══════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    # Parse arguments
    local skip_deps=false
    local skip_python=false
    local skip_node=false

    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-deps)   skip_deps=true;   shift ;;
            --skip-python) skip_python=true; shift ;;
            --skip-node)   skip_node=true;   shift ;;
            --yes)         JARVIS_AUTO_YES=1; shift ;;
            --help)
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  --skip-deps     Skip system dependency installation"
                echo "  --skip-python   Skip Python setup"
                echo "  --skip-node     Skip Node.js setup"
                echo "  --yes           Accept all prompts automatically"
                echo "  --help          Show this help message"
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done

    detect_os

    if [ "${skip_deps}" = false ]; then
        if confirm_action "Install system dependencies for ${OS_NAME}?"; then
            install_system_deps
        else
            log_warn "Skipping system dependency installation"
        fi
    fi

    if [ "${skip_python}" = false ]; then
        setup_python
    else
        log_warn "Skipping Python setup"
    fi

    if [ "${skip_node}" = false ]; then
        setup_node
    else
        log_warn "Skipping Node.js setup"
    fi

    init_database
    configure_environment
    verify_installation
    print_next_steps
}

# Run main
main "$@"
