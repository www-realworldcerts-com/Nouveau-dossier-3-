# =============================================================================
# JARVIS AI Agent System - Makefile
# =============================================================================
# Usage:
#   make <target>     - Run a specific target
#   make help         - Show all available targets
#   make dev          - Start development environment
#   make prod         - Start production environment
# =============================================================================

# Configuration
COMPOSE          = docker compose
COMPOSE_DEV      = docker compose -f docker-compose.yml -f docker-compose.dev.yml
PROJECT_NAME     = jarvis
IMAGE_NAME       = jarvis-agent
IMAGE_TAG        ?= 2.0.0
REGISTRY         ?= ghcr.io/jarvis-ai
PYTHON_DIR       = python-agent
K8S_NAMESPACE    ?= jarvis
K8S_DIR          = kubernetes

# Colors for output
GREEN  := \033[0;32m
YELLOW := \033[1;33m
RED    := \033[0;31m
CYAN   := \033[0;36m
RESET  := \033[0m

# =============================================================================
# Help
# =============================================================================
.PHONY: help
help: ## Show this help message
	@echo ""
	@echo "$(CYAN)JARVIS AI Agent System - Available Commands$(RESET)"
	@echo "$(CYAN)=============================================$(RESET)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(RESET) %s\n", $$1, $$2}'
	@echo ""

# =============================================================================
# Build
# =============================================================================
.PHONY: build
build: ## Build all Docker images
	@echo "$(YELLOW)Building JARVIS Docker images...$(RESET)"
	$(COMPOSE) build --parallel
	@echo "$(GREEN)Build complete!$(RESET)"

.PHONY: build-agent
build-agent: ## Build the JARVIS Agent image only
	@echo "$(YELLOW)Building JARVIS Agent image...$(RESET)"
	$(COMPOSE) build jarvis-agent
	@echo "$(GREEN)Agent build complete!$(RESET)"

.PHONY: build-web
build-web: ## Build the JARVIS Web image only
	@echo "$(YELLOW)Building JARVIS Web image...$(RESET)"
	$(COMPOSE) build jarvis-web
	@echo "$(GREEN)Web build complete!$(RESET)"

.PHONY: build-no-cache
build-no-cache: ## Build all images without cache
	@echo "$(YELLOW)Building JARVIS images (no cache)...$(RESET)"
	$(COMPOSE) build --no-cache --parallel
	@echo "$(GREEN)Build complete!$(RESET)"

# =============================================================================
# Start / Stop
# =============================================================================
.PHONY: up
up: ## Start all services in detached mode
	@echo "$(YELLOW)Starting JARVIS services...$(RESET)"
	$(COMPOSE) up -d
	@echo "$(GREEN)JARVIS is running!$(RESET)"
	@echo "$(CYAN)  Agent API: http://localhost:8000$(RESET)"
	@echo "$(CYAN)  Web UI:    http://localhost:3000$(RESET)"
	@echo "$(CYAN)  Redis:     localhost:6379$(RESET)"

.PHONY: down
down: ## Stop and remove all containers
	@echo "$(YELLOW)Stopping JARVIS services...$(RESET)"
	$(COMPOSE) down
	@echo "$(GREEN)Services stopped!$(RESET)"

.PHONY: restart
restart: ## Restart all services
	@echo "$(YELLOW)Restarting JARVIS services...$(RESET)"
	$(COMPOSE) restart
	@echo "$(GREEN)Services restarted!$(RESET)"

.PHONY: dev
dev: ## Start development environment with hot reload
	@echo "$(YELLOW)Starting JARVIS development environment...$(RESET)"
	$(COMPOSE_DEV) up --build
	@echo "$(GREEN)Development environment running!$(RESET)"

.PHONY: dev-bg
dev-bg: ## Start development environment in background
	@echo "$(YELLOW)Starting JARVIS dev environment (background)...$(RESET)"
	$(COMPOSE_DEV) up -d --build
	@echo "$(GREEN)Development environment running in background!$(RESET)"

.PHONY: dev-down
dev-down: ## Stop development environment
	@echo "$(YELLOW)Stopping development environment...$(RESET)"
	$(COMPOSE_DEV) down
	@echo "$(GREEN)Development environment stopped!$(RESET)"

# =============================================================================
# Testing
# =============================================================================
.PHONY: test
test: ## Run all tests
	@echo "$(YELLOW)Running JARVIS tests...$(RESET)"
	$(COMPOSE) exec jarvis-agent python -m pytest tests/ -v --tb=short
	@echo "$(GREEN)Tests complete!$(RESET)"

.PHONY: test-agent
test-agent: ## Run Python agent tests only
	@echo "$(YELLOW)Running agent tests...$(RESET)"
	$(COMPOSE) exec jarvis-agent python -m pytest tests/ -v --tb=short

.PHONY: test-web
test-web: ## Run Next.js web tests only
	@echo "$(YELLOW)Running web tests...$(RESET)"
	$(COMPOSE) exec jarvis-web bun test

.PHONY: test-security
test-security: ## Run security tests only
	@echo "$(YELLOW)Running security tests...$(RESET)"
	$(COMPOSE) exec jarvis-agent python -m pytest tests/test_security.py -v --tb=short

.PHONY: lint
lint: ## Run linters on all services
	@echo "$(YELLOW)Running linters...$(RESET)"
	$(COMPOSE) exec jarvis-agent python -m flake8 python-agent/ --max-line-length=120
	$(COMPOSE) exec jarvis-web bun run lint
	@echo "$(GREEN)Linting complete!$(RESET)"

# =============================================================================
# Logs
# =============================================================================
.PHONY: logs
logs: ## Tail logs from all services
	$(COMPOSE) logs -f

.PHONY: logs-agent
logs-agent: ## Tail logs from JARVIS Agent
	$(COMPOSE) logs -f jarvis-agent

.PHONY: logs-web
logs-web: ## Tail logs from JARVIS Web
	$(COMPOSE) logs -f jarvis-web

.PHONY: logs-redis
logs-redis: ## Tail logs from Redis
	$(COMPOSE) logs -f redis

# =============================================================================
# Shell / Debug
# =============================================================================
.PHONY: shell
shell: ## Open a shell in the agent container
	$(COMPOSE) exec jarvis-agent /bin/bash

.PHONY: shell-web
shell-web: ## Open a shell in the web container
	$(COMPOSE) exec jarvis-web /bin/sh

.PHONY: shell-redis
shell-redis: ## Open redis-cli
	$(COMPOSE) exec redis redis-cli -a jarvis_redis_2024

.PHONY: python
python: ## Open Python REPL in agent container
	$(COMPOSE) exec jarvis-agent python

.PHONY: ipython
ipython: ## Open IPython REPL in agent container
	$(COMPOSE) exec jarvis-agent python -m IPython

# =============================================================================
# Status / Health
# =============================================================================
.PHONY: status
status: ## Show status of all services
	@echo "$(CYAN)JARVIS Service Status$(RESET)"
	@echo "$(CYAN)====================$(RESET)"
	$(COMPOSE) ps
	@echo ""
	@echo "$(CYAN)Health Checks$(RESET)"
	@echo "$(CYAN)=============$(RESET)"
	@-curl -s http://localhost:8000/api/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "$(RED)Agent API: Unreachable$(RESET)"
	@-curl -s http://localhost:3000/api/jarvis/status 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "$(RED)Web API: Unreachable$(RESET)"
	@-echo -n "Redis: " && (docker exec jarvis-redis redis-cli -a jarvis_redis_2024 ping 2>/dev/null || echo "$(RED)Unreachable$(RESET)")

.PHONY: health
health: ## Check health of all services
	@echo "$(YELLOW)Checking JARVIS service health...$(RESET)"
	@echo -n "Agent API (8000): " && (curl -sf http://localhost:8000/api/health > /dev/null && echo "$(GREEN)Healthy$(RESET)" || echo "$(RED)Unhealthy$(RESET)")
	@echo -n "Web UI (3000):    " && (curl -sf http://localhost:3000/api/jarvis/status > /dev/null && echo "$(GREEN)Healthy$(RESET)" || echo "$(RED)Unhealthy$(RESET)")
	@echo -n "Redis (6379):     " && (docker exec jarvis-redis redis-cli -a jarvis_redis_2024 ping 2>/dev/null | grep -q PONG && echo "$(GREEN)Healthy$(RESET)" || echo "$(RED)Unhealthy$(RESET)")

# =============================================================================
# Database
# =============================================================================
.PHONY: db-push
db-push: ## Push Prisma schema to database
	@echo "$(YELLOW)Pushing database schema...$(RESET)"
	$(COMPOSE) exec jarvis-web bun run db:push
	@echo "$(GREEN)Schema pushed!$(RESET)"

.PHONY: db-migrate
db-migrate: ## Run database migrations
	@echo "$(YELLOW)Running database migrations...$(RESET)"
	$(COMPOSE) exec jarvis-web bun run db:migrate
	@echo "$(GREEN)Migrations complete!$(RESET)"

.PHONY: db-reset
db-reset: ## Reset the database (WARNING: destroys data)
	@echo "$(RED)WARNING: This will destroy all database data!$(RESET)"
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ] || exit 1
	$(COMPOSE) exec jarvis-web bun run db:reset
	@echo "$(GREEN)Database reset!$(RESET)"

.PHONY: db-seed
db-seed: ## Seed the database with initial data
	@echo "$(YELLOW)Seeding database...$(RESET)"
	$(COMPOSE) exec jarvis-agent python -m jarvis_core.seed
	@echo "$(GREEN)Database seeded!$(RESET)"

# =============================================================================
# Clean
# =============================================================================
.PHONY: clean
clean: ## Remove containers, volumes, and images
	@echo "$(YELLOW)Cleaning JARVIS resources...$(RESET)"
	$(COMPOSE) down -v --rmi local --remove-orphans
	@echo "$(GREEN)Clean complete!$(RESET)"

.PHONY: clean-volumes
clean-volumes: ## Remove Docker volumes only
	@echo "$(YELLOW)Removing Docker volumes...$(RESET)"
	$(COMPOSE) down -v
	@echo "$(GREEN)Volumes removed!$(RESET)"

.PHONY: clean-images
clean-images: ## Remove JARVIS Docker images
	@echo "$(YELLOW)Removing JARVIS images...$(RESET)"
	docker rmi $$(docker images | grep jarvis | awk '{print $$3}') 2>/dev/null || true
	@echo "$(GREEN)Images removed!$(RESET)"

.PHONY: clean-all
clean-all: ## Remove everything including build cache
	@echo "$(RED)WARNING: This removes all JARVIS Docker resources!$(RESET)"
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ] || exit 1
	$(COMPOSE) down -v --rmi all --remove-orphans
	docker system prune -f
	@echo "$(GREEN)Everything cleaned!$(RESET)"

.PHONY: clean-logs
clean-logs: ## Remove log files
	@echo "$(YELLOW)Cleaning log files...$(RESET)"
	rm -rf logs/*.log
	@echo "$(GREEN)Logs cleaned!$(RESET)"

# =============================================================================
# Kubernetes
# =============================================================================
.PHONY: k8s-apply
k8s-apply: ## Apply all Kubernetes manifests
	@echo "$(YELLOW)Applying Kubernetes manifests...$(RESET)"
	kubectl apply -f $(K8S_DIR)/
	@echo "$(GREEN)Manifests applied!$(RESET)"

.PHONY: k8s-delete
k8s-delete: ## Delete all Kubernetes resources
	@echo "$(YELLOW)Deleting Kubernetes resources...$(RESET)"
	kubectl delete -f $(K8S_DIR)/ --ignore-not-found=true
	@echo "$(GREEN)Resources deleted!$(RESET)"

.PHONY: k8s-status
k8s-status: ## Show Kubernetes deployment status
	@echo "$(CYAN)Kubernetes Status$(RESET)"
	kubectl get all -n $(K8S_NAMESPACE)

.PHONY: k8s-logs
k8s-logs: ## Tail Kubernetes logs
	kubectl logs -f deployment/jarvis-agent -n $(K8S_NAMESPACE)

.PHONY: k8s-shell
k8s-shell: ## Open shell in Kubernetes pod
	kubectl exec -it deployment/jarvis-agent -n $(K8S_NAMESPACE) -- /bin/bash

# =============================================================================
# Setup / Install
# =============================================================================
.PHONY: setup
setup: ## Initial setup - copy env, build, and start
	@echo "$(CYAN)JARVIS Initial Setup$(RESET)"
	@echo "$(CYAN)====================$(RESET)"
	@test -f .env || (cp .env.example .env && echo "$(GREEN)Created .env from .env.example$(RESET)")
	@echo "$(YELLOW)Building Docker images...$(RESET)"
	$(COMPOSE) build --parallel
	@echo "$(YELLOW)Starting services...$(RESET)"
	$(COMPOSE) up -d
	@echo "$(YELLOW)Waiting for services to be healthy...$(RESET)"
	@sleep 15
	@$(MAKE) health
	@echo ""
	@echo "$(GREEN)JARVIS is ready!$(RESET)"
	@echo "$(CYAN)  Agent API: http://localhost:8000$(RESET)"
	@echo "$(CYAN)  Web UI:    http://localhost:3000$(RESET)"

.PHONY: env
env: ## Create .env from .env.example if not exists
	@test -f .env && echo "$(GREEN).env already exists$(RESET)" || (cp .env.example .env && echo "$(GREEN)Created .env from .env.example$(RESET)")

# =============================================================================
# Utility
# =============================================================================
.PHONY: pull
pull: ## Pull latest base images
	$(COMPOSE) pull

.PHONY: ps
ps: ## List running containers
	$(COMPOSE) ps

.PHONY: top
top: ## Show resource usage of containers
	$(COMPOSE) top

.PHONY: config
config: ## Validate and view compose config
	$(COMPOSE) config

.PHONY: version
version: ## Show JARVIS version
	@echo "$(CYAN)JARVIS AI Agent System v$(IMAGE_TAG)$(RESET)"

# =============================================================================
# Docker Registry
# =============================================================================
.PHONY: push
push: ## Push images to registry
	docker tag $(IMAGE_NAME):$(IMAGE_TAG) $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	docker push $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	@echo "$(GREEN)Image pushed to $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)$(RESET)"

.PHONY: tag
tag: ## Tag image for registry
	docker tag $(IMAGE_NAME):$(IMAGE_TAG) $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)
	@echo "$(GREEN)Tagged $(REGISTRY)/$(IMAGE_NAME):$(IMAGE_TAG)$(RESET)"
