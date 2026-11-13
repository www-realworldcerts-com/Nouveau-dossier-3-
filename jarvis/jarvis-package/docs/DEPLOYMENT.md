# JARVIS AI Agent System - Deployment Documentation

> Complete deployment guide for JARVIS v2.0.0

---

## Table of Contents

1. [Deployment Overview](#deployment-overview)
2. [Docker Deployment](#docker-deployment)
3. [Docker Compose Deployment](#docker-compose-deployment)
4. [Kubernetes Deployment](#kubernetes-deployment)
5. [Manual Deployment](#manual-deployment)
6. [SSL/TLS Configuration](#ssltls-configuration)
7. [Monitoring & Observability](#monitoring--observability)
8. [Scaling](#scaling)
9. [Backup & Recovery](#backup--recovery)
10. [Troubleshooting](#troubleshooting)
11. [Performance Tuning](#performance-tuning)

---

## Deployment Overview

JARVIS supports multiple deployment methods:

| Method | Best For | Complexity | Scalability |
|--------|----------|------------|-------------|
| **Docker Compose** | Small teams, staging, single-server | Low | Vertical |
| **Kubernetes** | Production, enterprise, multi-node | High | Horizontal |
| **Manual** | Development, air-gapped environments | Medium | Manual |

### Architecture by Deployment Type

#### Docker Compose (Single Host)

```
┌─────────────────────────────────────────┐
│              Docker Host                 │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  │ Agent    │  │ Web      │  │ Redis │ │
│  │ :8000    │  │ :3000    │  │ :6379 │ │
│  └──────────┘  └──────────┘  └───────┘ │
│                                          │
│  Volumes: data, logs, uploads, cache    │
└─────────────────────────────────────────┘
```

#### Kubernetes (Multi-Node)

```
┌──────────────────────────────────────────────────────┐
│                   Kubernetes Cluster                   │
│                                                        │
│  ┌────────────────┐  ┌──────────────────────────────┐ │
│  │ Ingress (NGINX)│  │ cert-manager (Let's Encrypt) │ │
│  └───────┬────────┘  └──────────────────────────────┘ │
│          │                                             │
│  ┌───────┴────────────────────────────────────────┐   │
│  │             jarvis namespace                    │   │
│  │  ┌──────────┐ ┌──────────┐  ┌──────────┐      │   │
│  │  │agent-pod1│ │agent-pod2│  │  Redis   │      │   │
│  │  └──────────┘ └──────────┘  └──────────┘      │   │
│  │  ┌──────────┐ ┌──────────┐                     │   │
│  │  │ web-pod1 │ │ web-pod2 │                     │   │
│  │  └──────────┘ └──────────┘                     │   │
│  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

---

## Docker Deployment

### Prerequisites

- Docker 24+ installed
- Docker Compose v2+ installed
- At least 4GB RAM available for containers
- 10GB disk space for images and data

### Build the Image

```bash
# Clone the repository
git clone https://github.com/jarvis-ai/jarvis-package.git
cd jarvis-package

# Build the JARVIS Agent image
docker build -t jarvis-agent:2.0.0 .

# Build the JARVIS Web image from the single source of truth
cd ..
docker build -t jarvis-web:2.0.0 ./jarvis
cd jarvis-package
```

### Build Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `JARVIS_ENV` | `production` | Environment (production/staging/development) |
| `JARVIS_VERSION` | `2.0.0` | Version tag |

```bash
# Build with custom arguments
docker build \
  --build-arg JARVIS_ENV=staging \
  --build-arg JARVIS_VERSION=2.0.0-rc1 \
  -t jarvis-agent:2.0.0-rc1 \
  .
```

### Multi-Platform Build

```bash
# Build for multiple architectures
docker buildx create --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t jarvis-agent:2.0.0 \
  --push \
  .
```

### Run Standalone Container

```bash
# Run the agent
docker run -d \
  --name jarvis-agent \
  -p 8000:8000 \
  -e JARVIS_ENV=production \
  -e JWT_SECRET=your-secret-key \
  -e ENCRYPTION_KEY=your-encryption-key \
  -v jarvis-data:/app/data \
  -v jarvis-logs:/app/logs \
  --restart unless-stopped \
  jarvis-agent:2.0.0
```

---

## Docker Compose Deployment

### Quick Start

```bash
# 1. Copy environment file
cp .env.example .env

# 2. Edit required variables
nano .env

# 3. Start all services
docker compose up -d

# 4. Check health
docker compose ps
curl http://localhost:8000/api/health
```

### Environment Configuration

Edit the `.env` file with your configuration. Critical variables:

```env
# MUST CHANGE THESE
JWT_SECRET=<generate-a-64-char-secret>
ENCRYPTION_KEY=<generate-a-32-byte-key>

# API Keys
ZAI_API_KEY=<your-zai-api-key>

# Optional
JARVIS_AGENT_PORT=8000
JARVIS_WEB_PORT=3000
REDIS_PORT=6379
```

Generate secure secrets:

```bash
# Generate JWT secret
python3 -c "import secrets; print(secrets.token_urlsafe(64))"

# Generate encryption key
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

### Service Management

```bash
# Start services
docker compose up -d

# View logs
docker compose logs -f

# View specific service logs
docker compose logs -f jarvis-agent
docker compose logs -f jarvis-web

# Restart a service
docker compose restart jarvis-agent

# Scale a service (limited without load balancer)
docker compose up -d --scale jarvis-agent=2

# Stop all services
docker compose down

# Stop and remove volumes (WARNING: deletes data)
docker compose down -v
```

### Development Override

Use the development Docker Compose override for hot reload:

```bash
# Start development environment
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# With dev tools (RedisInsight, MailHog)
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile tools up
```

Development features:
- Source code mounted for hot reload
- Debug ports exposed (5678 for Python, 9229 for Node)
- Verbose logging enabled
- Single worker (easier debugging)
- RedisInsight available at http://localhost:5540

### Resource Limits

Default resource limits in `docker-compose.yml`:

| Service | CPU Limit | Memory Limit | CPU Reserved | Memory Reserved |
|---------|-----------|-------------|-------------|----------------|
| Agent | 2.0 | 2GB | 0.5 | 512MB |
| Web | 1.5 | 1GB | 0.25 | 256MB |
| Redis | 0.5 | 512MB | 0.1 | 64MB |

Adjust in `.env` or directly in `docker-compose.yml`.

---

## Kubernetes Deployment

### Prerequisites

- Kubernetes 1.27+ cluster
- kubectl configured and connected
- NGINX Ingress Controller installed
- cert-manager installed (for TLS)
- StorageClass for persistent volumes

### Deploy with Manifests

```bash
# Create namespace
kubectl create namespace jarvis

# Create secrets (update values first!)
kubectl create secret generic jarvis-secrets \
  --from-literal=JWT_SECRET='your-jwt-secret' \
  --from-literal=ENCRYPTION_KEY='your-encryption-key' \
  --from-literal=REDIS_PASSWORD='your-redis-password' \
  -n jarvis

# Apply all manifests
kubectl apply -f kubernetes/

# Verify deployment
kubectl get all -n jarvis
```

### Deploy Step by Step

```bash
# 1. Deploy services first
kubectl apply -f kubernetes/service.yaml

# 2. Deploy the agent
kubectl apply -f kubernetes/deployment.yaml

# 3. Wait for pods to be ready
kubectl wait --for=condition=ready pod -l app=jarvis-agent -n jarvis --timeout=120s
kubectl wait --for=condition=ready pod -l app=jarvis-web -n jarvis --timeout=120s

# 4. Deploy ingress (update host in ingress.yaml first!)
kubectl apply -f kubernetes/ingress.yaml

# 5. Check status
kubectl get ingress -n jarvis
```

### Update the Domain

Edit `kubernetes/ingress.yaml` and replace `jarvis.example.com` with your domain:

```yaml
spec:
  tls:
    - hosts:
        - your-domain.com
      secretName: jarvis-tls-secret
  rules:
    - host: your-domain.com
```

### Scaling

```bash
# Scale agent to 4 replicas
kubectl scale deployment jarvis-agent --replicas=4 -n jarvis

# Scale web to 3 replicas
kubectl scale deployment jarvis-web --replicas=3 -n jarvis

# Check rollout status
kubectl rollout status deployment/jarvis-agent -n jarvis
```

### Rolling Updates

```bash
# Update image
kubectl set image deployment/jarvis-agent \
  jarvis-agent=ghcr.io/jarvis-ai/jarvis-agent:2.0.1 \
  -n jarvis

# Check rollout
kubectl rollout status deployment/jarvis-agent -n jarvis

# Rollback if needed
kubectl rollout undo deployment/jarvis-agent -n jarvis
```

### Helm Chart (Alternative)

```bash
# Using Helm (if chart available)
helm repo add jarvis https://charts.jarvis-ai.dev
helm install jarvis jarvis/jarvis \
  --namespace jarvis \
  --set agent.image.tag=2.0.0 \
  --set agent.secrets.jwtSecret=your-secret \
  --set agent.secrets.encryptionKey=your-key \
  --set ingress.host=jarvis.your-domain.com
```

---

## Manual Deployment

### Prerequisites

- Python 3.11+
- Node.js 18+ or Bun 1.0+
- Redis 7+ (optional but recommended)
- SQLite (bundled with Python)

### Installation

```bash
# Run the installation script
./scripts/install.sh

# Or manually:
# 1. Install system dependencies
sudo apt-get install -y build-essential portaudio19-dev python3-dev python3-pip python3-venv redis-server

# 2. Set up Python environment
cd python-agent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 3. Set up Node.js environment
cd ../../jarvis
bun install --frozen-lockfile
bun run db:push

# 4. Configure environment
cd ..
cp .env.example .env
# Edit .env with your configuration
```

### Start Services

```bash
# Using the startup script
./scripts/start.sh

# Or manually:
# Terminal 1: Start Redis
redis-server --requirepass your-redis-password

# Terminal 2: Start Agent
cd python-agent
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4

# Terminal 3: Start Web
cd ../jarvis
bun run dev
# Or for production: bun run build && bun run start
```

### Systemd Services (Linux)

Create systemd service files for production:

**/etc/systemd/system/jarvis-agent.service:**

```ini
[Unit]
Description=JARVIS AI Agent
After=network.target redis.service
Wants=redis.service

[Service]
Type=simple
User=jarvis
Group=jarvis
WorkingDirectory=/opt/jarvis/python-agent
EnvironmentFile=/opt/jarvis/.env
ExecStart=/opt/jarvis/python-agent/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jarvis-agent

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/jarvis/data /opt/jarvis/logs /opt/jarvis/uploads
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

**/etc/systemd/system/jarvis-web.service:**

```ini
[Unit]
Description=JARVIS Web UI
After=network.target jarvis-agent.service
Wants=jarvis-agent.service

[Service]
Type=simple
User=jarvis
Group=jarvis
WorkingDirectory=/opt/jarvis/jarvis
EnvironmentFile=/opt/jarvis/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/bun run start
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jarvis-web

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start services
sudo systemctl daemon-reload
sudo systemctl enable jarvis-agent jarvis-web
sudo systemctl start jarvis-agent
sudo systemctl start jarvis-web

# Check status
sudo systemctl status jarvis-agent
sudo systemctl status jarvis-web
```

---

## SSL/TLS Configuration

### Let's Encrypt (Recommended)

Using cert-manager with Kubernetes:

```yaml
# ClusterIssuer for Let's Encrypt
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@your-domain.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
```

### Self-Signed Certificates (Development)

```bash
# Generate self-signed certificate
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout key.pem \
  -out cert.pem \
  -subj "/CN=jarvis.local"

# Use with Docker Compose
# Mount certs and configure in .env:
SSL_ENABLED=true
SSL_CERT_PATH=/app/config/certs/cert.pem
SSL_KEY_PATH=/app/config/certs/key.pem
```

### Custom Certificates

```bash
# Using custom certificates with NGINX
server {
    listen 443 ssl http2;
    server_name jarvis.your-domain.com;

    ssl_certificate /etc/ssl/certs/jarvis/fullchain.pem;
    ssl_certificate_key /etc/ssl/certs/jarvis/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE+AESGCM:DHE+AESGCM;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://jarvis-web:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        proxy_pass http://jarvis-agent:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://jarvis-agent:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

---

## Monitoring & Observability

### Health Check Endpoints

| Endpoint | Service | Description |
|----------|---------|-------------|
| `GET /api/health` | Agent | Comprehensive health check |
| `GET /api/jarvis/status` | Web | Web application status |

### Health Check Response

```json
{
  "status": "healthy",
  "version": "2.0.0",
  "uptime_seconds": 86400,
  "components": {
    "redis": "connected",
    "database": "connected",
    "voice_stt": "available",
    "voice_tts": "available",
    "swarm": "connected"
  }
}
```

### Prometheus Metrics

The agent exposes Prometheus metrics on port 9090:

```
# HTTP request metrics
http_requests_total{method="POST", endpoint="/api/chat", status="200"} 1500
http_request_duration_seconds{method="POST", endpoint="/api/chat"} 0.5

# Chat metrics
jarvis_chat_messages_total{direction="inbound"} 5000
jarvis_chat_messages_total{direction="outbound"} 5000
jarvis_chat_tokens_used_total{model="gpt-4"} 250000

# Voice metrics
jarvis_stt_requests_total 200
jarvis_stt_duration_seconds_sum 60.5
jarvis_tts_requests_total 180

# Swarm metrics
jarvis_swarm_agents_active{agent="code-reviewer"} 1
jarvis_swarm_tasks_completed_total{agent="code-reviewer"} 42
jarvis_swarm_task_duration_seconds{agent="code-reviewer"} 1.5

# Security metrics
jarvis_auth_attempts_total{result="success"} 500
jarvis_auth_attempts_total{result="failure"} 15
jarvis_rate_limit_exceeded_total{endpoint="/api/chat"} 3
```

### Log Aggregation

For production, aggregate logs using:

```yaml
# Fluentd/DaemonSet example
# Or use Loki + Grafana stack
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluentd
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: fluentd
  template:
    spec:
      containers:
        - name: fluentd
          image: fluent/fluentd:v1.16
          volumeMounts:
            - name: varlog
              mountPath: /var/log
      volumes:
        - name: varlog
          hostPath:
            path: /var/log
```

### Grafana Dashboard

Import the JARVIS dashboard to monitor:
- Request rates and latencies
- Error rates by endpoint
- Active WebSocket connections
- Swarm agent status
- Redis memory and connections
- JWT token operations

---

## Scaling

### Horizontal Scaling (Kubernetes)

```
┌──────────────────────────────────────────────┐
│              Load Balancer (Ingress)          │
└──────────────┬───────────────┬───────────────┘
               │               │
      ┌────────┴──────┐ ┌─────┴───────┐
      │  Agent Pod 1  │ │ Agent Pod 2  │
      │  (8000)       │ │ (8000)       │
      └───────────────┘ └──────────────┘
               │               │
      ┌────────┴──────┐ ┌─────┴───────┐
      │  Web Pod 1    │ │ Web Pod 2    │
      │  (3000)       │ │ (3000)       │
      └───────────────┘ └──────────────┘
               │
      ┌────────┴──────┐
      │  Redis        │
      │  (Sentinel/   │
      │   Cluster)    │
      └───────────────┘
```

### Scaling Considerations

1. **Agent (Stateless)**: Scale horizontally. Session affinity via Redis.
2. **Web (Stateless)**: Scale horizontally. Next.js supports standalone mode.
3. **Redis**: Use Redis Sentinel for HA, Redis Cluster for sharding.
4. **WebSocket**: Use sticky sessions or Redis pub/sub for message routing.

### Redis High Availability

For production, use Redis Sentinel:

```yaml
# Redis Sentinel configuration
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: jarvis
spec:
  replicas: 3
  # ... sentinel configuration
```

### Auto-Scaling (Kubernetes)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: jarvis-agent-hpa
  namespace: jarvis
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: jarvis-agent
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

---

## Backup & Recovery

### Data to Backup

| Data | Location | Backup Method | Frequency |
|------|----------|--------------|-----------|
| SQLite Database | `/app/data/jarvis.db` | File copy | Daily |
| Redis Data | Redis AOF/RDB | Redis BGSAVE | Hourly |
| Uploads | `/app/uploads/` | File copy | Daily |
| Logs | `/app/logs/` | Log rotation | Continuous |
| Configuration | `/app/config/`, `.env` | File copy | On change |

### Backup Script

```bash
#!/bin/bash
# backup.sh - JARVIS backup script

BACKUP_DIR="/backups/jarvis/$(date +%Y%m%d_%H%M%S)"
DATA_DIR="/app/data"
UPLOAD_DIR="/app/uploads"
CONFIG_DIR="/app/config"

mkdir -p "${BACKUP_DIR}"

# Backup SQLite database
cp "${DATA_DIR}/jarvis.db" "${BACKUP_DIR}/"
cp "${DATA_DIR}/jarvis.db" "${BACKUP_DIR}/jarvis.db.$(date +%s)"

# Backup Redis
redis-cli -a "${REDIS_PASSWORD}" BGSAVE
sleep 5
cp /var/lib/redis/dump.rdb "${BACKUP_DIR}/redis_dump.rdb"

# Backup uploads
tar czf "${BACKUP_DIR}/uploads.tar.gz" -C "${UPLOAD_DIR}" .

# Backup configuration
tar czf "${BACKUP_DIR}/config.tar.gz" -C "${CONFIG_DIR}" .

# Compress everything
tar czf "${BACKUP_DIR}.tar.gz" -C "$(dirname ${BACKUP_DIR})" "$(basename ${BACKUP_DIR})"
rm -rf "${BACKUP_DIR}"

echo "Backup created: ${BACKUP_DIR}.tar.gz"

# Clean old backups (keep last 30 days)
find /backups/jarvis/ -name "*.tar.gz" -mtime +30 -delete
```

### Recovery

```bash
# 1. Stop services
docker compose down
# or: systemctl stop jarvis-agent jarvis-web

# 2. Extract backup
tar xzf /backups/jarvis/20240101_120000.tar.gz -C /tmp/

# 3. Restore database
cp /tmp/20240101_120000/jarvis.db /app/data/jarvis.db

# 4. Restore Redis
cp /tmp/20240101_120000/redis_dump.rdb /var/lib/redis/dump.rdb

# 5. Restore uploads
tar xzf /tmp/20240101_120000/uploads.tar.gz -C /app/uploads/

# 6. Restore configuration
tar xzf /tmp/20240101_120000/config.tar.gz -C /app/config/

# 7. Start services
docker compose up -d
# or: systemctl start jarvis-agent jarvis-web

# 8. Verify
curl http://localhost:8000/api/health
```

---

## Troubleshooting

### Common Issues

#### 1. Agent Won't Start

**Symptoms**: Container exits immediately, connection refused on port 8000

**Diagnosis**:
```bash
# Check container logs
docker compose logs jarvis-agent

# Check if port is in use
ss -tlnp | grep 8000

# Check Python errors
docker compose exec jarvis-agent python -c "import jarvis_core"
```

**Solutions**:
- Verify all required environment variables are set
- Check Redis connectivity: `redis-cli -h redis -p 6379 ping`
- Verify Python dependencies: `pip install -r requirements.txt`
- Check for syntax errors in `config.yaml`

#### 2. Web UI Shows Blank Page

**Symptoms**: Browser loads but shows blank page, console errors

**Diagnosis**:
```bash
# Check web container logs
docker compose logs jarvis-web

# Check API connectivity
curl http://localhost:3000/api/jarvis/status

# Browser console errors (F12 → Console)
```

**Solutions**:
- Rebuild the Next.js app: `bun run build`
- Check `NEXT_PUBLIC_JARVIS_API_URL` is correct
- Clear browser cache and hard refresh (Ctrl+Shift+R)
- Verify Node.js dependencies: `bun install`

#### 3. Redis Connection Errors

**Symptoms**: "Connection refused", rate limiting not working

**Diagnosis**:
```bash
# Check Redis is running
docker compose ps redis

# Test Redis connection
redis-cli -h localhost -p 6379 -a your-password ping

# Check Redis logs
docker compose logs redis
```

**Solutions**:
- Restart Redis: `docker compose restart redis`
- Verify Redis password matches in `.env` and `docker-compose.yml`
- Check Redis memory: `redis-cli -a password INFO memory`
- Increase Redis maxmemory if needed

#### 4. WebSocket Connection Fails

**Symptoms**: Swarm panel shows disconnected, real-time features not working

**Diagnosis**:
```bash
# Test WebSocket connection
wscat -c ws://localhost:8000/ws/swarm

# Check NGINX/Ingress WebSocket configuration
# Verify proxy headers are set correctly
```

**Solutions**:
- Ensure NGINX/Ingress has WebSocket upgrade headers
- Check `proxy_read_timeout` and `proxy_send_timeout` are sufficient (3600s)
- Verify WSS is used for HTTPS deployments
- Check firewall allows WebSocket connections

#### 5. High Memory Usage

**Symptoms**: OOM kills, slow response times

**Diagnosis**:
```bash
# Check container resource usage
docker stats

# Check Python memory
docker compose exec jarvis-agent python -c "import psutil; print(psutil.virtual_memory())"

# Check Redis memory
redis-cli -a password INFO memory
```

**Solutions**:
- Increase container memory limits
- Reduce number of uvicorn workers
- Enable Redis maxmemory-policy: `allkeys-lru`
- Check for memory leaks in custom agents
- Review and optimize conversation history size

#### 6. SSL/TLS Certificate Errors

**Symptoms**: Browser shows "Not Secure", cert-manager errors

**Diagnosis**:
```bash
# Check certificate status
kubectl get certificate -n jarvis

# Check cert-manager logs
kubectl logs -n cert-manager deployment/cert-manager

# Test certificate
openssl s_client -connect jarvis.your-domain.com:443
```

**Solutions**:
- Verify DNS records point to the correct IP
- Check cert-manager ClusterIssuer configuration
- Ensure HTTP-01 challenge is reachable
- For self-signed certs, add to trusted CA store

#### 7. Slow API Response Times

**Symptoms**: Timeouts, high latency, slow chat responses

**Diagnosis**:
```bash
# Check response times
curl -o /dev/null -s -w "%{time_total}\n" http://localhost:8000/api/health

# Check resource usage
docker stats --no-stream

# Check Redis latency
redis-cli -a password --latency
```

**Solutions**:
- Scale horizontally (add more replicas)
- Increase worker count: `JARVIS_WORKERS=8`
- Enable uvloop: already default in production
- Check LLM API response times (external dependency)
- Enable response caching with Redis
- Review database query performance

#### 8. File Upload Failures

**Symptoms**: "File too large", "Invalid file type", upload timeout

**Diagnosis**:
```bash
# Check upload directory permissions
docker compose exec jarvis-agent ls -la /app/uploads/

# Check nginx/ingress max body size
# Look for: client_max_body_size in nginx config
```

**Solutions**:
- Increase `UPLOAD_MAX_SIZE` in `.env`
- Configure `client_max_body_size` in NGINX/Ingress
- Verify file type is in allowed list
- Check disk space in uploads volume
- Increase request timeout for large files

---

## Performance Tuning

### Agent (Python/FastAPI)

| Parameter | Default | Tuning | Impact |
|-----------|---------|--------|--------|
| `JARVIS_WORKERS` | 4 | CPU cores × 2 + 1 | More workers = more concurrent requests |
| `JARVIS_AGENT_LOOP` | uvloop | uvloop (best) | 2-4x faster than asyncio |
| `JARVIS_AGENT_HTTP` | httptools | httptools (best) | Faster HTTP parsing |
| `JARVIS_MAX_REQUEST_SIZE` | 50MB | Adjust per needs | Larger = more memory per request |

### Web (Next.js)

| Parameter | Default | Tuning | Impact |
|-----------|---------|--------|--------|
| `NODE_ENV` | production | Always production | Enables optimizations |
| `PORT` | 3000 | - | - |
| Standalone output | Yes | `output: 'standalone'` in next.config.ts | Reduces image size |

### Redis

| Parameter | Default | Tuning | Impact |
|-----------|---------|--------|--------|
| `maxmemory` | 256mb | Based on data size | Controls memory usage |
| `maxmemory-policy` | allkeys-lru | volatile-lru for cache | Eviction strategy |
| `save` | 60 1000 | Adjust per RPO | Persistence frequency |
| `appendfsync` | everysec | always for durability | Write durability vs speed |

### Database (SQLite/Prisma)

| Parameter | Default | Tuning | Impact |
|-----------|---------|--------|--------|
| WAL mode | Enabled | Keep enabled | Better concurrent reads |
| `synchronous` | NORMAL | FULL for durability | Write durability vs speed |
| `cache_size` | -2000 | -10000 | More cache = faster reads |
| `busy_timeout` | 5000 | 10000 | Wait longer for locks |

### Kubernetes Resources

```yaml
# Production resource recommendations
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: "2"
    memory: 2Gi

# Enable CPU/Memory profiling
# Add to deployment annotations:
annotations:
  sidecar.istio.io/rewriteAppHTTPProbers: "true"
```

### Connection Pooling

```python
# Redis connection pool
import redis

redis_pool = redis.ConnectionPool(
    host='redis',
    port=6379,
    password='your-password',
    max_connections=50,
    socket_timeout=5,
    socket_connect_timeout=5,
    retry_on_timeout=True,
    decode_responses=True
)
redis_client = redis.Redis(connection_pool=redis_pool)
```

---

*Last updated: 2024 | JARVIS AI Agent System v2.0.0*
