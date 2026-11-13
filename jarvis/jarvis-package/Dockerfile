# =============================================================================
# JARVIS AI Agent System - Multi-Stage Docker Build
# =============================================================================
# Stage 1: Builder - Install system dependencies and Python packages
# Stage 2: Runtime - Minimal image with non-root user
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Builder
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS builder

# Set build-time metadata
LABEL maintainer="JARVIS Team"
LABEL stage="builder"
LABEL description="JARVIS AI Agent Builder Stage"

# Set environment variables for building
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=100

# Install system dependencies required for building Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    portaudio19-dev \
    libasound2-dev \
    libsndfile1-dev \
    libffi-dev \
    libssl-dev \
    libpq-dev \
    gcc \
    g++ \
    make \
    cmake \
    pkg-config \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Set working directory
WORKDIR /build

# Copy requirements first for better caching
COPY python-agent/requirements.txt ./requirements.txt

# Install Python dependencies into virtual environment
RUN pip install --upgrade pip setuptools wheel && \
    pip install -r requirements.txt

# Copy Python agent source code
COPY python-agent/ ./python-agent/

# Install the JARVIS agent package
RUN cd python-agent && \
    pip install -e . 2>/dev/null || true

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# Set build-time metadata
LABEL maintainer="JARVIS Team"
LABEL stage="runtime"
LABEL description="JARVIS AI Agent Runtime"
LABEL version="2.0.0"

# Set runtime environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    JARVIS_ENV=production \
    JARVIS_LOG_LEVEL=info \
    JARVIS_HOST=0.0.0.0 \
    JARVIS_PORT=8000 \
    JARVIS_WORKERS=4 \
    JARVIS_CONFIG_PATH=/app/config.yaml

# Install minimal runtime system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    portaudio19-dev \
    libasound2 \
    libsndfile1 \
    libffi8 \
    libssl3 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user and group for security
RUN groupadd -r jarvis && \
    useradd -r -g jarvis -d /app -s /sbin/nologin -c "JARVIS Agent Runtime" jarvis

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv

# Create application directories
RUN mkdir -p /app/data /app/logs /app/uploads /app/cache /app/config && \
    chown -R jarvis:jarvis /app

# Set working directory
WORKDIR /app

# Copy Python agent source code
COPY --from=builder /build/python-agent ./python-agent
COPY python-agent/main.py ./main.py
COPY python-agent/config.yaml ./config/config.yaml

# The Next.js app is packaged separately from ../jarvis (see docker-compose.yml)
# and served by its own container; this image only runs the Python agent.

# Ensure correct ownership
RUN chown -R jarvis:jarvis /app

# Switch to non-root user
USER jarvis

# Expose the API port
EXPOSE 8000

# Define volume mounts for persistent data
VOLUME ["/app/data", "/app/logs", "/app/uploads", "/app/cache"]

# Health check - verify the API is responsive
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

# Entry point - start uvicorn with the FastAPI application
ENTRYPOINT ["uvicorn", \
    "main:app", \
    "--host", "0.0.0.0", \
    "--port", "8000", \
    "--workers", "4", \
    "--loop", "uvloop", \
    "--http", "httptools", \
    "--log-level", "info", \
    "--access-log", \
    "--no-access-log"]

# Default command (can be overridden)
CMD []
