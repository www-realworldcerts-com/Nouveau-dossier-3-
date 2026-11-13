"""JARVIS Swarm Agent - Custom Agent

Configurable custom agent that can be tailored for any task through
configuration, scripting, and integration capabilities.
"""
import asyncio
import logging
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from .base_agent import BaseAgent, AgentStatus

logger = logging.getLogger("jarvis.swarm.custom_agent")


class CustomAgent(BaseAgent):
    """Configurable custom agent for arbitrary tasks.

    Capabilities:
    - Custom task execution through registered handlers
    - Dynamic configuration and reconfiguration
    - Integration with external services
    - Task automation and scheduling
    - Custom pipeline composition
    - Plugin-style extensibility

    The CustomAgent is designed to be the most flexible agent in the
    swarm, allowing users to define custom behavior through configuration
    and handler registration.

    Attributes:
        handlers: Registered task handlers.
        integrations: Active service integrations.
        pipelines: Defined execution pipelines.
        schedule: Scheduled recurring tasks.
    """

    # Built-in handler templates
    BUILTIN_HANDLERS = {
        "echo": {
            "description": "Echo back the input",
            "handler": "_handle_echo",
        },
        "transform": {
            "description": "Apply a transformation to input data",
            "handler": "_handle_transform",
        },
        "validate": {
            "description": "Validate input against a schema",
            "handler": "_handle_validate",
        },
        "aggregate": {
            "description": "Aggregate multiple data sources",
            "handler": "_handle_aggregate",
        },
        "filter": {
            "description": "Filter data based on conditions",
            "handler": "_handle_filter",
        },
        "notify": {
            "description": "Send a notification",
            "handler": "_handle_notify",
        },
        "log": {
            "description": "Log data for debugging or audit",
            "handler": "_handle_log",
        },
        "delay": {
            "description": "Introduce a delay (for testing/scheduling)",
            "handler": "_handle_delay",
        },
    }

    # Transformation functions
    TRANSFORMS = {
        "uppercase": lambda x: str(x).upper(),
        "lowercase": lambda x: str(x).lower(),
        "trim": lambda x: str(x).strip(),
        "reverse": lambda x: str(x)[::-1],
        "length": lambda x: len(x) if hasattr(x, "__len__") else 0,
        "type": lambda x: type(x).__name__,
        "json_parse": lambda x: __import__("json").loads(str(x)) if isinstance(x, str) else x,
        "json_stringify": lambda x: __import__("json").dumps(x) if not isinstance(x, str) else x,
    }

    def __init__(
        self,
        agent_id: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(
            agent_id=agent_id,
            name="CustomAgent",
            description="Configurable custom agent for arbitrary task execution, integration, and automation",
            config=config,
        )
        # Registered custom handlers
        self._handlers: Dict[str, Dict[str, Any]] = {}
        # Active integrations
        self._integrations: Dict[str, Dict[str, Any]] = {}
        # Defined pipelines
        self._pipelines: Dict[str, List[Dict[str, Any]]] = {}
        # Scheduled tasks
        self._schedule: Dict[str, Dict[str, Any]] = {}
        # Task results storage
        self._task_results: Dict[str, Dict[str, Any]] = {}

        # Register built-in handlers
        for name, definition in self.BUILTIN_HANDLERS.items():
            self._handlers[name] = definition

        # Apply initial configuration
        if config:
            self._apply_config(config)

    async def execute(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a custom task.

        Dispatches the task to the appropriate handler based on the
        task type. Supports built-in handlers, custom registered handlers,
        and pipeline execution.

        Args:
            task: Task dict with 'type' and relevant parameters.

        Returns:
            Task execution result.
        """
        task_type = task.get("type", "echo")

        if task_type == "execute_custom_task":
            return await self.execute_custom_task(
                handler=task.get("handler", "echo"),
                params=task.get("params", {}),
            )
        elif task_type == "configure":
            return await self.configure(
                config=task.get("config", {}),
            )
        elif task_type == "integrate":
            return await self.integrate(
                service=task.get("service", ""),
                config=task.get("service_config", {}),
            )
        elif task_type == "automate":
            return await self.automate(
                pipeline=task.get("pipeline", ""),
                schedule=task.get("schedule"),
            )
        elif task_type == "run_pipeline":
            return await self.run_pipeline(
                pipeline=task.get("pipeline", ""),
                input_data=task.get("input_data", {}),
            )
        else:
            # Try to find a handler with this name
            return await self.execute_custom_task(
                handler=task_type,
                params=task.get("params", task),
            )

    def get_capabilities(self) -> List[Dict[str, Any]]:
        """Return agent capabilities."""
        return [
            {
                "name": "execute_custom_task",
                "description": "Execute a task using a registered handler",
                "parameters": {
                    "handler": {"type": "string", "required": True, "description": "Handler name to execute"},
                    "params": {"type": "object", "required": False, "default": {}},
                },
            },
            {
                "name": "configure",
                "description": "Update agent configuration dynamically",
                "parameters": {
                    "config": {"type": "object", "required": True, "description": "Configuration updates"},
                },
            },
            {
                "name": "integrate",
                "description": "Set up integration with an external service",
                "parameters": {
                    "service": {"type": "string", "required": True, "description": "Service name"},
                    "service_config": {"type": "object", "required": False, "default": {}},
                },
            },
            {
                "name": "automate",
                "description": "Set up automated pipeline execution",
                "parameters": {
                    "pipeline": {"type": "string", "required": True, "description": "Pipeline name to automate"},
                    "schedule": {"type": "string", "required": False, "description": "Cron-style schedule"},
                },
            },
            {
                "name": "run_pipeline",
                "description": "Execute a defined pipeline",
                "parameters": {
                    "pipeline": {"type": "string", "required": True, "description": "Pipeline name"},
                    "input_data": {"type": "object", "required": False, "default": {}},
                },
            },
        ]

    async def execute_custom_task(
        self,
        handler: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute a task using a registered handler.

        Args:
            handler: Name of the handler to use.
            params: Parameters to pass to the handler.

        Returns:
            Handler execution result.
        """
        start_time = time.time()
        params = params or {}

        if handler not in self._handlers:
            return {
                "success": False,
                "error": f"Unknown handler: {handler}. Available: {list(self._handlers.keys())}",
            }

        handler_def = self._handlers[handler]
        handler_method_name = handler_def.get("handler")

        # Handle built-in methods
        if handler_method_name and handler_method_name.startswith("_handle_"):
            method = getattr(self, handler_method_name, None)
            if method:
                try:
                    if asyncio.iscoroutinefunction(method):
                        result = await method(params)
                    else:
                        result = method(params)

                    elapsed = time.time() - start_time
                    task_id = str(uuid.uuid4())[:8]

                    self._task_results[task_id] = {
                        "handler": handler,
                        "params": params,
                        "result": result,
                        "processing_time": elapsed,
                    }

                    return {
                        "success": True,
                        "handler": handler,
                        "result": result,
                        "processing_time": round(elapsed, 3),
                    }
                except Exception as exc:
                    return {
                        "success": False,
                        "handler": handler,
                        "error": str(exc),
                    }

        # Handle custom callable handlers
        custom_callable = handler_def.get("callable")
        if custom_callable and callable(custom_callable):
            try:
                if asyncio.iscoroutinefunction(custom_callable):
                    result = await custom_callable(params)
                else:
                    result = custom_callable(params)

                elapsed = time.time() - start_time
                return {
                    "success": True,
                    "handler": handler,
                    "result": result,
                    "processing_time": round(elapsed, 3),
                }
            except Exception as exc:
                return {
                    "success": False,
                    "handler": handler,
                    "error": str(exc),
                }

        return {
            "success": False,
            "handler": handler,
            "error": "Handler has no executable method",
        }

    async def configure(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Update agent configuration dynamically.

        Supports adding handlers, pipelines, integrations, and general settings.

        Args:
            config: Configuration updates.

        Returns:
            Configuration result with summary of changes.
        """
        self.logger.info("Configuring CustomAgent with %d keys", len(config))

        changes = []

        # Register new handlers
        for handler_name, handler_def in config.get("handlers", {}).items():
            self._handlers[handler_name] = handler_def
            changes.append(f"Registered handler: {handler_name}")

        # Define pipelines
        for pipeline_name, steps in config.get("pipelines", {}).items():
            self._pipelines[pipeline_name] = steps
            changes.append(f"Defined pipeline: {pipeline_name} ({len(steps)} steps)")

        # Set up integrations
        for service_name, service_config in config.get("integrations", {}).items():
            self._integrations[service_name] = {
                "config": service_config,
                "status": "configured",
                "created_at": time.time(),
            }
            changes.append(f"Configured integration: {service_name}")

        # Update general config
        general = config.get("settings", {})
        if general:
            self.config.update(general)
            changes.append(f"Updated {len(general)} settings")

        # Apply schedule
        for task_name, schedule_config in config.get("schedule", {}).items():
            self._schedule[task_name] = schedule_config
            changes.append(f"Scheduled task: {task_name}")

        return {
            "success": True,
            "changes": changes,
            "change_count": len(changes),
            "handlers": list(self._handlers.keys()),
            "pipelines": list(self._pipelines.keys()),
            "integrations": list(self._integrations.keys()),
        }

    async def integrate(
        self,
        service: str,
        config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Set up integration with an external service.

        Args:
            service: Service name or type.
            config: Service configuration.

        Returns:
            Integration result.
        """
        config = config or {}

        self.logger.info("Setting up integration: %s", service)

        integration_id = str(uuid.uuid4())[:8]
        integration = {
            "id": integration_id,
            "service": service,
            "config": config,
            "status": "active",
            "created_at": time.time(),
            "last_used": None,
        }

        # Validate integration configuration
        required_fields = self._get_required_fields(service)
        missing = [f for f in required_fields if f not in config]
        if missing:
            integration["status"] = "incomplete"
            integration["missing_fields"] = missing

        self._integrations[integration_id] = integration

        return {
            "success": integration["status"] == "active",
            "integration_id": integration_id,
            "service": service,
            "status": integration["status"],
            "missing_fields": missing if missing else [],
        }

    async def automate(
        self,
        pipeline: str,
        schedule: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Set up automated pipeline execution.

        Args:
            pipeline: Pipeline name to automate.
            schedule: Cron-style schedule expression.

        Returns:
            Automation setup result.
        """
        if pipeline not in self._pipelines:
            return {
                "success": False,
                "error": f"Pipeline not found: {pipeline}. Available: {list(self._pipelines.keys())}",
            }

        task_id = str(uuid.uuid4())[:8]
        automation = {
            "task_id": task_id,
            "pipeline": pipeline,
            "schedule": schedule,
            "status": "active",
            "created_at": time.time(),
            "last_run": None,
            "run_count": 0,
        }

        self._schedule[task_id] = automation

        return {
            "success": True,
            "task_id": task_id,
            "pipeline": pipeline,
            "schedule": schedule,
            "status": "active",
        }

    async def run_pipeline(
        self,
        pipeline: str,
        input_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute a defined pipeline.

        A pipeline consists of a sequence of handler steps that are
        executed in order, with the output of each step fed to the next.

        Args:
            pipeline: Pipeline name to execute.
            input_data: Initial input data for the pipeline.

        Returns:
            Pipeline execution result with step-by-step details.
        """
        start_time = time.time()
        input_data = input_data or {}

        if pipeline not in self._pipelines:
            return {
                "success": False,
                "error": f"Pipeline not found: {pipeline}. Available: {list(self._pipelines.keys())}",
            }

        steps = self._pipelines[pipeline]
        self.logger.info("Running pipeline '%s' with %d steps", pipeline, len(steps))

        current_data = input_data
        step_results = []
        pipeline_success = True

        for i, step in enumerate(steps):
            step_handler = step.get("handler", "echo")
            step_params = step.get("params", {})
            step_name = step.get("name", f"step_{i + 1}")

            # Merge step params with current data
            merged_params = {**step_params, **current_data}

            step_start = time.time()
            step_result = await self.execute_custom_task(step_handler, merged_params)
            step_elapsed = time.time() - step_start

            step_results.append({
                "step": step_name,
                "handler": step_handler,
                "success": step_result.get("success", False),
                "processing_time": round(step_elapsed, 3),
                "error": step_result.get("error"),
            })

            if not step_result.get("success", False):
                pipeline_success = False
                if step.get("continue_on_error", False):
                    current_data = step_result.get("result", {})
                else:
                    break
            else:
                current_data = step_result.get("result", {})

        elapsed = time.time() - start_time

        return {
            "success": pipeline_success,
            "pipeline": pipeline,
            "steps_completed": len(step_results),
            "total_steps": len(steps),
            "step_results": step_results,
            "output": current_data,
            "processing_time": round(elapsed, 3),
        }

    # -------------------------------------------------------------------
    # Built-in Handlers
    # -------------------------------------------------------------------

    async def _handle_echo(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Echo handler - returns the input parameters."""
        return {"echo": params}

    async def _handle_transform(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Transform handler - applies a transformation to input data."""
        data = params.get("data", params)
        transform = params.get("transform", "identity")

        if transform in self.TRANSFORMS:
            try:
                result = self.TRANSFORMS[transform](data)
                return {"transformed": result, "transform": transform}
            except Exception as exc:
                return {"error": str(exc), "transform": transform}
        else:
            return {"error": f"Unknown transform: {transform}. Available: {list(self.TRANSFORMS.keys())}"}

    async def _handle_validate(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Validate handler - validates input against a schema."""
        data = params.get("data", {})
        schema = params.get("schema", {})

        if not schema:
            return {"valid": True, "message": "No schema provided - all data is valid"}

        errors = []
        for field, rules in schema.items():
            if rules.get("required", False) and field not in data:
                errors.append(f"Missing required field: {field}")
                continue

            if field in data:
                value = data[field]
                expected_type = rules.get("type")
                if expected_type and type(value).__name__ != expected_type:
                    errors.append(f"Field '{field}' expected type {expected_type}, got {type(value).__name__}")

                min_val = rules.get("min")
                if min_val is not None and isinstance(value, (int, float)) and value < min_val:
                    errors.append(f"Field '{field}' value {value} is below minimum {min_val}")

                max_val = rules.get("max")
                if max_val is not None and isinstance(value, (int, float)) and value > max_val:
                    errors.append(f"Field '{field}' value {value} exceeds maximum {max_val}")

                pattern = rules.get("pattern")
                if pattern and isinstance(value, str):
                    import re
                    if not re.match(pattern, value):
                        errors.append(f"Field '{field}' does not match pattern: {pattern}")

        return {
            "valid": len(errors) == 0,
            "errors": errors,
            "fields_checked": len(schema),
        }

    async def _handle_aggregate(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Aggregate handler - combines data from multiple sources."""
        sources = params.get("sources", [])
        operation = params.get("operation", "merge")

        if not sources:
            return {"result": None, "message": "No sources to aggregate"}

        if operation == "merge":
            result = {}
            for source in sources:
                if isinstance(source, dict):
                    result.update(source)
            return {"result": result}

        elif operation == "concat":
            result = []
            for source in sources:
                if isinstance(source, list):
                    result.extend(source)
                else:
                    result.append(source)
            return {"result": result}

        elif operation == "sum":
            result = sum(s for s in sources if isinstance(s, (int, float)))
            return {"result": result}

        elif operation == "average":
            numeric = [s for s in sources if isinstance(s, (int, float))]
            result = sum(numeric) / len(numeric) if numeric else 0
            return {"result": result}

        else:
            return {"error": f"Unknown aggregation operation: {operation}"}

    async def _handle_filter(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Filter handler - filters data based on conditions."""
        data = params.get("data", [])
        conditions = params.get("conditions", {})

        if not isinstance(data, list):
            return {"error": "Filter data must be a list"}

        if not conditions:
            return {"result": data}

        filtered = []
        for item in data:
            if not isinstance(item, dict):
                continue

            match = True
            for field, condition in conditions.items():
                if field not in item:
                    match = False
                    break

                value = item[field]
                if isinstance(condition, dict):
                    if "eq" in condition and value != condition["eq"]:
                        match = False
                    if "ne" in condition and value == condition["ne"]:
                        match = False
                    if "gt" in condition and not (value > condition["gt"]):
                        match = False
                    if "lt" in condition and not (value < condition["lt"]):
                        match = False
                    if "contains" in condition and condition["contains"] not in str(value):
                        match = False
                elif value != condition:
                    match = False

            if match:
                filtered.append(item)

        return {"result": filtered, "original_count": len(data), "filtered_count": len(filtered)}

    async def _handle_notify(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Notify handler - sends a notification."""
        message = params.get("message", "")
        channel = params.get("channel", "log")
        priority = params.get("priority", "normal")

        self.logger.info("Notification [%s/%s]: %s", channel, priority, message)

        return {
            "sent": True,
            "channel": channel,
            "priority": priority,
            "message": message,
        }

    async def _handle_log(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Log handler - logs data for debugging or audit."""
        level = params.get("level", "info")
        message = params.get("message", str(params))

        log_method = getattr(self.logger, level, self.logger.info)
        log_method(message)

        return {"logged": True, "level": level}

    async def _handle_delay(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Delay handler - introduces a delay."""
        seconds = params.get("seconds", 1.0)
        seconds = min(seconds, 30.0)  # Cap at 30 seconds

        await asyncio.sleep(seconds)

        return {"delayed": True, "seconds": seconds}

    # -------------------------------------------------------------------
    # Handler Registration
    # -------------------------------------------------------------------

    def register_handler(
        self,
        name: str,
        description: str = "",
        handler: Optional[Callable] = None,
    ) -> None:
        """Register a custom task handler.

        Args:
            name: Handler name.
            description: Handler description.
            handler: Callable to execute when this handler is invoked.
        """
        self._handlers[name] = {
            "description": description or f"Custom handler: {name}",
            "callable": handler,
        }
        self.logger.info("Registered custom handler: %s", name)

    def unregister_handler(self, name: str) -> bool:
        """Unregister a handler.

        Args:
            name: Handler name to remove.

        Returns:
            True if handler was found and removed.
        """
        if name in self._handlers and name not in self.BUILTIN_HANDLERS:
            del self._handlers[name]
            return True
        return False

    # -------------------------------------------------------------------
    # Configuration Helpers
    # -------------------------------------------------------------------

    def _apply_config(self, config: Dict[str, Any]) -> None:
        """Apply initial configuration from config dict."""
        # Register handlers from config
        for name, definition in config.get("handlers", {}).items():
            self._handlers[name] = definition

        # Define pipelines from config
        for name, steps in config.get("pipelines", {}).items():
            self._pipelines[name] = steps

        # Set up integrations from config
        for name, integration_config in config.get("integrations", {}).items():
            self._integrations[name] = {
                "config": integration_config,
                "status": "configured",
                "created_at": time.time(),
            }

    def _get_required_fields(self, service: str) -> List[str]:
        """Get required configuration fields for a service type."""
        service_requirements = {
            "rest_api": ["url", "method"],
            "database": ["connection_string"],
            "message_queue": ["broker_url", "queue_name"],
            "webhook": ["url"],
            "email": ["smtp_host", "smtp_port", "from_address"],
        }
        return service_requirements.get(service, [])

    # -------------------------------------------------------------------
    # Status and Info
    # -------------------------------------------------------------------

    def get_handler_list(self) -> List[Dict[str, Any]]:
        """Get list of all registered handlers."""
        return [
            {
                "name": name,
                "description": defn.get("description", ""),
                "builtin": name in self.BUILTIN_HANDLERS,
            }
            for name, defn in self._handlers.items()
        ]

    def get_pipeline_list(self) -> List[Dict[str, Any]]:
        """Get list of all defined pipelines."""
        return [
            {
                "name": name,
                "steps": len(steps),
                "step_names": [s.get("name", f"step_{i}") for i, s in enumerate(steps)],
            }
            for name, steps in self._pipelines.items()
        ]

    def get_integration_list(self) -> List[Dict[str, Any]]:
        """Get list of all configured integrations."""
        return [
            {
                "id": int_id,
                "service": int_data.get("service", "unknown"),
                "status": int_data.get("status", "unknown"),
            }
            for int_id, int_data in self._integrations.items()
        ]
