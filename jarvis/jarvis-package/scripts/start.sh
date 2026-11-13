#!/usr/bin/env bash
# =============================================================================
# JARVIS AI Agent System - Startup Script
# =============================================================================
# This script:
#   1. Checks all required dependencies
#   2. Sets up the environment
#   3. Creates necessary directories
#   4. Starts all services
#   5. Handles graceful shutdown signals
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
AGENT_DIR="${PROJECT_DIR}/python-agent"
WEB_DIR="${PROJECT_DIR}/nextjs-app"
DATA_DIR="${PROJECT_DIR}/data"
LOG_DIR="${PROJECT_DIR}/logs"
UPLOAD_DIR="${PROJECT_DIR}/uploads"
CACHE_DIR="${PROJECT_DIR}/cache"
CONFIG_DIR="${PROJECT_DIR}/config"
PID_DIR="${PROJECT_DIR}/.pids"

AGENT_PORT="${JARVIS_PORT:-8000}"
WEB_PORT="${JARVIS_WEB_PORT:-3000}"
REDIS_PORT="${REDIS_PORT:-6379}"

AGENT_PID_FILE="${PID_DIR}/agent.pid"
WEB_PID_FILE="${PID_DIR}/web.pid"
REDIS_PID_FILE="${PID_DIR}/redis.pid"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------------------------
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${CYAN}[STEP]${NC} $1"
}

check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "Required command '$1' not found. Please install it first."
        return 1
    fi
    return 0
}

check_port() {
    local port=$1
    if lsof -i ":${port}" &> /dev/null || ss -tlnp 2>/dev/null | grep -q ":${port} "; then
        log_warn "Port ${port} is already in use"
        return 1
    fi
    return 0
}

wait_for_port() {
    local port=$1
    local max_wait=${2:-30}
    local waited=0
    while ! curl -sf "http://localhost:${port}/" > /dev/null 2>&1; do
        sleep 1
        waited=$((waited + 1))
        if [ "${waited}" -ge "${max_wait}" ]; then
            log_error "Timeout waiting for port ${port}"
            return 1
        fi
    done
    return 0
}

# ---------------------------------------------------------------------------
# Signal Handling
# ---------------------------------------------------------------------------
cleanup() {
    echo ""
    log_info "Received shutdown signal. Stopping services gracefully..."

    # Stop Agent
    if [ -f "${AGENT_PID_FILE}" ]; then
        local agent_pid
        agent_pid=$(cat "${AGENT_PID_FILE}")
        if kill -0 "${agent_pid}" 2>/dev/null; then
            log_info "Stopping JARVIS Agent (PID: ${agent_pid})..."
            kill -TERM "${agent_pid}" 2>/dev/null || true
            # Wait for graceful shutdown
            local waited=0
            while kill -0 "${agent_pid}" 2>/dev/null && [ "${waited}" -lt 30 ]; do
                sleep 1
                waited=$((waited + 1))
            done
            # Force kill if still running
            if kill -0 "${agent_pid}" 2>/dev/null; then
                log_warn "Force killing JARVIS Agent..."
                kill -KILL "${agent_pid}" 2>/dev/null || true
            fi
        fi
        rm -f "${AGENT_PID_FILE}"
    fi

    # Stop Web
    if [ -f "${WEB_PID_FILE}" ]; then
        local web_pid
        web_pid=$(cat "${WEB_PID_FILE}")
        if kill -0 "${web_pid}" 2>/dev/null; then
            log_info "Stopping JARVIS Web (PID: ${web_pid})..."
            kill -TERM "${web_pid}" 2>/dev/null || true
            local waited=0
            while kill -0 "${web_pid}" 2>/dev/null && [ "${waited}" -lt 15 ]; do
                sleep 1
                waited=$((waited + 1))
            done
            if kill -0 "${web_pid}" 2>/dev/null; then
                kill -KILL "${web_pid}" 2>/dev/null || true
            fi
        fi
        rm -f "${WEB_PID_FILE}"
    fi

    # Stop Redis (if we started it)
    if [ -f "${REDIS_PID_FILE}" ]; then
        local redis_pid
        redis_pid=$(cat "${REDIS_PID_FILE}")
        if kill -0 "${redis_pid}" 2>/dev/null; then
            log_info "Stopping Redis (PID: ${redis_pid})..."
            kill -TERM "${redis_pid}" 2>/dev/null || true
            sleep 2
            if kill -0 "${redis_pid}" 2>/dev/null; then
                kill -KILL "${redis_pid}" 2>/dev/null || true
            fi
        fi
        rm -f "${REDIS_PID_FILE}"
    fi

    log_info "All services stopped. Goodbye!"
    exit 0
}

trap cleanup SIGINT SIGTERM SIGQUIT

# ---------------------------------------------------------------------------
# Step 1: Check Dependencies
# ---------------------------------------------------------------------------
check_dependencies() {
    log_step "Checking dependencies..."

    local missing=0

    check_command "python3" || missing=1
    check_command "pip3" || missing=1
    check_command "node" || missing=1
    check_command "npm" || check_command "bun" || missing=1

    if [ "${missing}" -eq 1 ]; then
        log_error "Missing required dependencies. Please run: ./scripts/install.sh"
        exit 1
    fi

    # Check Python version
    local python_version
    python_version=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    if [ "$(echo "${python_version} >= 3.11" | bc -l 2>/dev/null || echo 0)" -eq 0 ]; then
        log_warn "Python 3.11+ is recommended (found: ${python_version})"
    fi

    # Check Node version
    local node_version
    node_version=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "${node_version}" -lt 18 ]; then
        log_warn "Node.js 18+ is recommended (found: $(node -v))"
    fi

    log_info "All dependencies satisfied"
}

# ---------------------------------------------------------------------------
# Step 2: Setup Environment
# ---------------------------------------------------------------------------
setup_environment() {
    log_step "Setting up environment..."

    # Load .env file
    if [ -f "${PROJECT_DIR}/.env" ]; then
        set -a
        # shellcheck source=/dev/null
        source "${PROJECT_DIR}/.env"
        set +a
        log_info "Loaded environment from .env"
    elif [ -f "${PROJECT_DIR}/.env.example" ]; then
        log_warn "No .env file found. Copying from .env.example..."
        cp "${PROJECT_DIR}/.env.example" "${PROJECT_DIR}/.env"
        set -a
        # shellcheck source=/dev/null
        source "${PROJECT_DIR}/.env"
        set +a
        log_warn "Please review and update .env with your actual configuration"
    else
        log_warn "No .env or .env.example found. Using defaults."
    fi

    # Validate critical environment variables
    local critical_vars=(
        "JWT_SECRET"
        "ENCRYPTION_KEY"
    )

    for var in "${critical_vars[@]}"; do
        if [ -z "${!var:-}" ]; then
            log_error "Critical environment variable ${var} is not set"
            exit 1
        fi
        # Warn if using default/placeholder values
        if [[ "${!var}" == *"change_this"* ]] || [[ "${!var}" == *"your-"* ]]; then
            log_warn "Environment variable ${var} appears to use a placeholder value. Please update it."
        fi
    done

    log_info "Environment configured"
}

# ---------------------------------------------------------------------------
# Step 3: Create Directories
# ---------------------------------------------------------------------------
create_directories() {
    log_step "Creating application directories..."

    mkdir -p "${DATA_DIR}"
    mkdir -p "${LOG_DIR}"
    mkdir -p "${UPLOAD_DIR}"
    mkdir -p "${UPLOAD_DIR}/quarantine"
    mkdir -p "${CACHE_DIR}"
    mkdir -p "${CONFIG_DIR}"
    mkdir -p "${PID_DIR}"
    mkdir -p "${DATA_DIR}/images"

    # Set permissions
    chmod 755 "${DATA_DIR}" "${LOG_DIR}" "${UPLOAD_DIR}" "${CACHE_DIR}" "${CONFIG_DIR}"
    chmod 700 "${PID_DIR}"

    log_info "Directories created"
}

# ---------------------------------------------------------------------------
# Step 4: Start Redis
# ---------------------------------------------------------------------------
start_redis() {
    log_step "Starting Redis..."

    if command -v redis-server &> /dev/null; then
        if ! check_port "${REDIS_PORT}"; then
            log_info "Redis is already running on port ${REDIS_PORT}"
            return 0
        fi

        redis-server \
            --port "${REDIS_PORT}" \
            --requirepass "${REDIS_PASSWORD:-jarvis_redis_2024}" \
            --maxmemory 256mb \
            --maxmemory-policy allkeys-lru \
            --appendonly yes \
            --dir "${DATA_DIR}" \
            --daemonize yes \
            --pidfile "${REDIS_PID_FILE}" \
            --logfile "${LOG_DIR}/redis.log"

        # Wait for Redis to start
        sleep 2
        if redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD:-jarvis_redis_2024}" ping 2>/dev/null | grep -q PONG; then
            log_info "Redis started on port ${REDIS_PORT}"
        else
            log_warn "Redis may not have started correctly. Check ${LOG_DIR}/redis.log"
        fi
    else
        log_warn "Redis not found. Some features may not work. Install Redis or use Docker."
    fi
}

# ---------------------------------------------------------------------------
# Step 5: Start JARVIS Agent
# ---------------------------------------------------------------------------
start_agent() {
    log_step "Starting JARVIS Agent..."

    if ! check_port "${AGENT_PORT}"; then
        log_warn "JARVIS Agent is already running on port ${AGENT_PORT}"
        return 0
    fi

    cd "${AGENT_DIR}"

    # Check if virtual environment exists
    local python_cmd="python3"
    if [ -d "venv" ]; then
        python_cmd="venv/bin/python"
        log_info "Using virtual environment"
    fi

    # Start the agent
    local workers="${JARVIS_WORKERS:-4}"
    local log_level="${JARVIS_LOG_LEVEL:-info}"

    nohup ${python_cmd} -m uvicorn main:app \
        --host 0.0.0.0 \
        --port "${AGENT_PORT}" \
        --workers "${workers}" \
        --loop uvloop \
        --http httptools \
        --log-level "${log_level}" \
        --access-log \
        >> "${LOG_DIR}/agent.log" 2>&1 &

    local agent_pid=$!
    echo "${agent_pid}" > "${AGENT_PID_FILE}"

    # Wait for agent to start
    if wait_for_port "${AGENT_PORT}" 30; then
        log_info "JARVIS Agent started on port ${AGENT_PORT} (PID: ${agent_pid})"
    else
        log_error "JARVIS Agent failed to start. Check ${LOG_DIR}/agent.log"
        tail -20 "${LOG_DIR}/agent.log"
        exit 1
    fi

    cd "${PROJECT_DIR}"
}

# ---------------------------------------------------------------------------
# Step 6: Start JARVIS Web
# ---------------------------------------------------------------------------
start_web() {
    log_step "Starting JARVIS Web..."

    if ! check_port "${WEB_PORT}"; then
        log_warn "JARVIS Web is already running on port ${WEB_PORT}"
        return 0
    fi

    cd "${WEB_DIR}"

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        log_info "Installing web dependencies..."
        if command -v bun &> /dev/null; then
            bun install
        else
            npm install
        fi
    fi

    # Push Prisma schema
    if [ -f "prisma/schema.prisma" ]; then
        log_info "Pushing database schema..."
        if command -v bun &> /dev/null; then
            bun run db:push 2>/dev/null || true
        else
            npx prisma db push 2>/dev/null || true
        fi
    fi

    # Start the web server
    if [ "${NODE_ENV:-production}" = "development" ]; then
        nohup npx next dev -p "${WEB_PORT}" \
            >> "${LOG_DIR}/web.log" 2>&1 &
    else
        # Build first if needed
        if [ ! -d ".next" ]; then
            log_info "Building web application..."
            if command -v bun &> /dev/null; then
                bun run build
            else
                npm run build
            fi
        fi

        nohup npx next start -p "${WEB_PORT}" \
            >> "${LOG_DIR}/web.log" 2>&1 &
    fi

    local web_pid=$!
    echo "${web_pid}" > "${WEB_PID_FILE}"

    # Wait for web to start
    if wait_for_port "${WEB_PORT}" 60; then
        log_info "JARVIS Web started on port ${WEB_PORT} (PID: ${web_pid})"
    else
        log_error "JARVIS Web failed to start. Check ${LOG_DIR}/web.log"
        tail -20 "${LOG_DIR}/web.log"
        exit 1
    fi

    cd "${PROJECT_DIR}"
}

# ---------------------------------------------------------------------------
# Step 7: Health Check
# ---------------------------------------------------------------------------
health_check() {
    log_step "Running health checks..."

    # Agent health
    local agent_healthy=false
    if curl -sf "http://localhost:${AGENT_PORT}/api/health" > /dev/null 2>&1; then
        log_info "Agent API: Healthy"
        agent_healthy=true
    else
        log_error "Agent API: Unhealthy"
    fi

    # Web health
    local web_healthy=false
    if curl -sf "http://localhost:${WEB_PORT}/api/jarvis/status" > /dev/null 2>&1; then
        log_info "Web UI:    Healthy"
        web_healthy=true
    else
        log_error "Web UI:    Unhealthy"
    fi

    # Redis health
    if command -v redis-cli &> /dev/null; then
        if redis-cli -p "${REDIS_PORT}" -a "${REDIS_PASSWORD:-jarvis_redis_2024}" ping 2>/dev/null | grep -q PONG; then
            log_info "Redis:     Healthy"
        else
            log_warn "Redis:     Unhealthy (optional)"
        fi
    fi

    if [ "${agent_healthy}" = true ] && [ "${web_healthy}" = true ]; then
        log_info "All critical services are healthy!"
    else
        log_error "Some services are unhealthy. Check logs in ${LOG_DIR}/"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Step 8: Print Summary
# ---------------------------------------------------------------------------
print_summary() {
    echo ""
    echo -e "${CYAN}============================================================${NC}"
    echo -e "${CYAN}  JARVIS AI Agent System v2.0.0 - Running${NC}"
    echo -e "${CYAN}============================================================${NC}"
    echo -e "  ${GREEN}Agent API:${NC}   http://localhost:${AGENT_PORT}"
    echo -e "  ${GREEN}Web UI:${NC}      http://localhost:${WEB_PORT}"
    echo -e "  ${GREEN}API Docs:${NC}    http://localhost:${AGENT_PORT}/docs"
    echo -e "  ${GREEN}Redis:${NC}       localhost:${REDIS_PORT}"
    echo ""
    echo -e "  ${YELLOW}Logs:${NC}        ${LOG_DIR}/"
    echo -e "  ${YELLOW}Data:${NC}        ${DATA_DIR}/"
    echo -e "  ${YELLOW}Uploads:${NC}     ${UPLOAD_DIR}/"
    echo ""
    echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop all services"
    echo -e "${CYAN}============================================================${NC}"
    echo ""
}

# =============================================================================
# Main
# =============================================================================
main() {
    echo -e "${CYAN}"
    echo "  ╔══════════════════════════════════════════════════════╗"
    echo "  ║         JARVIS AI Agent System v2.0.0               ║"
    echo "  ║         Just A Rather Very Intelligent System       ║"
    echo "  ╚══════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    check_dependencies
    setup_environment
    create_directories
    start_redis
    start_agent
    start_web
    health_check
    print_summary

    # Keep script running and wait for signals
    log_info "JARVIS is running. Press Ctrl+C to stop."
    wait
}

# Run main
main "$@"
