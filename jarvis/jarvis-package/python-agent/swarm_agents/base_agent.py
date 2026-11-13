"""JARVIS Swarm Agent - Base Agent

Abstract base class for all swarm agents with lifecycle management,
metrics tracking, and status reporting.
"""
import abc
import logging
import time
import uuid
from enum import Enum
from typing import Any, Dict, List, Optional


class AgentStatus(str, Enum):
    """Agent lifecycle status enumeration."""
    IDLE = "idle"
    ACTIVE = "active"
    PROCESSING = "processing"
    ERROR = "error"


class BaseAgent(abc.ABC):
    """Abstract base class for JARVIS swarm agents.

    Provides lifecycle management (activate/deactivate), status tracking,
    metrics collection, and logging infrastructure. All concrete agents
    must implement execute() and get_capabilities().

    Attributes:
        agent_id: Unique agent identifier.
        name: Human-readable agent name.
        description: Agent description.
        status: Current agent status.
        config: Agent configuration dict.
        created_at: Timestamp of agent creation.
        activated_at: Timestamp of most recent activation.
        logger: Agent-specific logger instance.
    """

    def __init__(
        self,
        agent_id: Optional[str] = None,
        name: str = "BaseAgent",
        description: str = "",
        config: Optional[Dict[str, Any]] = None,
    ):
        """Initialize the base agent.

        Args:
            agent_id: Unique agent identifier (auto-generated if not provided).
            name: Human-readable agent name.
            description: Agent description.
            config: Agent configuration dictionary.
        """
        self.agent_id = agent_id or str(uuid.uuid4())
        self.name = name
        self.description = description
        self.status = AgentStatus.IDLE
        self.config = config or {}

        # Timestamps
        self.created_at = time.time()
        self.activated_at: Optional[float] = None
        self.last_activity: Optional[float] = None

        # Metrics
        self._tasks_completed = 0
        self._tasks_failed = 0
        self._total_processing_time = 0.0
        self._error_count = 0
        self._last_error: Optional[str] = None

        # Logger
        self.logger = logging.getLogger(f"jarvis.swarm.{self.name}")

        # State
        self._state: Dict[str, Any] = {}

    # -------------------------------------------------------------------
    # Abstract Methods
    # -------------------------------------------------------------------

    @abc.abstractmethod
    async def execute(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a task assigned to this agent.

        Args:
            task: Task definition with type, params, and metadata.

        Returns:
            Task result dictionary with at minimum a 'success' key.
        """
        raise NotImplementedError

    @abc.abstractmethod
    def get_capabilities(self) -> List[Dict[str, Any]]:
        """Return the list of capabilities this agent provides.

        Returns:
            List of capability dictionaries, each with 'name', 'description',
            and 'parameters' keys.
        """
        raise NotImplementedError

    # -------------------------------------------------------------------
    # Lifecycle Methods
    # -------------------------------------------------------------------

    async def activate(self, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Activate the agent for task processing.

        Transitions the agent from IDLE to ACTIVE status and initializes
        any resources needed for task processing.

        Args:
            config: Optional configuration overrides.

        Returns:
            Activation result with status and metadata.
        """
        if self.status == AgentStatus.ACTIVE:
            self.logger.warning("Agent %s is already active", self.agent_id)
            return {
                "success": True,
                "agent_id": self.agent_id,
                "status": self.status.value,
                "message": "Agent was already active",
            }

        try:
            # Apply configuration overrides
            if config:
                self.config.update(config)

            # Call subclass initialization hook
            await self._on_activate()

            # Update status
            self.status = AgentStatus.ACTIVE
            self.activated_at = time.time()
            self.last_activity = time.time()

            self.logger.info(
                "Agent %s (%s) activated", self.agent_id, self.name,
            )

            return {
                "success": True,
                "agent_id": self.agent_id,
                "status": self.status.value,
                "activated_at": self.activated_at,
            }

        except Exception as exc:
            self.status = AgentStatus.ERROR
            self._error_count += 1
            self._last_error = str(exc)
            self.logger.error("Failed to activate agent %s: %s", self.agent_id, exc)
            return {
                "success": False,
                "agent_id": self.agent_id,
                "status": self.status.value,
                "error": str(exc),
            }

    async def deactivate(self, cleanup: bool = True, save_state: bool = True) -> Dict[str, Any]:
        """Deactivate the agent and release resources.

        Transitions the agent from ACTIVE/PROCESSING to IDLE status.

        Args:
            cleanup: Whether to clean up resources.
            save_state: Whether to persist agent state.

        Returns:
            Deactivation result with final metrics.
        """
        if self.status == AgentStatus.IDLE:
            self.logger.warning("Agent %s is already idle", self.agent_id)
            return {
                "success": True,
                "agent_id": self.agent_id,
                "status": self.status.value,
                "message": "Agent was already idle",
            }

        try:
            # Save state before deactivating
            if save_state:
                self._state["last_metrics"] = self.get_metrics()
                self._state["deactivated_at"] = time.time()

            # Call subclass cleanup hook
            if cleanup:
                await self._on_deactivate()

            # Update status
            previous_status = self.status
            self.status = AgentStatus.IDLE
            self.last_activity = time.time()

            self.logger.info(
                "Agent %s (%s) deactivated (was %s)",
                self.agent_id, self.name, previous_status.value,
            )

            return {
                "success": True,
                "agent_id": self.agent_id,
                "status": self.status.value,
                "final_metrics": self.get_metrics(),
            }

        except Exception as exc:
            self.status = AgentStatus.ERROR
            self._error_count += 1
            self._last_error = str(exc)
            self.logger.error("Failed to deactivate agent %s: %s", self.agent_id, exc)
            return {
                "success": False,
                "agent_id": self.agent_id,
                "status": self.status.value,
                "error": str(exc),
            }

    async def _on_activate(self) -> None:
        """Hook called during activation. Override in subclasses for custom init."""
        pass

    async def _on_deactivate(self) -> None:
        """Hook called during deactivation. Override in subclasses for custom cleanup."""
        pass

    # -------------------------------------------------------------------
    # Status and Metrics
    # -------------------------------------------------------------------

    def update_status(self, new_status: AgentStatus) -> None:
        """Update the agent status.

        Args:
            new_status: New agent status.
        """
        old_status = self.status
        self.status = new_status
        self.last_activity = time.time()
        self.logger.debug(
            "Agent %s status changed: %s -> %s",
            self.agent_id, old_status.value, new_status.value,
        )

    def get_status(self) -> Dict[str, Any]:
        """Get the current agent status and basic info.

        Returns:
            Status dictionary with agent info and current status.
        """
        return {
            "agent_id": self.agent_id,
            "name": self.name,
            "description": self.description,
            "status": self.status.value,
            "created_at": self.created_at,
            "activated_at": self.activated_at,
            "last_activity": self.last_activity,
            "uptime_seconds": self._calculate_uptime(),
        }

    def get_metrics(self) -> Dict[str, Any]:
        """Get agent performance metrics.

        Returns:
            Metrics dictionary with task counts, timing, and error stats.
        """
        avg_time = (
            self._total_processing_time / self._tasks_completed
            if self._tasks_completed > 0
            else 0.0
        )

        return {
            "agent_id": self.agent_id,
            "name": self.name,
            "status": self.status.value,
            "tasks_completed": self._tasks_completed,
            "tasks_failed": self._tasks_failed,
            "total_processing_time": round(self._total_processing_time, 3),
            "avg_processing_time": round(avg_time, 3),
            "error_count": self._error_count,
            "last_error": self._last_error,
            "uptime_seconds": self._calculate_uptime(),
        }

    def _calculate_uptime(self) -> float:
        """Calculate agent uptime in seconds.

        Returns:
            Uptime in seconds since activation, or 0 if not activated.
        """
        if self.activated_at is None:
            return 0.0
        return round(time.time() - self.activated_at, 2)

    # -------------------------------------------------------------------
    # Task Execution Wrapper
    # -------------------------------------------------------------------

    async def run_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a task with full metrics tracking and error handling.

        This method wraps the abstract execute() method with status
        transitions, timing, and error recovery.

        Args:
            task: Task definition dictionary.

        Returns:
            Task result dictionary with metrics.
        """
        if self.status not in (AgentStatus.ACTIVE, AgentStatus.IDLE):
            return {
                "success": False,
                "error": f"Agent is not available (status: {self.status.value})",
                "agent_id": self.agent_id,
            }

        start_time = time.time()
        previous_status = self.status
        self.update_status(AgentStatus.PROCESSING)

        try:
            self.logger.info(
                "Agent %s executing task: %s",
                self.agent_id, task.get("type", "unknown"),
            )

            result = await self.execute(task)

            # Track success metrics
            elapsed = time.time() - start_time
            self._tasks_completed += 1
            self._total_processing_time += elapsed

            # Restore previous status
            self.update_status(previous_status if previous_status == AgentStatus.ACTIVE else AgentStatus.IDLE)

            # Enrich result with metadata
            result["agent_id"] = self.agent_id
            result["processing_time"] = round(elapsed, 3)
            result["tasks_completed"] = self._tasks_completed

            self.logger.info(
                "Agent %s completed task in %.3fs",
                self.agent_id, elapsed,
            )

            return result

        except Exception as exc:
            elapsed = time.time() - start_time
            self._tasks_failed += 1
            self._error_count += 1
            self._last_error = str(exc)

            self.update_status(AgentStatus.ERROR)
            self.logger.error(
                "Agent %s task failed after %.3fs: %s",
                self.agent_id, elapsed, exc,
            )

            # Auto-recover from error status after a brief moment
            self.update_status(AgentStatus.ACTIVE if previous_status == AgentStatus.ACTIVE else AgentStatus.IDLE)

            return {
                "success": False,
                "error": str(exc),
                "agent_id": self.agent_id,
                "processing_time": round(elapsed, 3),
            }

    # -------------------------------------------------------------------
    # State Management
    # -------------------------------------------------------------------

    def set_state(self, key: str, value: Any) -> None:
        """Set a state value.

        Args:
            key: State key.
            value: State value.
        """
        self._state[key] = value

    def get_state(self, key: str, default: Any = None) -> Any:
        """Get a state value.

        Args:
            key: State key.
            default: Default value if key not found.

        Returns:
            State value or default.
        """
        return self._state.get(key, default)

    def clear_state(self) -> None:
        """Clear all agent state."""
        self._state.clear()

    # -------------------------------------------------------------------
    # Representation
    # -------------------------------------------------------------------

    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__}(id={self.agent_id[:8]}, "
            f"name={self.name}, status={self.status.value})>"
        )

    def __str__(self) -> str:
        return f"{self.name} ({self.agent_id[:8]}) [{self.status.value}]"
