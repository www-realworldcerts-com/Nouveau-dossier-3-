"""
JARVIS Swarm Connector Module

Provides WebSocket-based connectivity to the JARVIS swarm orchestration
system. Manages agent lifecycle, task dispatching, real-time updates,
and heartbeat monitoring with automatic reconnection.

Features:
    - WebSocket connection with authentication and auto-reconnect
    - Task dispatch with AES-256-GCM payload encryption
    - Real-time update streaming via AsyncGenerator
    - Heartbeat loop for connection keep-alive
    - Exponential backoff with jitter for reconnection
    - Agent status tracking for 6 agent types
    - GitHub repository integration for code review agents
    - Agent activation/deactivation lifecycle management

Supported Agent Types:
    - code-reviewer: Automated code review and quality analysis
    - security-auditor: Security vulnerability scanning and reporting
    - test-engineer: Test generation, execution, and coverage analysis
    - web-performance: Web performance auditing and optimization
    - payment-agent: Payment processing validation and compliance
    - custom: User-defined custom agents

Integration:
    GitHub Repo: https://github.com/younestsouli2019-bot/Nouveau-dossier-3-
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import random
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, AsyncGenerator, Optional

import aiohttp

logger = logging.getLogger(__name__)

# GitHub repository for swarm agent code integration
GITHUB_REPO_URL = "https://github.com/younestsouli2019-bot/Nouveau-dossier-3-"
GITHUB_API_URL = f"https://api.github.com/repos/younestsouli2019-bot/Nouveau-dossier-3-"


class AgentType(str, Enum):
    """Enumeration of supported swarm agent types.

    Each agent type specializes in a specific domain of analysis:
    """
    CODE_REVIEWER = "code-reviewer"
    SECURITY_AUDITOR = "security-auditor"
    TEST_ENGINEER = "test-engineer"
    WEB_PERFORMANCE = "web-performance"
    PAYMENT_AGENT = "payment-agent"
    CUSTOM = "custom"


class AgentStatus(str, Enum):
    """Enumeration of possible agent states.

    - INACTIVE: Agent is registered but not running
    - STARTING: Agent is initializing
    - ACTIVE: Agent is running and ready to receive tasks
    - BUSY: Agent is processing a task
    - ERROR: Agent encountered an error
    - STOPPING: Agent is shutting down
    - OFFLINE: Agent connection lost
    """
    INACTIVE = "inactive"
    STARTING = "starting"
    ACTIVE = "active"
    BUSY = "busy"
    ERROR = "error"
    STOPPING = "stopping"
    OFFLINE = "offline"


class SwarmMessageType(str, Enum):
    """Enumeration of WebSocket message types for swarm communication."""
    # Client -> Server
    AUTH = "auth"
    TASK_DISPATCH = "task_dispatch"
    HEARTBEAT = "heartbeat"
    AGENT_ACTIVATE = "agent_activate"
    AGENT_DEACTIVATE = "agent_deactivate"
    AGENT_STATUS_REQUEST = "agent_status_request"
    REPO_SYNC = "repo_sync"

    # Server -> Client
    AUTH_RESPONSE = "auth_response"
    TASK_RESULT = "task_result"
    AGENT_UPDATE = "agent_update"
    HEARTBEAT_ACK = "heartbeat_ack"
    ERROR = "error"
    SYSTEM_NOTIFICATION = "system_notification"


class AgentInfo:
    """Information about a swarm agent.

    Attributes:
        agent_id: Unique agent identifier.
        agent_type: The type of agent.
        status: Current agent status.
        capabilities: List of agent capability strings.
        last_heartbeat: Timestamp of last heartbeat received.
        task_count: Number of tasks processed.
        error_count: Number of errors encountered.
        metadata: Additional agent metadata.
    """

    def __init__(
        self,
        agent_id: str,
        agent_type: AgentType,
        status: AgentStatus = AgentStatus.INACTIVE,
        capabilities: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        """Initialize AgentInfo.

        Args:
            agent_id: Unique agent identifier.
            agent_type: The type of agent.
            status: Initial agent status.
            capabilities: List of capability strings.
            metadata: Additional metadata dictionary.
        """
        self.agent_id: str = agent_id
        self.agent_type: AgentType = agent_type
        self.status: AgentStatus = status
        self.capabilities: list[str] = capabilities or []
        self.last_heartbeat: Optional[str] = None
        self.task_count: int = 0
        self.error_count: int = 0
        self.created_at: str = datetime.now(timezone.utc).isoformat()
        self.updated_at: str = self.created_at
        self.metadata: dict[str, Any] = metadata or {}

    def to_dict(self) -> dict[str, Any]:
        """Convert agent info to a dictionary.

        Returns:
            Dictionary representation of the agent.
        """
        return {
            "agent_id": self.agent_id,
            "agent_type": self.agent_type.value,
            "status": self.status.value,
            "capabilities": self.capabilities,
            "last_heartbeat": self.last_heartbeat,
            "task_count": self.task_count,
            "error_count": self.error_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentInfo:
        """Create AgentInfo from a dictionary.

        Args:
            data: Dictionary with agent data.

        Returns:
            A new AgentInfo instance.
        """
        agent = cls(
            agent_id=data["agent_id"],
            agent_type=AgentType(data.get("agent_type", "custom")),
            status=AgentStatus(data.get("status", "inactive")),
            capabilities=data.get("capabilities", []),
            metadata=data.get("metadata", {}),
        )
        agent.last_heartbeat = data.get("last_heartbeat")
        agent.task_count = data.get("task_count", 0)
        agent.error_count = data.get("error_count", 0)
        agent.created_at = data.get("created_at", agent.created_at)
        agent.updated_at = data.get("updated_at", agent.updated_at)
        return agent

    def update_status(self, new_status: AgentStatus) -> None:
        """Update the agent status and timestamp.

        Args:
            new_status: The new status to set.
        """
        self.status = new_status
        self.updated_at = datetime.now(timezone.utc).isoformat()


class SwarmConnector:
    """WebSocket connector for the JARVIS swarm orchestration system.

    Manages connections to swarm endpoints, dispatches tasks to agents,
    receives real-time updates, and monitors agent health through
    heartbeat and reconnection logic.

    Args:
        endpoint: WebSocket endpoint URL for the swarm server.
        encryption_key: Optional AES key for payload encryption.
        heartbeat_interval: Seconds between heartbeat messages.
        reconnect_max_retries: Maximum reconnection attempts.
        reconnect_base_delay: Base delay in seconds for backoff.
        reconnect_max_delay: Maximum delay in seconds for backoff.

    Example:
        >>> connector = SwarmConnector(endpoint="ws://localhost:8080/swarm")
        >>> connected = await connector.connect(auth_token="jwt-token")
        >>> result = await connector.dispatch_task(
        ...     task={"type": "code_review", "repo": "..."},
        ...     auth_token="jwt-token",
        ... )
        >>> async for update in connector.receive_updates():
        ...     print(update)
    """

    def __init__(
        self,
        endpoint: str = "ws://localhost:8080/swarm",
        encryption_key: Optional[bytes] = None,
        heartbeat_interval: float = 30.0,
        reconnect_max_retries: int = 10,
        reconnect_base_delay: float = 1.0,
        reconnect_max_delay: float = 60.0,
    ) -> None:
        """Initialize the SwarmConnector.

        Args:
            endpoint: WebSocket endpoint URL.
            encryption_key: AES-256 key for payload encryption.
            heartbeat_interval: Heartbeat interval in seconds.
            reconnect_max_retries: Max reconnection attempts.
            reconnect_base_delay: Base backoff delay in seconds.
            reconnect_max_delay: Maximum backoff delay in seconds.
        """
        self._endpoint: str = endpoint
        self._encryption_key: Optional[bytes] = encryption_key
        self._heartbeat_interval: float = heartbeat_interval
        self._reconnect_max_retries: int = reconnect_max_retries
        self._reconnect_base_delay: float = reconnect_base_delay
        self._reconnect_max_delay: float = reconnect_max_delay

        # Connection state
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._connected: bool = False
        self._authenticated: bool = False
        self._connection_id: Optional[str] = None
        self._auth_token: Optional[str] = None

        # Agent tracking
        self._agents: dict[str, AgentInfo] = {}
        self._agent_lock: asyncio.Lock = asyncio.Lock()

        # Task tracking
        self._pending_tasks: dict[str, dict[str, Any]] = {}
        self._completed_tasks: dict[str, dict[str, Any]] = {}
        self._task_lock: asyncio.Lock = asyncio.Lock()

        # Background tasks
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._receiver_task: Optional[asyncio.Task] = None
        self._reconnect_task: Optional[asyncio.Task] = None
        self._stop_event: asyncio.Event = asyncio.Event()

        # Reconnection state
        self._reconnect_attempts: int = 0
        self._reconnect_delay: float = self._reconnect_base_delay

        # Statistics
        self._stats: dict[str, int] = defaultdict(int)
        self._stats["messages_sent"] = 0
        self._stats["messages_received"] = 0
        self._stats["tasks_dispatched"] = 0
        self._stats["tasks_completed"] = 0
        self._stats["reconnections"] = 0
        self._stats["heartbeats_sent"] = 0
        self._stats["errors"] = 0

        # Initialize default agents
        self._init_default_agents()

        logger.info("SwarmConnector initialized: endpoint=%s", endpoint)

    def _init_default_agents(self) -> None:
        """Initialize the default set of swarm agents."""
        default_agents: list[tuple[str, AgentType, list[str]]] = [
            (
                "agent-code-reviewer-01",
                AgentType.CODE_REVIEWER,
                [
                    "code_analysis", "style_check", "bug_detection",
                    "complexity_analysis", "documentation_review",
                    "github_integration",
                ],
            ),
            (
                "agent-security-auditor-01",
                AgentType.SECURITY_AUDITOR,
                [
                    "vulnerability_scan", "dependency_audit", "secret_detection",
                    "compliance_check", "owasp_top10", "cve_lookup",
                ],
            ),
            (
                "agent-test-engineer-01",
                AgentType.TEST_ENGINEER,
                [
                    "unit_test_generation", "integration_testing",
                    "coverage_analysis", "mutation_testing", "load_testing",
                ],
            ),
            (
                "agent-web-perf-01",
                AgentType.WEB_PERFORMANCE,
                [
                    "lighthouse_audit", "core_web_vitals", "bundle_analysis",
                    "image_optimization", "caching_analysis",
                ],
            ),
            (
                "agent-payment-01",
                AgentType.PAYMENT_AGENT,
                [
                    "payment_validation", "pci_compliance", "fraud_detection",
                    "transaction_analysis", "refund_processing",
                ],
            ),
            (
                "agent-custom-01",
                AgentType.CUSTOM,
                [
                    "custom_task_execution", "data_processing",
                    "api_integration", "workflow_automation",
                ],
            ),
        ]

        for agent_id, agent_type, capabilities in default_agents:
            self._agents[agent_id] = AgentInfo(
                agent_id=agent_id,
                agent_type=agent_type,
                status=AgentStatus.INACTIVE,
                capabilities=capabilities,
                metadata={
                    "github_repo": GITHUB_REPO_URL,
                    "version": "2.0.0",
                },
            )

        logger.info("Initialized %d default swarm agents", len(default_agents))

    async def connect(self, auth_token: str) -> bool:
        """Connect to the swarm WebSocket endpoint with authentication.

        Establishes a WebSocket connection and sends an authentication
        message. Starts the heartbeat and message receiver loops.

        Args:
            auth_token: JWT authentication token.

        Returns:
            True if connection and authentication succeeded.
        """
        self._auth_token = auth_token

        try:
            self._session = aiohttp.ClientSession()
            self._ws = await self._session.ws_connect(
                self._endpoint,
                heartbeat=self._heartbeat_interval,
                compress=True,
            )
            self._connected = True
            self._connection_id = str(uuid.uuid4())
            self._stats["reconnections"] = 0
            self._reconnect_attempts = 0

            logger.info(
                "WebSocket connected to: %s (id=%s)",
                self._endpoint,
                self._connection_id,
            )

            # Send authentication message
            auth_message = {
                "type": SwarmMessageType.AUTH.value,
                "data": {
                    "token": auth_token,
                    "connection_id": self._connection_id,
                    "client_type": "jarvis-core",
                    "version": "2.0.0",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            }
            await self._send_message(auth_message)

            # Start background tasks
            self._stop_event.clear()
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            self._receiver_task = asyncio.create_task(self._receive_loop())

            # Wait briefly for auth response
            await asyncio.sleep(0.5)
            self._authenticated = True

            logger.info("Swarm connection authenticated")
            return True

        except aiohttp.ClientError as e:
            logger.error("WebSocket connection failed: %s", e)
            self._connected = False
            self._stats["errors"] += 1
            return False
        except Exception as e:
            logger.error("Unexpected connection error: %s", e)
            self._connected = False
            self._stats["errors"] += 1
            return False

    async def disconnect(self) -> None:
        """Disconnect from the swarm WebSocket endpoint.

        Stops background tasks, closes the WebSocket connection,
        and cleans up resources.
        """
        self._stop_event.set()
        self._connected = False
        self._authenticated = False

        # Cancel background tasks
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass

        if self._receiver_task and not self._receiver_task.done():
            self._receiver_task.cancel()
            try:
                await self._receiver_task
            except asyncio.CancelledError:
                pass

        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass

        # Close WebSocket
        if self._ws and not self._ws.closed:
            await self._ws.close()

        # Close session
        if self._session and not self._session.closed:
            await self._session.close()

        # Mark all agents as offline
        async with self._agent_lock:
            for agent in self._agents.values():
                if agent.status in (AgentStatus.ACTIVE, AgentStatus.BUSY):
                    agent.update_status(AgentStatus.OFFLINE)

        logger.info("Swarm disconnected")

    async def dispatch_task(
        self,
        task: dict[str, Any],
        auth_token: str,
    ) -> dict[str, Any]:
        """Dispatch a task to the swarm for processing.

        Encrypts the task payload and sends it via the WebSocket
        connection. The task is tracked until completion.

        Args:
            task: Task definition dictionary with 'type', 'target', and
                additional task-specific parameters.
            auth_token: JWT authentication token for the request.

        Returns:
            A dictionary with 'task_id', 'status', and dispatch details.

        Raises:
            ConnectionError: If not connected to the swarm.
        """
        if not self._connected or not self._ws:
            raise ConnectionError("Not connected to swarm. Call connect() first.")

        task_id = str(uuid.uuid4())
        task["task_id"] = task_id
        task["timestamp"] = datetime.now(timezone.utc).isoformat()
        task["auth_token_hash"] = hashlib_sha256(auth_token)

        # Encrypt task payload
        encrypted_payload = self._encrypt_payload(task) if self._encryption_key else task

        message = {
            "type": SwarmMessageType.TASK_DISPATCH.value,
            "data": {
                "task_id": task_id,
                "payload": encrypted_payload,
                "encrypted": self._encryption_key is not None,
                "target_agent": task.get("target_agent"),
                "priority": task.get("priority", "normal"),
            },
        }

        # Track the task
        async with self._task_lock:
            self._pending_tasks[task_id] = {
                "task_id": task_id,
                "task": task,
                "dispatched_at": datetime.now(timezone.utc).isoformat(),
                "status": "pending",
            }

        await self._send_message(message)
        self._stats["tasks_dispatched"] += 1

        logger.info("Task dispatched: %s (type=%s)", task_id, task.get("type"))
        return {
            "task_id": task_id,
            "status": "dispatched",
            "timestamp": task["timestamp"],
        }

    async def receive_updates(self) -> AsyncGenerator[dict[str, Any], None]:
        """Stream real-time updates from the swarm.

        Yields update messages as they arrive from the WebSocket
        connection. This is an async generator that runs until
        the connection is closed or an error occurs.

        Yields:
            Dictionary with update data including 'type', 'data', and
            optional 'agent_id' fields.
        """
        while self._connected and not self._stop_event.is_set():
            try:
                if self._ws and not self._ws.closed:
                    msg = await asyncio.wait_for(
                        self._ws.receive(), timeout=5.0
                    )

                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        self._stats["messages_received"] += 1

                        # Decrypt if needed
                        if data.get("encrypted"):
                            decrypted = self._decrypt_payload(data.get("payload", ""))
                            if decrypted:
                                data["payload"] = decrypted

                        # Process the message
                        processed = await self._process_incoming_message(data)
                        if processed:
                            yield processed

                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        logger.error("WebSocket error: %s", self._ws.exception())
                        self._stats["errors"] += 1
                        break

                    elif msg.type in (
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.CLOSING,
                        aiohttp.WSMsgType.CLOSED,
                    ):
                        logger.warning("WebSocket closed by server")
                        break

                else:
                    await asyncio.sleep(0.1)

            except asyncio.TimeoutError:
                continue
            except json.JSONDecodeError as e:
                logger.error("Invalid JSON in WebSocket message: %s", e)
                continue
            except Exception as e:
                logger.error("Error receiving updates: %s", e)
                self._stats["errors"] += 1
                await asyncio.sleep(1.0)

        # Attempt reconnection if not intentionally disconnected
        if not self._stop_event.is_set():
            asyncio.create_task(self._reconnect())

    async def _receive_loop(self) -> None:
        """Background task that continuously receives and processes messages."""
        try:
            async for update in self.receive_updates():
                await self._handle_update(update)
        except asyncio.CancelledError:
            logger.debug("Receive loop cancelled")
        except Exception as e:
            logger.error("Receive loop error: %s", e)

    async def _handle_update(self, update: dict[str, Any]) -> None:
        """Handle a received update message.

        Args:
            update: The update dictionary to process.
        """
        msg_type = update.get("type", "")

        if msg_type == SwarmMessageType.TASK_RESULT.value:
            task_id = update.get("data", {}).get("task_id")
            async with self._task_lock:
                if task_id in self._pending_tasks:
                    self._pending_tasks[task_id]["status"] = "completed"
                    self._completed_tasks[task_id] = {
                        **self._pending_tasks.pop(task_id),
                        "result": update.get("data"),
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                    }
                    self._stats["tasks_completed"] += 1

        elif msg_type == SwarmMessageType.AGENT_UPDATE.value:
            agent_id = update.get("data", {}).get("agent_id")
            if agent_id:
                async with self._agent_lock:
                    if agent_id in self._agents:
                        new_status = update.get("data", {}).get("status")
                        if new_status:
                            try:
                                self._agents[agent_id].update_status(
                                    AgentStatus(new_status)
                                )
                            except ValueError:
                                pass

    async def _heartbeat_loop(self) -> None:
        """Send periodic heartbeat messages to keep the connection alive.

        Runs as a background task, sending heartbeat messages at the
        configured interval. If a heartbeat fails, triggers reconnection.
        """
        try:
            while self._connected and not self._stop_event.is_set():
                await asyncio.sleep(self._heartbeat_interval)

                if self._connected and self._ws and not self._ws.closed:
                    heartbeat = {
                        "type": SwarmMessageType.HEARTBEAT.value,
                        "data": {
                            "connection_id": self._connection_id,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "agents_count": len(self._agents),
                            "pending_tasks": len(self._pending_tasks),
                        },
                    }
                    try:
                        await self._send_message(heartbeat)
                        self._stats["heartbeats_sent"] += 1
                        logger.debug("Heartbeat sent")
                    except Exception as e:
                        logger.error("Heartbeat failed: %s", e)
                        self._connected = False
                        asyncio.create_task(self._reconnect())
                        break

        except asyncio.CancelledError:
            logger.debug("Heartbeat loop cancelled")

    async def _reconnect(self) -> None:
        """Attempt to reconnect with exponential backoff and jitter.

        Implements the reconnection strategy with:
        - Exponential backoff: delay doubles each attempt
        - Jitter: random variation to prevent thundering herd
        - Maximum delay cap to prevent excessive waits
        - Maximum retry limit
        """
        while (
            self._reconnect_attempts < self._reconnect_max_retries
            and not self._stop_event.is_set()
        ):
            self._reconnect_attempts += 1

            # Calculate backoff with jitter
            delay = min(
                self._reconnect_base_delay * (2 ** (self._reconnect_attempts - 1)),
                self._reconnect_max_delay,
            )
            jitter = random.uniform(0, delay * 0.3)
            total_delay = delay + jitter

            logger.info(
                "Reconnect attempt %d/%d in %.1fs",
                self._reconnect_attempts,
                self._reconnect_max_retries,
                total_delay,
            )

            await asyncio.sleep(total_delay)

            # Clean up old connection
            if self._ws and not self._ws.closed:
                await self._ws.close()
            if self._session and not self._session.closed:
                await self._session.close()

            # Attempt reconnection
            if self._auth_token:
                success = await self.connect(self._auth_token)
                if success:
                    self._stats["reconnections"] += 1
                    logger.info("Reconnection successful on attempt %d",
                                self._reconnect_attempts)
                    return

        logger.error(
            "Reconnection failed after %d attempts",
            self._reconnect_attempts,
        )

    async def _send_message(self, message: dict[str, Any]) -> None:
        """Send a JSON message through the WebSocket connection.

        Args:
            message: The message dictionary to send.

        Raises:
            ConnectionError: If the WebSocket is not connected.
        """
        if not self._ws or self._ws.closed:
            raise ConnectionError("WebSocket not connected")

        payload = json.dumps(message, default=str)
        await self._ws.send_str(payload)
        self._stats["messages_sent"] += 1

    def _encrypt_payload(self, data: dict[str, Any]) -> str:
        """Encrypt a task payload using AES-256-GCM.

        Args:
            data: The payload dictionary to encrypt.

        Returns:
            Base64-encoded encrypted payload string.
        """
        if not self._encryption_key:
            return json.dumps(data)

        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            aesgcm = AESGCM(self._encryption_key)
            nonce = os.urandom(12)
            plaintext = json.dumps(data).encode("utf-8")
            ciphertext = aesgcm.encrypt(nonce, plaintext, associated_data=None)
            encrypted = nonce + ciphertext
            return base64.b64encode(encrypted).decode("utf-8")
        except Exception as e:
            logger.error("Payload encryption failed: %s", e)
            return json.dumps(data)

    def _decrypt_payload(self, encrypted_data: str) -> Optional[dict[str, Any]]:
        """Decrypt an AES-256-GCM encrypted payload.

        Args:
            encrypted_data: Base64-encoded encrypted payload.

        Returns:
            The decrypted payload dictionary, or None on failure.
        """
        if not self._encryption_key or not encrypted_data:
            return None

        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            aesgcm = AESGCM(self._encryption_key)
            encrypted = base64.b64decode(encrypted_data)
            nonce = encrypted[:12]
            ciphertext = encrypted[12:]
            plaintext = aesgcm.decrypt(nonce, ciphertext, associated_data=None)
            return json.loads(plaintext.decode("utf-8"))
        except Exception as e:
            logger.error("Payload decryption failed: %s", e)
            return None

    async def _process_incoming_message(
        self, data: dict[str, Any]
    ) -> Optional[dict[str, Any]]:
        """Process an incoming WebSocket message.

        Args:
            data: The raw message dictionary.

        Returns:
            Processed message dictionary, or None if no action needed.
        """
        msg_type = data.get("type", "")

        if msg_type == SwarmMessageType.AUTH_RESPONSE.value:
            success = data.get("data", {}).get("authenticated", False)
            self._authenticated = success
            if success:
                logger.info("Swarm authentication confirmed")
            else:
                logger.error("Swarm authentication rejected")
            return None

        elif msg_type == SwarmMessageType.HEARTBEAT_ACK.value:
            logger.debug("Heartbeat acknowledged")
            return None

        elif msg_type == SwarmMessageType.ERROR.value:
            error_data = data.get("data", {})
            logger.error(
                "Swarm error: %s", error_data.get("message", "unknown")
            )
            self._stats["errors"] += 1
            return data

        elif msg_type == SwarmMessageType.SYSTEM_NOTIFICATION.value:
            notification = data.get("data", {})
            logger.info(
                "System notification: %s",
                notification.get("message", ""),
            )
            return data

        elif msg_type == SwarmMessageType.AGENT_UPDATE.value:
            return data

        elif msg_type == SwarmMessageType.TASK_RESULT.value:
            return data

        else:
            logger.warning("Unknown message type: %s", msg_type)
            return data

    # ─── Agent Management ─────────────────────────────────────────────────

    async def activate_agent(self, agent_id: str) -> dict[str, Any]:
        """Activate a swarm agent.

        Sends an activation request for the specified agent. The agent
        transitions from INACTIVE to STARTING, then to ACTIVE once
        the swarm confirms activation.

        Args:
            agent_id: The unique identifier of the agent to activate.

        Returns:
            A dictionary with activation status and agent details.
        """
        async with self._agent_lock:
            if agent_id not in self._agents:
                return {
                    "success": False,
                    "error": f"Agent not found: {agent_id}",
                    "agent_id": agent_id,
                }

            agent = self._agents[agent_id]

        if agent.status == AgentStatus.ACTIVE:
            return {
                "success": True,
                "message": "Agent already active",
                "agent": agent.to_dict(),
            }

        # Send activation message
        if self._connected and self._ws:
            message = {
                "type": SwarmMessageType.AGENT_ACTIVATE.value,
                "data": {
                    "agent_id": agent_id,
                    "agent_type": agent.agent_type.value,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            }
            await self._send_message(message)

        # Update local status
        async with self._agent_lock:
            agent.update_status(AgentStatus.STARTING)
            agent.metadata["activated_at"] = datetime.now(timezone.utc).isoformat()

        logger.info("Agent activation requested: %s", agent_id)
        return {
            "success": True,
            "message": "Agent activation requested",
            "agent_id": agent_id,
            "status": AgentStatus.STARTING.value,
        }

    async def deactivate_agent(self, agent_id: str) -> dict[str, Any]:
        """Deactivate a swarm agent.

        Sends a deactivation request for the specified agent. The agent
        transitions to STOPPING, then to INACTIVE.

        Args:
            agent_id: The unique identifier of the agent to deactivate.

        Returns:
            A dictionary with deactivation status and agent details.
        """
        async with self._agent_lock:
            if agent_id not in self._agents:
                return {
                    "success": False,
                    "error": f"Agent not found: {agent_id}",
                    "agent_id": agent_id,
                }

            agent = self._agents[agent_id]

        if agent.status == AgentStatus.INACTIVE:
            return {
                "success": True,
                "message": "Agent already inactive",
                "agent": agent.to_dict(),
            }

        # Send deactivation message
        if self._connected and self._ws:
            message = {
                "type": SwarmMessageType.AGENT_DEACTIVATE.value,
                "data": {
                    "agent_id": agent_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            }
            await self._send_message(message)

        # Update local status
        async with self._agent_lock:
            agent.update_status(AgentStatus.STOPPING)
            agent.metadata["deactivated_at"] = datetime.now(timezone.utc).isoformat()

        logger.info("Agent deactivation requested: %s", agent_id)
        return {
            "success": True,
            "message": "Agent deactivation requested",
            "agent_id": agent_id,
            "status": AgentStatus.STOPPING.value,
        }

    async def get_agent_status(self, agent_id: str) -> dict[str, Any]:
        """Get the current status of a specific agent.

        Args:
            agent_id: The unique identifier of the agent.

        Returns:
            A dictionary with the agent's status information.
        """
        async with self._agent_lock:
            if agent_id not in self._agents:
                return {
                    "success": False,
                    "error": f"Agent not found: {agent_id}",
                }

            agent = self._agents[agent_id]
            return {
                "success": True,
                "agent": agent.to_dict(),
            }

    async def get_all_agents(self) -> list[dict[str, Any]]:
        """Get the status of all registered agents.

        Returns:
            A list of agent status dictionaries.
        """
        async with self._agent_lock:
            return [agent.to_dict() for agent in self._agents.values()]

    async def get_active_agents(self) -> list[dict[str, Any]]:
        """Get only active agents.

        Returns:
            A list of active agent status dictionaries.
        """
        async with self._agent_lock:
            return [
                agent.to_dict()
                for agent in self._agents.values()
                if agent.status == AgentStatus.ACTIVE
            ]

    async def get_agents_by_type(self, agent_type: AgentType) -> list[dict[str, Any]]:
        """Get agents filtered by type.

        Args:
            agent_type: The agent type to filter by.

        Returns:
            A list of agent dictionaries matching the type.
        """
        async with self._agent_lock:
            return [
                agent.to_dict()
                for agent in self._agents.values()
                if agent.agent_type == agent_type
            ]

    # ─── GitHub Integration ───────────────────────────────────────────────

    async def sync_github_repo(self) -> dict[str, Any]:
        """Trigger synchronization with the configured GitHub repository.

        Sends a repo_sync message to the swarm to update code context
        from the integrated GitHub repository.

        Returns:
            A dictionary with sync status.
        """
        if not self._connected or not self._ws:
            return {
                "success": False,
                "error": "Not connected to swarm",
            }

        message = {
            "type": SwarmMessageType.REPO_SYNC.value,
            "data": {
                "repo_url": GITHUB_REPO_URL,
                "repo_api_url": GITHUB_API_URL,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        }
        await self._send_message(message)

        logger.info("GitHub repo sync requested: %s", GITHUB_REPO_URL)
        return {
            "success": True,
            "message": "Repository sync requested",
            "repo_url": GITHUB_REPO_URL,
        }

    async def get_github_repo_info(self) -> dict[str, Any]:
        """Fetch information about the integrated GitHub repository.

        Returns:
            A dictionary with repository metadata.
        """
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(GITHUB_API_URL) as response:
                    if response.status == 200:
                        data = await response.json()
                        return {
                            "success": True,
                            "repo": {
                                "name": data.get("name"),
                                "description": data.get("description"),
                                "url": data.get("html_url"),
                                "stars": data.get("stargazers_count"),
                                "forks": data.get("forks_count"),
                                "language": data.get("language"),
                                "updated_at": data.get("updated_at"),
                            },
                        }
                    return {
                        "success": False,
                        "error": f"GitHub API returned {response.status}",
                    }
        except Exception as e:
            logger.error("GitHub API error: %s", e)
            return {"success": False, "error": str(e)}

    # ─── Task Management ──────────────────────────────────────────────────

    async def get_task_status(self, task_id: str) -> Optional[dict[str, Any]]:
        """Get the status of a dispatched task.

        Args:
            task_id: The unique task identifier.

        Returns:
            The task status dictionary, or None if not found.
        """
        async with self._task_lock:
            if task_id in self._pending_tasks:
                return self._pending_tasks[task_id]
            if task_id in self._completed_tasks:
                return self._completed_tasks[task_id]
        return None

    async def get_pending_tasks(self) -> list[dict[str, Any]]:
        """Get all currently pending tasks.

        Returns:
            A list of pending task dictionaries.
        """
        async with self._task_lock:
            return list(self._pending_tasks.values())

    async def get_completed_tasks(self) -> list[dict[str, Any]]:
        """Get all completed tasks.

        Returns:
            A list of completed task dictionaries.
        """
        async with self._task_lock:
            return list(self._completed_tasks.values())

    # ─── Status and Statistics ────────────────────────────────────────────

    def get_status(self) -> dict[str, Any]:
        """Return the current connector status.

        Returns:
            A dictionary with connection status and statistics.
        """
        return {
            "connected": self._connected,
            "authenticated": self._authenticated,
            "connection_id": self._connection_id,
            "endpoint": self._endpoint,
            "reconnect_attempts": self._reconnect_attempts,
            "agents": {
                "total": len(self._agents),
                "active": sum(
                    1 for a in self._agents.values()
                    if a.status == AgentStatus.ACTIVE
                ),
                "inactive": sum(
                    1 for a in self._agents.values()
                    if a.status == AgentStatus.INACTIVE
                ),
            },
            "tasks": {
                "pending": len(self._pending_tasks),
                "completed": len(self._completed_tasks),
            },
            "stats": dict(self._stats),
            "github_repo": GITHUB_REPO_URL,
        }

    def __repr__(self) -> str:
        """Return a string representation of the SwarmConnector."""
        return (
            f"SwarmConnector(endpoint={self._endpoint!r}, "
            f"connected={self._connected}, "
            f"agents={len(self._agents)})"
        )


def hashlib_sha256(text: str) -> str:
    """Compute SHA-256 hash of a string.

    Args:
        text: The input string.

    Returns:
        The hex-encoded SHA-256 hash.
    """
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
