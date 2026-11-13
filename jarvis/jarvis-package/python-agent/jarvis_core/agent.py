"""
JARVIS AI Agent Core Module

The main agent orchestrator that composes all subsystems and provides
a unified interface for processing user requests. Routes input through
authentication, intent detection, and specialized handlers.

Features:
    - YAML-based configuration loading with environment variable support
    - JWT authentication and rate limiting for all requests
    - Intent detection with regex-based pattern matching
    - Request routing to specialized handlers (search, image, swarm, etc.)
    - OpenAI GPT integration with dynamic JARVIS personality prompts
    - Web search via external API integration
    - DALL-E image generation
    - Swarm agent orchestration
    - File upload analysis and personalization
    - Voice interaction support
    - Comprehensive system status reporting

Intent Types:
    - chat: General conversation
    - search: Web search queries
    - image_gen: Image generation requests
    - swarm_command: Swarm agent operations
    - file_analysis: File upload processing
    - voice: Voice interaction
    - system_status: System health check
    - help: Usage assistance
    - greeting: Welcome messages
    - unknown: Unrecognized intents
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Optional

import yaml

from .memory import ConversationMemory
from .personality import PersonalityEngine, PersonalityMode
from .security import SecurityManager, SecurityEventType
from .swarm_connector import SwarmConnector, AgentType, AgentStatus
from .upload_handler import UploadHandler
from .voice import VoiceInterface, STTBackend

logger = logging.getLogger(__name__)


class IntentType(str, Enum):
    """Enumeration of detected user intent types.

    Each intent maps to a specific handler method in the agent.
    """
    CHAT = "chat"
    SEARCH = "search"
    IMAGE_GEN = "image_gen"
    SWARM_COMMAND = "swarm_command"
    FILE_ANALYSIS = "file_analysis"
    VOICE = "voice"
    SYSTEM_STATUS = "system_status"
    HELP = "help"
    GREETING = "greeting"
    UNKNOWN = "unknown"


# ─── Intent Detection Patterns ────────────────────────────────────────────

INTENT_PATTERNS: dict[IntentType, list[str]] = {
    IntentType.SEARCH: [
        r"(?i)\b(search|look up|find|google|query|what is|who is|when was|where is|how does)\b",
        r"(?i)\btell me about\b",
        r"(?i)\blook up\b.*\bfor\b",
        r"(?i)\bsearch\s+(for|the web|online|internet)\b",
        r"(?i)\bwhat('s| is) the (latest|current|weather|news)\b",
    ],
    IntentType.IMAGE_GEN: [
        r"(?i)\b(generate|create|draw|make|design)\s+(an? |the )?(image|picture|photo|illustration|artwork|graphic|icon)\b",
        r"(?i)\bimage\s+(gen|generation|create|generate)\b",
        r"(?i)\bdall-?e\b",
        r"(?i)\b(create|generate)\s+(me\s+)?(a\s+)?(visual|art|drawing)\b",
        r"(?i)\bpicture\s+(of|for)\b",
    ],
    IntentType.SWARM_COMMAND: [
        r"(?i)\b(swarm|agent)\b.*\b(start|activate|deploy|run|launch|enable)\b",
        r"(?i)\b(start|activate|deploy|run|launch|enable)\b.*\b(swarm|agent)\b",
        r"(?i)\b(deactivate|stop|disable|kill)\b.*\b(agent|swarm)\b",
        r"(?i)\bagent\s+(status|health|info|list|check)\b",
        r"(?i)\bswarm\s+(status|connect|disconnect|sync)\b",
        r"(?i)\bcode[- ]?review(er)?\b",
        r"(?i)\bsecurity[- ]?audit(or)?\b",
        r"(?i)\btest[- ]?engineer(ing)?\b",
        r"(?i)\bweb[- ]?performance\b",
        r"(?i)\bpayment[- ]?agent\b",
    ],
    IntentType.FILE_ANALYSIS: [
        r"(?i)\b(analyze|process|upload|examine|review)\s+(the\s+)?(file|document|code|upload)\b",
        r"(?i)\bfile\s+(analysis|upload|process)\b",
        r"(?i)\bupload\s+(a\s+)?(file|document|code)\b",
    ],
    IntentType.VOICE: [
        r"(?i)\b(listen|speak|voice|mic|microphone|talk|say)\b",
        r"(?i)\bvoice\s+(command|input|interaction)\b",
        r"(?i)\b(speech|audio)\s+(to|recognition|synthesis)\b",
        r"(?i)\btext[- ]to[- ]speech\b",
        r"(?i)\btts\b|\bstt\b",
    ],
    IntentType.SYSTEM_STATUS: [
        r"(?i)\b(system|service)\s*(status|health|check|info|state)\b",
        r"(?i)\bstatus\s*(report|check|update)\b",
        r"(?i)\bhow\s+(are|is)\s+(you|jarvis|the system|everything)\b",
        r"(?i)\bdiagnostic(s)?\b",
        r"(?i)\bsystem\s+overview\b",
    ],
    IntentType.HELP: [
        r"(?i)\b(help|assist|guide|how\s+to|instructions|manual|docs)\b",
        r"(?i)\bwhat\s+can\s+you\s+do\b",
        r"(?i)\bhow\s+do\s+i\b",
        r"(?i)\bcommands?\s*(list|available)?\b",
    ],
    IntentType.GREETING: [
        r"(?i)^(hi|hello|hey|greetings|howdy|yo|sup|good\s+(morning|afternoon|evening))[\s!.?]*$",
        r"(?i)^what'?s\s+up\b",
        r"(?i)^are\s+you\s+(there|online|alive|awake)\b",
    ],
}


class AgentConfig:
    """Configuration container for JARVIS Agent.

    Loads configuration from YAML files with environment variable
    substitution support.

    Attributes:
        openai_api_key: OpenAI API key for chat and image generation.
        openai_model: Default OpenAI chat model.
        openai_image_model: OpenAI image generation model.
        personality_mode: Default personality mode.
        max_memory_messages: Maximum conversation memory messages.
        rate_limit_max: Maximum requests per rate limit window.
        rate_limit_window: Rate limit window in seconds.
        jwt_secret: Secret key for JWT tokens.
        swarm_endpoint: WebSocket endpoint for swarm server.
        swarm_encryption_key: AES key for swarm payload encryption.
        voice_stt_backend: Default STT backend.
        voice_language: Language code for STT.
        upload_max_size: Maximum upload file size.
        upload_dir: Directory for uploaded files.
        search_api_url: URL for web search API.
        log_level: Logging level.
    """

    def __init__(self, config_path: Optional[str] = None) -> None:
        """Initialize AgentConfig from a YAML file or defaults.

        Environment variables are substituted in string values using
        the ${VAR_NAME} syntax.

        Args:
            config_path: Optional path to a YAML configuration file.
        """
        # Defaults
        self.openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
        self.openai_model: str = "gpt-4"
        self.openai_image_model: str = "dall-e-3"
        self.personality_mode: str = "witty"
        self.max_memory_messages: int = 100
        self.rate_limit_max: int = 100
        self.rate_limit_window: int = 60
        self.jwt_secret: str = os.getenv("JWT_SECRET", "jarvis-default-secret-key")
        self.swarm_endpoint: str = os.getenv("SWARM_ENDPOINT", "ws://localhost:8080/swarm")
        self.swarm_encryption_key: Optional[str] = os.getenv("SWARM_ENCRYPTION_KEY")
        self.voice_stt_backend: str = "google"
        self.voice_language: str = "en-US"
        self.upload_max_size: int = 50 * 1024 * 1024  # 50MB
        self.upload_dir: str = os.getenv("UPLOAD_DIR", "/tmp/jarvis_uploads")
        self.search_api_url: str = os.getenv("SEARCH_API_URL", "https://api.duckduckgo.com/")
        self.log_level: str = os.getenv("LOG_LEVEL", "INFO")
        self.audit_log_path: Optional[str] = os.getenv("AUDIT_LOG_PATH")
        self.enable_voice: bool = os.getenv("ENABLE_VOICE", "false").lower() == "true"
        self.enable_swarm: bool = os.getenv("ENABLE_SWARM", "true").lower() == "true"
        self.max_tokens: int = 2000
        self.temperature: float = 0.7

        # Load from file if provided
        if config_path:
            self._load_from_yaml(config_path)

    def _load_from_yaml(self, config_path: str) -> None:
        """Load configuration from a YAML file with env var substitution.

        Args:
            config_path: Path to the YAML configuration file.
        """
        path = Path(config_path)
        if not path.exists():
            logger.warning("Config file not found: %s", config_path)
            return

        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()

        # Substitute environment variables
        raw = re.sub(
            r'\$\{([^}]+)\}',
            lambda m: os.getenv(m.group(1), m.group(0)),
            raw,
        )

        data = yaml.safe_load(raw)
        if not data or not isinstance(data, dict):
            return

        # Apply configuration values
        config_map = {
            "openai_api_key": ("openai", "api_key"),
            "openai_model": ("openai", "model"),
            "openai_image_model": ("openai", "image_model"),
            "personality_mode": ("personality", "mode"),
            "max_memory_messages": ("memory", "max_messages"),
            "rate_limit_max": ("security", "rate_limit_max"),
            "rate_limit_window": ("security", "rate_limit_window"),
            "jwt_secret": ("security", "jwt_secret"),
            "swarm_endpoint": ("swarm", "endpoint"),
            "swarm_encryption_key": ("swarm", "encryption_key"),
            "voice_stt_backend": ("voice", "stt_backend"),
            "voice_language": ("voice", "language"),
            "upload_max_size": ("uploads", "max_size"),
            "upload_dir": ("uploads", "dir"),
            "search_api_url": ("search", "api_url"),
            "log_level": ("general", "log_level"),
            "max_tokens": ("openai", "max_tokens"),
            "temperature": ("openai", "temperature"),
        }

        for attr, (section, key) in config_map.items():
            section_data = data.get(section, {})
            if isinstance(section_data, dict) and key in section_data:
                value = section_data[key]
                # Handle size suffixes
                if attr == "upload_max_size" and isinstance(value, str):
                    value = self._parse_size(value)
                setattr(self, attr, value)

    @staticmethod
    def _parse_size(size_str: str) -> int:
        """Parse a human-readable size string to bytes.

        Args:
            size_str: Size string like '50MB', '1GB', etc.

        Returns:
            Size in bytes as an integer.
        """
        size_str = size_str.strip().upper()
        multipliers = {"KB": 1024, "MB": 1024**2, "GB": 1024**3}
        for suffix, mult in multipliers.items():
            if size_str.endswith(suffix):
                return int(float(size_str[:-len(suffix)]) * mult)
        return int(size_str)

    def to_dict(self) -> dict[str, Any]:
        """Convert configuration to a dictionary (masking sensitive values).

        Returns:
            Configuration dictionary with sensitive values masked.
        """
        return {
            "openai_api_key": "***" if self.openai_api_key else "",
            "openai_model": self.openai_model,
            "openai_image_model": self.openai_image_model,
            "personality_mode": self.personality_mode,
            "max_memory_messages": self.max_memory_messages,
            "rate_limit_max": self.rate_limit_max,
            "rate_limit_window": self.rate_limit_window,
            "jwt_secret": "***",
            "swarm_endpoint": self.swarm_endpoint,
            "swarm_encryption_key": "***" if self.swarm_encryption_key else "",
            "voice_stt_backend": self.voice_stt_backend,
            "voice_language": self.voice_language,
            "upload_max_size": self.upload_max_size,
            "upload_dir": self.upload_dir,
            "search_api_url": self.search_api_url,
            "log_level": self.log_level,
            "enable_voice": self.enable_voice,
            "enable_swarm": self.enable_swarm,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }


class JarvisAgent:
    """Main JARVIS AI Agent orchestrator.

    Composes all subsystems (personality, memory, security, swarm, voice,
    upload handler) and provides a unified interface for processing user
    requests through authentication, intent detection, and routing.

    Args:
        config_path: Optional path to a YAML configuration file.
        config: Optional AgentConfig instance (overrides config_path).

    Example:
        >>> agent = JarvisAgent(config_path="jarvis_config.yaml")
        >>> result = agent.process_input("Hello JARVIS!", auth_token="jwt-token")
        >>> print(result["response"])
    """

    def __init__(
        self,
        config_path: Optional[str] = None,
        config: Optional[AgentConfig] = None,
    ) -> None:
        """Initialize the JARVIS Agent.

        Args:
            config_path: Path to YAML configuration file.
            config: Pre-built AgentConfig instance.
        """
        # Load configuration
        self._config: AgentConfig = config or AgentConfig(config_path)

        # Configure logging
        logging.basicConfig(
            level=getattr(logging, self._config.log_level.upper(), logging.INFO),
            format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        )

        # Initialize subsystems
        self._personality = PersonalityEngine(
            mode=self._config.personality_mode,
        )

        self._memory = ConversationMemory(
            max_messages=self._config.max_memory_messages,
        )

        self._security = SecurityManager(
            config={
                "jwt_secret": self._config.jwt_secret,
                "rate_limit_max": self._config.rate_limit_max,
                "rate_limit_window": self._config.rate_limit_window,
                "audit_log_path": self._config.audit_log_path,
            }
        )

        self._swarm = SwarmConnector(
            endpoint=self._config.swarm_endpoint,
            encryption_key=(
                base64.b64decode(self._config.swarm_encryption_key)
                if self._config.swarm_encryption_key
                else None
            ),
        )

        self._upload_handler = UploadHandler(
            max_file_size=self._config.upload_max_size,
            upload_dir=self._config.upload_dir,
            openai_api_key=self._config.openai_api_key or None,
        )

        self._voice = VoiceInterface(
            stt_backend=self._config.voice_stt_backend,
            language=self._config.voice_language,
            whisper_api_key=self._config.openai_api_key or None,
        )

        # Agent state
        self._initialized_at: str = datetime.now(timezone.utc).isoformat()
        self._request_count: int = 0
        self._error_count: int = 0

        # OpenAI client (lazy initialization)
        self._openai_client: Any = None

        logger.info(
            "JarvisAgent initialized (mode=%s, memory=%d, voice=%s)",
            self._config.personality_mode,
            self._config.max_memory_messages,
            self._config.voice_stt_backend,
        )

    @property
    def config(self) -> AgentConfig:
        """Return the agent configuration."""
        return self._config

    @property
    def personality(self) -> PersonalityEngine:
        """Return the personality engine."""
        return self._personality

    @property
    def memory(self) -> ConversationMemory:
        """Return the conversation memory."""
        return self._memory

    @property
    def security(self) -> SecurityManager:
        """Return the security manager."""
        return self._security

    @property
    def swarm(self) -> SwarmConnector:
        """Return the swarm connector."""
        return self._swarm

    @property
    def upload_handler(self) -> UploadHandler:
        """Return the upload handler."""
        return self._upload_handler

    @property
    def voice(self) -> VoiceInterface:
        """Return the voice interface."""
        return self._voice

    def _get_openai_client(self) -> Any:
        """Get or lazily initialize the OpenAI client.

        Returns:
            The OpenAI client instance.

        Raises:
            RuntimeError: If OpenAI API key is not configured.
        """
        if self._openai_client is None:
            if not self._config.openai_api_key:
                raise RuntimeError("OpenAI API key not configured")
            try:
                import openai
                self._openai_client = openai.OpenAI(
                    api_key=self._config.openai_api_key,
                )
            except ImportError:
                raise RuntimeError("OpenAI package not installed")
        return self._openai_client

    def process_input(
        self,
        user_input: str,
        auth_token: Optional[str] = None,
    ) -> dict[str, Any]:
        """Process user input through the full JARVIS pipeline.

        Validates authentication, detects intent, routes to the
        appropriate handler, and returns a comprehensive result.

        Args:
            user_input: The user's input text.
            auth_token: Optional JWT authentication token.

        Returns:
            A dictionary containing:
            - success: Whether processing succeeded
            - intent: The detected intent type
            - response: The JARVIS response text
            - data: Intent-specific result data
            - metadata: Processing metadata
            - error: Error message if processing failed
        """
        start_time = time.time()
        request_id = str(uuid.uuid4())
        self._request_count += 1

        logger.info(
            "Processing input [%s]: %s (len=%d)",
            request_id[:8],
            user_input[:100],
            len(user_input),
        )

        # Validate authentication
        user_info: dict[str, Any] = {}
        if auth_token:
            try:
                user_info = self._security.validate_token(auth_token)
            except Exception as e:
                self._error_count += 1
                self._security.log_security_event(
                    SecurityEventType.UNAUTHORIZED_ACCESS,
                    details={"error": str(e), "input_preview": user_input[:50]},
                    severity="warning",
                )
                return {
                    "success": False,
                    "intent": "auth_failed",
                    "response": "Authentication failed. Please provide a valid token.",
                    "data": None,
                    "error": str(e),
                    "request_id": request_id,
                }

        # Check rate limit
        client_id = user_info.get("sub", "anonymous")
        if not self._security.check_rate_limit(client_id):
            self._error_count += 1
            return {
                "success": False,
                "intent": "rate_limited",
                "response": "Rate limit exceeded. Please wait before making more requests.",
                "data": None,
                "error": "rate_limit_exceeded",
                "request_id": request_id,
            }

        # Store user message in memory
        self._memory.add_message(
            role="user",
            content=user_input,
            metadata={"request_id": request_id, "user_id": client_id},
        )

        # Detect intent
        intent = self._detect_intent(user_input)

        # Route to handler
        try:
            handler_map = {
                IntentType.CHAT: self._handle_chat,
                IntentType.SEARCH: self._handle_search,
                IntentType.IMAGE_GEN: self._handle_image_gen,
                IntentType.SWARM_COMMAND: self._handle_swarm_command,
                IntentType.FILE_ANALYSIS: self._handle_file_analysis,
                IntentType.VOICE: self._handle_voice,
                IntentType.SYSTEM_STATUS: self._handle_system_status,
                IntentType.HELP: self._handle_help,
                IntentType.GREETING: self._handle_greeting,
                IntentType.UNKNOWN: self._handle_chat,
            }

            handler = handler_map.get(intent, self._handle_chat)
            result = handler(user_input, user_info)

        except Exception as e:
            self._error_count += 1
            logger.error("Handler error for intent %s: %s", intent.value, e)
            result = {
                "success": False,
                "response": self._personality.get_error_response(),
                "data": None,
                "error": str(e),
            }

        # Store assistant response in memory
        if result.get("response"):
            self._memory.add_message(
                role="assistant",
                content=result["response"],
                metadata={"request_id": request_id, "intent": intent.value},
            )

        # Update conversation state for personality engine
        self._personality.update_conversation_state(
            message_count=self._memory.message_count,
            recent_messages=self._memory.get_context(max_messages=5),
        )

        processing_time = int((time.time() - start_time) * 1000)

        return {
            "success": result.get("success", True),
            "intent": intent.value,
            "response": result.get("response", ""),
            "data": result.get("data"),
            "error": result.get("error"),
            "request_id": request_id,
            "metadata": {
                "processing_time_ms": processing_time,
                "intent": intent.value,
                "user_id": client_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        }

    def _detect_intent(self, text: str) -> IntentType:
        """Detect the user's intent from their input text.

        Uses regex pattern matching to classify the input into one
        of the supported intent types. Patterns are checked in priority
        order: search, image_gen, swarm, file, voice, system_status,
        help, greeting, then defaults to chat.

        Args:
            text: The user's input text.

        Returns:
            The detected IntentType.
        """
        text = text.strip()

        if not text:
            return IntentType.UNKNOWN

        # Check intents in priority order
        priority_order = [
            IntentType.SEARCH,
            IntentType.IMAGE_GEN,
            IntentType.SWARM_COMMAND,
            IntentType.FILE_ANALYSIS,
            IntentType.VOICE,
            IntentType.SYSTEM_STATUS,
            IntentType.HELP,
            IntentType.GREETING,
        ]

        for intent_type in priority_order:
            patterns = INTENT_PATTERNS.get(intent_type, [])
            for pattern in patterns:
                if re.search(pattern, text):
                    logger.debug(
                        "Intent detected: %s (pattern: %s)",
                        intent_type.value,
                        pattern[:30],
                    )
                    return intent_type

        # Default to chat for everything else
        return IntentType.CHAT

    def _generate_response(self, context: dict[str, Any]) -> str:
        """Generate a response using OpenAI with JARVIS personality.

        Constructs a system prompt from the personality engine, includes
        conversation context from memory, and calls the OpenAI API.

        Args:
            context: Dictionary with 'user_input' and optional additional
                context for the response generation.

        Returns:
            The generated response string.
        """
        if not self._config.openai_api_key:
            return (
                "I'd love to help with that, but my language model isn't "
                "configured. Please set the OPENAI_API_KEY to enable "
                "intelligent responses."
            )

        try:
            client = self._get_openai_client()

            # Build system prompt with personality
            system_prompt = self._personality.generate_system_prompt(
                context=context.get("extra_context"),
            )

            # Build messages from conversation history
            messages: list[dict[str, str]] = [
                {"role": "system", "content": system_prompt},
            ]

            # Add conversation context with summary
            context_messages = self._memory.get_full_context_with_summary(
                max_messages=20
            )
            messages.extend(context_messages)

            # Add the current user input if not already in context
            user_input = context.get("user_input", "")
            if user_input and (
                not context_messages
                or context_messages[-1].get("content") != user_input
            ):
                messages.append({"role": "user", "content": user_input})

            # Call OpenAI API
            response = client.chat.completions.create(
                model=self._config.openai_model,
                messages=messages,
                max_tokens=self._config.max_tokens,
                temperature=self._config.temperature,
            )

            result = response.choices[0].message.content or ""

            logger.debug(
                "Response generated: %d tokens, %d characters",
                response.usage.total_tokens if response.usage else 0,
                len(result),
            )

            return result

        except RuntimeError as e:
            logger.error("OpenAI client error: %s", e)
            return self._personality.get_error_response()
        except Exception as e:
            logger.error("Response generation failed: %s", e)
            return (
                "I encountered an issue generating a response. "
                "Let me try a different approach."
            )

    # ─── Intent Handlers ──────────────────────────────────────────────────

    def _handle_chat(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle general chat intent.

        Args:
            user_input: The user's input text.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary.
        """
        response = self._generate_response({"user_input": user_input})
        return {
            "success": True,
            "response": response,
            "data": {"type": "chat"},
        }

    def _handle_search(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle web search intent.

        Extracts the search query from the input, performs a web search,
        and generates a JARVIS-style response with the results.

        Args:
            user_input: The user's input text containing a search query.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary with search results.
        """
        # Extract search query
        query = self._extract_search_query(user_input)

        try:
            search_results = self._perform_web_search(query)
            search_context = self._format_search_results(query, search_results)

            response = self._generate_response({
                "user_input": user_input,
                "extra_context": {
                    "search_query": query,
                    "search_results": search_context,
                },
            })

            return {
                "success": True,
                "response": response,
                "data": {
                    "type": "search",
                    "query": query,
                    "results_count": len(search_results) if isinstance(search_results, list) else 0,
                    "results": search_results,
                },
            }

        except Exception as e:
            logger.error("Search failed for '%s': %s", query, e)
            return {
                "success": False,
                "response": (
                    f"I wasn't able to complete the search for '{query}'. "
                    f"Let me try to help based on what I know."
                ),
                "data": {"type": "search", "query": query, "error": str(e)},
                "error": str(e),
            }

    def _handle_image_gen(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle image generation intent.

        Extracts an image prompt from the input and generates an image
        using DALL-E.

        Args:
            user_input: The user's input text containing an image request.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary with image generation results.
        """
        # Extract image prompt
        prompt = self._extract_image_prompt(user_input)

        if not prompt:
            return {
                "success": False,
                "response": (
                    "I'd be happy to generate an image for you. Could you "
                    "describe what you'd like me to create?"
                ),
                "data": {"type": "image_gen", "error": "no_prompt"},
            }

        try:
            client = self._get_openai_client()
            response = client.images.generate(
                model=self._config.openai_image_model,
                prompt=prompt,
                size="1024x1024",
                quality="standard",
                n=1,
            )

            image_url = response.data[0].url if response.data else None
            revised_prompt = (
                response.data[0].revised_prompt if response.data else None
            )

            result_msg = f"I've generated an image based on: '{prompt}'"
            if revised_prompt:
                result_msg += f"\n\nRevised prompt: {revised_prompt}"

            return {
                "success": True,
                "response": result_msg,
                "data": {
                    "type": "image_gen",
                    "prompt": prompt,
                    "revised_prompt": revised_prompt,
                    "image_url": image_url,
                },
            }

        except Exception as e:
            logger.error("Image generation failed: %s", e)
            return {
                "success": False,
                "response": (
                    f"I encountered an issue generating the image for "
                    f"'{prompt}'. The image generation service may be "
                    f"temporarily unavailable."
                ),
                "data": {"type": "image_gen", "prompt": prompt, "error": str(e)},
                "error": str(e),
            }

    def _handle_swarm_command(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle swarm agent command intent.

        Parses swarm-related commands (activate, deactivate, status)
        and dispatches them to the SwarmConnector.

        Args:
            user_input: The user's input text containing a swarm command.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary with swarm operation results.
        """
        auth_token = user_info.get("token", "")

        # Parse the command
        command = self._parse_swarm_command(user_input)

        try:
            if command["action"] == "activate":
                result = asyncio.get_event_loop().run_until_complete(
                    self._swarm.activate_agent(command["agent_id"])
                )
                response = (
                    f"Agent '{command['agent_id']}' activation has been "
                    f"requested. Status: {result.get('status', 'pending')}."
                )

            elif command["action"] == "deactivate":
                result = asyncio.get_event_loop().run_until_complete(
                    self._swarm.deactivate_agent(command["agent_id"])
                )
                response = (
                    f"Agent '{command['agent_id']}' deactivation has been "
                    f"requested."
                )

            elif command["action"] == "status":
                if command.get("agent_id"):
                    result = asyncio.get_event_loop().run_until_complete(
                        self._swarm.get_agent_status(command["agent_id"])
                    )
                else:
                    agents = asyncio.get_event_loop().run_until_complete(
                        self._swarm.get_all_agents()
                    )
                    result = {"agents": agents}

                active_count = sum(
                    1 for a in result.get("agents", [])
                    if a.get("status") == "active"
                ) if "agents" in result else 0

                response = (
                    f"Swarm status: {len(result.get('agents', []))} agents "
                    f"registered, {active_count} active."
                )

            elif command["action"] == "connect":
                result = asyncio.get_event_loop().run_until_complete(
                    self._swarm.connect(auth_token)
                )
                response = (
                    "Swarm connection established." if result
                    else "Failed to connect to swarm."
                )

            elif command["action"] == "disconnect":
                asyncio.get_event_loop().run_until_complete(
                    self._swarm.disconnect()
                )
                response = "Disconnected from swarm."
                result = {"disconnected": True}

            elif command["action"] == "dispatch":
                task = command.get("task", {"type": "generic"})
                result = asyncio.get_event_loop().run_until_complete(
                    self._swarm.dispatch_task(task, auth_token)
                )
                response = (
                    f"Task dispatched to swarm. Task ID: "
                    f"{result.get('task_id', 'unknown')}."
                )

            elif command["action"] == "sync":
                result = asyncio.get_event_loop().run_until_complete(
                    self._swarm.sync_github_repo()
                )
                response = (
                    "GitHub repository sync initiated."
                    if result.get("success")
                    else "GitHub sync failed."
                )

            else:
                result = self._swarm.get_status()
                response = (
                    f"Swarm connector status: "
                    f"connected={result['connected']}, "
                    f"agents={result['agents']['total']}."
                )

            return {
                "success": result.get("success", True) if isinstance(result, dict) else True,
                "response": response,
                "data": {
                    "type": "swarm_command",
                    "action": command["action"],
                    "result": result,
                },
            }

        except Exception as e:
            logger.error("Swarm command failed: %s", e)
            return {
                "success": False,
                "response": f"Swarm operation failed: {str(e)}",
                "data": {"type": "swarm_command", "error": str(e)},
                "error": str(e),
            }

    def _handle_file_analysis(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle file analysis intent.

        Processes uploaded files through the UploadHandler for text
        extraction and LLM analysis.

        Args:
            user_input: The user's input text referencing file analysis.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary with file analysis results.
        """
        # Check for pending uploads
        upload_summary = self._upload_handler.get_upload_summary()

        if upload_summary["total_uploads"] == 0:
            return {
                "success": False,
                "response": (
                    "I don't see any uploaded files to analyze. Please "
                    "upload a file first, and I'll provide a detailed analysis."
                ),
                "data": {"type": "file_analysis", "uploads": 0},
            }

        # Get personalization profile from uploads
        profile = self._upload_handler.get_personalization_profile()

        # Generate a response about the uploads
        response = self._generate_response({
            "user_input": user_input,
            "extra_context": {
                "upload_summary": upload_summary,
                "personalization_profile": profile,
            },
        })

        # Update personality with personalization data
        if profile.get("languages"):
            self._personality.adjust_for_user_preferences({
                "technical_level": "expert" if profile.get("expertise_level") == "advanced" else "intermediate",
            })

        return {
            "success": True,
            "response": response,
            "data": {
                "type": "file_analysis",
                "upload_summary": upload_summary,
                "personalization": profile,
            },
        }

    def _handle_voice(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle voice interaction intent.

        Provides voice interface status and guidance.

        Args:
            user_input: The user's input text about voice.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary with voice information.
        """
        voice_status = self._voice.get_status()

        response = self._generate_response({
            "user_input": user_input,
            "extra_context": {
                "voice_status": voice_status,
                "available_backends": ["google", "whisper", "sphinx"],
            },
        })

        return {
            "success": True,
            "response": response,
            "data": {
                "type": "voice",
                "voice_status": voice_status,
            },
        }

    def _handle_system_status(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle system status request intent.

        Args:
            user_input: The user's input text.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary with system status.
        """
        status = self.get_system_status()
        response = self._format_system_status(status)

        return {
            "success": True,
            "response": response,
            "data": {
                "type": "system_status",
                "status": status,
            },
        }

    def _handle_help(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle help request intent.

        Args:
            user_input: The user's input text.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary with help information.
        """
        help_text = (
            "Here's what I can help you with:\n\n"
            "**Chat**: Just talk to me naturally—I'll respond with context-aware answers.\n\n"
            "**Search**: Ask me to search for something. Examples:\n"
            '- "Search for Python best practices"\n'
            '- "Look up the latest news about AI"\n\n'
            "**Image Generation**: Ask me to create an image. Examples:\n"
            '- "Generate an image of a futuristic city"\n'
            '- "Create a picture of a sunset over mountains"\n\n'
            "**Swarm Agents**: Control AI agents for specialized tasks:\n"
            '- "Activate the code reviewer agent"\n'
            '- "Show swarm status"\n'
            '- "Run security audit on my code"\n\n'
            "**File Analysis**: Upload files for intelligent analysis:\n"
            '- "Analyze my uploaded code"\n'
            '- I support Python, JS/TS, Go, Rust, Java, C/C++, and many more\n\n'
            "**Voice**: Voice interaction capabilities:\n"
            '- "Listen to me" or "Speak to me"\n\n'
            "**System**: Check my status:\n"
            '- "System status" or "How are you?"\n\n'
            "I'm running in **{mode}** mode. Feel free to ask anything!"
        ).format(mode=self._personality.mode.value)

        return {
            "success": True,
            "response": help_text,
            "data": {"type": "help"},
        }

    def _handle_greeting(
        self, user_input: str, user_info: dict[str, Any]
    ) -> dict[str, Any]:
        """Handle greeting intent.

        Args:
            user_input: The user's greeting text.
            user_info: Authenticated user information.

        Returns:
            Handler result dictionary with a greeting response.
        """
        greeting = self._personality.get_greeting()

        # Add personalization if user profile exists
        user_name = user_info.get("name") or user_info.get("sub", "")
        if user_name and user_name != "anonymous":
            greeting = greeting.replace(
                "Good day",
                f"Good day, {user_name}",
                1,
            )

        return {
            "success": True,
            "response": greeting,
            "data": {"type": "greeting"},
        }

    # ─── Helper Methods ───────────────────────────────────────────────────

    def _extract_search_query(self, text: str) -> str:
        """Extract the search query from user input.

        Removes search command prefixes to isolate the actual query.

        Args:
            text: The raw user input text.

        Returns:
            The extracted search query string.
        """
        # Remove common search prefixes
        prefixes = [
            r"(?i)^search\s+(for\s+)?",
            r"(?i)^look\s+up\s+",
            r"(?i)^find\s+(me\s+)?",
            r"(?i)^google\s+",
            r"(?i)^query\s+",
            r"(?i)^tell\s+me\s+about\s+",
            r"(?i)^what\s+is\s+",
            r"(?i)^who\s+is\s+",
            r"(?i)^when\s+was\s+",
            r"(?i)^where\s+is\s+",
            r"(?i)^how\s+does\s+",
        ]

        query = text
        for prefix in prefixes:
            query = re.sub(prefix, "", query, count=1)

        return query.strip() or text.strip()

    def _extract_image_prompt(self, text: str) -> str:
        """Extract the image generation prompt from user input.

        Args:
            text: The raw user input text.

        Returns:
            The extracted image prompt string.
        """
        # Remove common image generation prefixes
        prefixes = [
            r"(?i)^generate\s+(an?\s+)?(image|picture|photo|illustration|artwork)\s+(of\s+)?",
            r"(?i)^create\s+(an?\s+)?(image|picture|photo|illustration|artwork)\s+(of\s+)?",
            r"(?i)^draw\s+(an?\s+)?",
            r"(?i)^make\s+(an?\s+)?(image|picture|photo|illustration)\s+(of\s+)?",
            r"(?i)^design\s+(an?\s+)?",
            r"(?i)^image\s+gen(erate)?\s*",
        ]

        prompt = text
        for prefix in prefixes:
            prompt = re.sub(prefix, "", prompt, count=1)

        return prompt.strip() or text.strip()

    def _parse_swarm_command(self, text: str) -> dict[str, Any]:
        """Parse a swarm command from user input.

        Args:
            text: The raw user input text.

        Returns:
            A dictionary with 'action', optional 'agent_id', and 'task'.
        """
        text_lower = text.lower()

        command: dict[str, Any] = {"action": "status"}

        # Detect action
        if any(w in text_lower for w in ["activate", "start", "enable", "launch", "deploy"]):
            command["action"] = "activate"
        elif any(w in text_lower for w in ["deactivate", "stop", "disable", "kill"]):
            command["action"] = "deactivate"
        elif any(w in text_lower for w in ["connect"]):
            command["action"] = "connect"
        elif any(w in text_lower for w in ["disconnect"]):
            command["action"] = "disconnect"
        elif any(w in text_lower for w in ["dispatch", "run", "execute"]):
            command["action"] = "dispatch"
        elif any(w in text_lower for w in ["sync", "synchronize"]):
            command["action"] = "sync"

        # Detect agent type
        agent_type_map = {
            "code-reviewer": AgentType.CODE_REVIEWER,
            "code reviewer": AgentType.CODE_REVIEWER,
            "security-auditor": AgentType.SECURITY_AUDITOR,
            "security auditor": AgentType.SECURITY_AUDITOR,
            "test-engineer": AgentType.TEST_ENGINEER,
            "test engineer": AgentType.TEST_ENGINEER,
            "web-performance": AgentType.WEB_PERFORMANCE,
            "web performance": AgentType.WEB_PERFORMANCE,
            "payment-agent": AgentType.PAYMENT_AGENT,
            "payment agent": AgentType.PAYMENT_AGENT,
        }

        for keyword, agent_type in agent_type_map.items():
            if keyword in text_lower:
                command["agent_id"] = f"agent-{keyword.replace(' ', '-')}-01"
                command["agent_type"] = agent_type.value
                break

        if "agent_id" not in command:
            command["agent_id"] = "agent-code-reviewer-01"

        # Build task for dispatch
        if command["action"] == "dispatch":
            command["task"] = {
                "type": "analysis",
                "target": text,
                "agent_type": command.get("agent_type", "code-reviewer"),
            }

        return command

    def _perform_web_search(self, query: str) -> list[dict[str, Any]]:
        """Perform a web search using available search API.

        Args:
            query: The search query string.

        Returns:
            A list of search result dictionaries.
        """
        try:
            import aiohttp

            # Try using DuckDuckGo Instant Answer API
            loop = asyncio.new_event_loop()
            try:
                result = loop.run_until_complete(self._async_web_search(query))
                return result
            finally:
                loop.close()

        except ImportError:
            logger.warning("aiohttp not available for web search")
            return []

    async def _async_web_search(
        self, query: str
    ) -> list[dict[str, Any]]:
        """Perform an asynchronous web search.

        Args:
            query: The search query string.

        Returns:
            A list of search result dictionaries.
        """
        results: list[dict[str, Any]] = []

        try:
            async with aiohttp.ClientSession() as session:
                # DuckDuckGo Instant Answer API
                params = {
                    "q": query,
                    "format": "json",
                    "no_html": 1,
                    "skip_disambig": 1,
                }
                async with session.get(
                    self._config.search_api_url,
                    params=params,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as response:
                    if response.status == 200:
                        data = await response.json()

                        # Extract abstract
                        if abstract := data.get("Abstract"):
                            results.append({
                                "title": data.get("Heading", query),
                                "url": data.get("AbstractURL", ""),
                                "snippet": abstract,
                                "source": data.get("AbstractSource", "DuckDuckGo"),
                            })

                        # Extract related topics
                        for topic in data.get("RelatedTopics", [])[:5]:
                            if isinstance(topic, dict) and "Text" in topic:
                                results.append({
                                    "title": topic.get("Text", "")[:80],
                                    "url": topic.get("FirstURL", ""),
                                    "snippet": topic.get("Text", ""),
                                    "source": "DuckDuckGo",
                                })

        except Exception as e:
            logger.error("Web search failed: %s", e)

        return results

    def _format_search_results(
        self, query: str, results: list[dict[str, Any]]
    ) -> str:
        """Format search results for inclusion in LLM context.

        Args:
            query: The original search query.
            results: List of search result dictionaries.

        Returns:
            A formatted string of search results.
        """
        if not results:
            return f"No search results found for: {query}"

        lines = [f"Search results for '{query}':\n"]
        for i, result in enumerate(results, 1):
            lines.append(f"{i}. {result.get('title', 'No title')}")
            if snippet := result.get("snippet"):
                lines.append(f"   {snippet[:200]}")
            if url := result.get("url"):
                lines.append(f"   URL: {url}")
            lines.append("")

        return "\n".join(lines)

    def _format_system_status(self, status: dict[str, Any]) -> str:
        """Format system status into a human-readable response.

        Args:
            status: The system status dictionary.

        Returns:
            A formatted status response string.
        """
        lines = [
            "**JARVIS System Status Report**\n",
            f"**Uptime**: Since {status.get('initialized_at', 'unknown')}",
            f"**Requests Processed**: {status.get('request_count', 0)}",
            f"**Errors**: {status.get('error_count', 0)}\n",
            "**Subsystems**:",
        ]

        for name, subsystem in status.get("subsystems", {}).items():
            state = "✅ Online" if subsystem.get("available") else "❌ Offline"
            lines.append(f"  - **{name}**: {state}")
            if details := subsystem.get("details"):
                for key, value in details.items():
                    if isinstance(value, (str, int, float, bool)):
                        lines.append(f"    - {key}: {value}")

        return "\n".join(lines)

    # ─── System Status ────────────────────────────────────────────────────

    def get_system_status(self) -> dict[str, Any]:
        """Return comprehensive system status for all subsystems.

        Returns:
            A dictionary with status information for the agent and all
            its subsystems.
        """
        return {
            "initialized_at": self._initialized_at,
            "request_count": self._request_count,
            "error_count": self._error_count,
            "personality_mode": self._personality.mode.value,
            "conversation_state": self._personality.conversation_state.value,
            "memory_messages": self._memory.message_count,
            "uptime_seconds": (
                datetime.now(timezone.utc)
                - datetime.fromisoformat(self._initialized_at)
            ).total_seconds(),
            "subsystems": {
                "personality": {
                    "available": True,
                    "details": self._personality.get_status(),
                },
                "memory": {
                    "available": True,
                    "details": self._memory.get_statistics(),
                },
                "security": {
                    "available": True,
                    "details": self._security.get_security_status(),
                },
                "swarm": {
                    "available": self._config.enable_swarm,
                    "details": self._swarm.get_status(),
                },
                "voice": {
                    "available": self._config.enable_voice,
                    "details": self._voice.get_status(),
                },
                "upload_handler": {
                    "available": True,
                    "details": self._upload_handler.get_status(),
                },
                "openai": {
                    "available": bool(self._config.openai_api_key),
                    "details": {
                        "model": self._config.openai_model,
                        "image_model": self._config.openai_image_model,
                    },
                },
            },
            "config": self._config.to_dict(),
        }

    # ─── Convenience Methods ──────────────────────────────────────────────

    def process_upload(
        self,
        file_path: str,
        file_name: str,
        file_type: Optional[str] = None,
        auth_token: Optional[str] = None,
    ) -> dict[str, Any]:
        """Process a file upload through the full pipeline.

        Validates authentication, processes the file, and optionally
        updates the personality engine with personalization data.

        Args:
            file_path: Path to the uploaded file.
            file_name: Original filename.
            file_type: Optional explicit file type.
            auth_token: Optional authentication token.

        Returns:
            A dictionary with file processing results.
        """
        # Validate auth if provided
        if auth_token:
            try:
                self._security.validate_token(auth_token)
            except Exception as e:
                return {
                    "success": False,
                    "error": f"Authentication failed: {e}",
                }

        # Process the upload
        result = self._upload_handler.process_upload(
            file_path=file_path,
            file_name=file_name,
            file_type=file_type,
        )

        # Update personality with file context
        if result.get("success") and result.get("summary"):
            self._personality.add_uploaded_file({
                "filename": result.get("filename", file_name),
                "file_type": result.get("file_type", "unknown"),
                "summary": result.get("summary", ""),
                "insights": result.get("personalization", {}),
            })

        return result

    def generate_token(self, user_id: str, role: str = "user") -> str:
        """Generate a JWT access token for a user.

        Args:
            user_id: The user identifier.
            role: The user's role.

        Returns:
            The encoded JWT token string.
        """
        return self._security.generate_token(user_id, role)

    def generate_token_pair(
        self, user_id: str, role: str = "user"
    ) -> dict[str, str]:
        """Generate both access and refresh tokens.

        Args:
            user_id: The user identifier.
            role: The user's role.

        Returns:
            Dictionary with access and refresh tokens.
        """
        return self._security.generate_token_pair(user_id, role)

    def save_conversation(self, filepath: str) -> None:
        """Save the current conversation to a file.

        Args:
            filepath: Path to save the conversation JSON file.
        """
        self._memory.save_to_file(filepath)
        logger.info("Conversation saved to: %s", filepath)

    def load_conversation(self, filepath: str) -> None:
        """Load a conversation from a file.

        Args:
            filepath: Path to the conversation JSON file.
        """
        self._memory.load_from_file(filepath)
        logger.info("Conversation loaded from: %s", filepath)

    def clear_conversation(self) -> None:
        """Clear the current conversation memory."""
        self._memory.clear()
        self._personality.reset()
        logger.info("Conversation cleared")

    def set_personality_mode(self, mode: str) -> None:
        """Change the personality mode.

        Args:
            mode: The personality mode to set (professional, witty, concise, detailed).
        """
        self._personality.set_mode(mode)
        logger.info("Personality mode set to: %s", mode)

    def __repr__(self) -> str:
        """Return a string representation of the JARVIS Agent."""
        return (
            f"JarvisAgent("
            f"mode={self._personality.mode.value!r}, "
            f"requests={self._request_count}, "
            f"errors={self._error_count})"
        )


# ─── Module-level convenience ─────────────────────────────────────────────

def create_agent(
    config_path: Optional[str] = None,
    **overrides: Any,
) -> JarvisAgent:
    """Factory function to create a JARVIS Agent with optional overrides.

    Args:
        config_path: Optional path to YAML config file.
        **overrides: Keyword arguments to override config values.

    Returns:
        A configured JarvisAgent instance.
    """
    config = AgentConfig(config_path)

    # Apply overrides
    for key, value in overrides.items():
        if hasattr(config, key):
            setattr(config, key, value)

    return JarvisAgent(config=config)
