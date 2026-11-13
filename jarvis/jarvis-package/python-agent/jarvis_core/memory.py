"""
JARVIS Conversation Memory Module

Provides persistent conversation memory with auto-trimming, rolling summaries,
and JSON-based storage for long-term retention.

Features:
    - Thread-safe message storage with timestamps and metadata
    - Auto-trimming to configurable max_messages limit
    - Rolling summary generation for long conversations
    - Persistent JSON file storage and retrieval
    - Full-text search across message history
    - Context window management for LLM interactions
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


class Message:
    """Represents a single conversation message with metadata.

    Attributes:
        id: Unique message identifier.
        role: Message role (user, assistant, system).
        content: The text content of the message.
        timestamp: ISO 8601 timestamp of when the message was created.
        metadata: Optional dict of additional metadata (intent, tokens, etc.).
    """

    def __init__(
        self,
        role: str,
        content: str,
        metadata: Optional[dict[str, Any]] = None,
        message_id: Optional[str] = None,
        timestamp: Optional[str] = None,
    ) -> None:
        """Initialize a Message instance.

        Args:
            role: The role of the message sender (user/assistant/system).
            content: The text content of the message.
            metadata: Optional additional metadata dictionary.
            message_id: Optional specific ID; auto-generated if not provided.
            timestamp: Optional ISO timestamp; auto-generated if not provided.
        """
        self.id: str = message_id or str(uuid.uuid4())
        self.role: str = role
        self.content: str = content
        self.timestamp: str = timestamp or datetime.now(timezone.utc).isoformat()
        self.metadata: dict[str, Any] = metadata or {}

    def to_dict(self) -> dict[str, Any]:
        """Convert the message to a dictionary for serialization.

        Returns:
            A dictionary representation of the message.
        """
        return {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Message:
        """Create a Message instance from a dictionary.

        Args:
            data: Dictionary containing message data.

        Returns:
            A new Message instance.
        """
        return cls(
            role=data["role"],
            content=data["content"],
            metadata=data.get("metadata", {}),
            message_id=data.get("id"),
            timestamp=data.get("timestamp"),
        )

    def __repr__(self) -> str:
        """Return a string representation of the message."""
        return (
            f"Message(id={self.id!r}, role={self.role!r}, "
            f"content={self.content[:50]!r}...)"
        )


class ConversationMemory:
    """Manages conversation history with auto-trimming and persistent storage.

    The ConversationMemory class provides a thread-safe, persistent store for
    conversation messages. It supports auto-trimming to keep memory bounded,
    rolling summary generation for long conversations, full-text search, and
    JSON-based file persistence.

    Args:
        max_messages: Maximum number of messages to retain in active memory.
        session_id: Optional session identifier; auto-generated if not provided.
        summary_model: Optional callable for generating conversation summaries.

    Example:
        >>> memory = ConversationMemory(max_messages=50)
        >>> memory.add_message("user", "Hello JARVIS!")
        >>> memory.add_message("assistant", "Good day, sir. How may I assist you?")
        >>> context = memory.get_context(max_messages=10)
        >>> memory.save_to_file("conversation.json")
    """

    def __init__(
        self,
        max_messages: int = 100,
        session_id: Optional[str] = None,
        summary_model: Optional[Any] = None,
    ) -> None:
        """Initialize the ConversationMemory.

        Args:
            max_messages: Maximum messages to retain before auto-trimming.
            session_id: Optional session identifier.
            summary_model: Optional callable that takes a list of messages
                and returns a summary string for rolling summaries.
        """
        self.max_messages: int = max_messages
        self.session_id: str = session_id or str(uuid.uuid4())
        self.summary_model: Optional[Any] = summary_model
        self._messages: deque[Message] = deque(maxlen=max_messages)
        self._summaries: list[dict[str, Any]] = []
        self._lock: threading.Lock = threading.Lock()
        self._created_at: str = datetime.now(timezone.utc).isoformat()
        self._updated_at: str = self._created_at

        logger.info(
            "ConversationMemory initialized: session=%s, max_messages=%d",
            self.session_id,
            self.max_messages,
        )

    @property
    def message_count(self) -> int:
        """Return the current number of messages in memory.

        Returns:
            The number of stored messages.
        """
        return len(self._messages)

    @property
    def summaries_count(self) -> int:
        """Return the number of rolling summaries generated.

        Returns:
            The number of stored summaries.
        """
        return len(self._summaries)

    def add_message(
        self,
        role: str,
        content: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Message:
        """Add a message to the conversation memory.

        If adding a message causes the deque to exceed max_messages, the oldest
        messages are automatically evicted. When this happens, a rolling summary
        of the evicted messages is generated if a summary_model is configured.

        Args:
            role: The role of the message sender (user/assistant/system).
            content: The text content of the message.
            metadata: Optional additional metadata dictionary.

        Returns:
            The created Message instance.

        Raises:
            ValueError: If role or content is empty.
        """
        if not role.strip():
            raise ValueError("Message role cannot be empty")
        if not content.strip():
            raise ValueError("Message content cannot be empty")

        valid_roles = {"user", "assistant", "system"}
        if role not in valid_roles:
            logger.warning("Unusual message role: %s", role)

        message = Message(role=role, content=content, metadata=metadata)

        with self._lock:
            prev_count = len(self._messages)
            self._messages.append(message)
            self._updated_at = datetime.now(timezone.utc).isoformat()

            # Check if we need to generate a rolling summary
            if prev_count == self.max_messages - 1 and self.summary_model:
                self._generate_rolling_summary()

        logger.debug(
            "Message added: role=%s, content_length=%d", role, len(content)
        )
        return message

    def get_context(self, max_messages: int = 20) -> list[dict[str, Any]]:
        """Retrieve recent conversation context for LLM prompting.

        Returns the most recent messages up to max_messages, formatted as
        dictionaries suitable for OpenAI-style chat completions.

        Args:
            max_messages: Maximum number of recent messages to return.

        Returns:
            A list of message dictionaries with 'role' and 'content' keys.
        """
        with self._lock:
            messages = list(self._messages)[-max_messages:]

        context: list[dict[str, Any]] = []
        for msg in messages:
            entry: dict[str, Any] = {
                "role": msg.role,
                "content": msg.content,
            }
            if msg.metadata:
                entry["metadata"] = msg.metadata
            context.append(entry)

        logger.debug("Retrieved context: %d messages", len(context))
        return context

    def get_full_context_with_summary(self, max_messages: int = 20) -> list[dict[str, Any]]:
        """Retrieve conversation context including any rolling summaries.

        This method prepends any rolling summaries as system messages before
        the recent conversation context, providing a fuller picture of the
        conversation for the LLM.

        Args:
            max_messages: Maximum number of recent messages to return.

        Returns:
            A list of message dictionaries including summary context.
        """
        context: list[dict[str, Any]] = []

        # Add summaries as system context
        with self._lock:
            for summary in self._summaries:
                context.append({
                    "role": "system",
                    "content": f"[Previous conversation summary]: {summary['summary']}",
                })

        # Add recent messages
        recent = self.get_context(max_messages=max_messages)
        context.extend(recent)

        return context

    def clear(self) -> None:
        """Clear all messages and summaries from memory.

        This resets the conversation memory to an empty state. The session_id
        is preserved, but a new one can be set if desired.
        """
        with self._lock:
            count = len(self._messages)
            self._messages.clear()
            self._summaries.clear()
            self._updated_at = datetime.now(timezone.utc).isoformat()

        logger.info("Memory cleared: %d messages removed", count)

    def search_messages(self, query: str) -> list[dict[str, Any]]:
        """Search messages by content using case-insensitive keyword matching.

        Performs a simple text search across all stored messages. The query
        is split into keywords, and messages must contain at least one keyword
        to be included in results.

        Args:
            query: The search query string.

        Returns:
            A list of matching message dictionaries, newest first.
        """
        if not query.strip():
            return []

        # Build regex pattern from query keywords
        keywords = re.escape(query.strip()).split()
        pattern = re.compile(
            "|".join(keywords), re.IGNORECASE
        )

        results: list[dict[str, Any]] = []
        with self._lock:
            for msg in reversed(self._messages):
                if pattern.search(msg.content):
                    results.append(msg.to_dict())

        logger.debug("Search '%s': %d results", query, len(results))
        return results

    def search_by_role(self, role: str) -> list[dict[str, Any]]:
        """Retrieve all messages by a specific role.

        Args:
            role: The message role to filter by (user/assistant/system).

        Returns:
            A list of message dictionaries matching the specified role.
        """
        results: list[dict[str, Any]] = []
        with self._lock:
            for msg in self._messages:
                if msg.role == role:
                    results.append(msg.to_dict())
        return results

    def search_by_metadata(self, key: str, value: Any) -> list[dict[str, Any]]:
        """Search messages by metadata key-value pairs.

        Args:
            key: The metadata key to search for.
            value: The metadata value to match.

        Returns:
            A list of matching message dictionaries.
        """
        results: list[dict[str, Any]] = []
        with self._lock:
            for msg in self._messages:
                if msg.metadata.get(key) == value:
                    results.append(msg.to_dict())
        return results

    def get_messages_in_range(
        self,
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Retrieve messages within a time range.

        Args:
            start_time: ISO 8601 timestamp for the start of the range.
            end_time: ISO 8601 timestamp for the end of the range.

        Returns:
            A list of message dictionaries within the specified time range.
        """
        results: list[dict[str, Any]] = []
        with self._lock:
            for msg in self._messages:
                if start_time and msg.timestamp < start_time:
                    continue
                if end_time and msg.timestamp > end_time:
                    continue
                results.append(msg.to_dict())
        return results

    def save_to_file(self, filepath: str | Path) -> None:
        """Save the conversation memory to a JSON file.

        Persists all messages, summaries, and metadata to a JSON file.
        The directory structure is created if it doesn't exist.

        Args:
            filepath: Path to the output JSON file.

        Raises:
            OSError: If the file cannot be written.
            TypeError: If the data cannot be serialized to JSON.
        """
        filepath = Path(filepath)
        filepath.parent.mkdir(parents=True, exist_ok=True)

        data = {
            "session_id": self.session_id,
            "created_at": self._created_at,
            "updated_at": self._updated_at,
            "max_messages": self.max_messages,
            "message_count": len(self._messages),
            "summaries": self._summaries,
            "messages": [msg.to_dict() for msg in self._messages],
        }

        with self._lock:
            json_data = json.dumps(data, indent=2, ensure_ascii=False, default=str)

        filepath.write_text(json_data, encoding="utf-8")
        logger.info("Memory saved to: %s (%d messages)", filepath, len(self._messages))

    def load_from_file(self, filepath: str | Path) -> None:
        """Load conversation memory from a JSON file.

        Clears the current memory and loads all messages, summaries, and
        metadata from the specified JSON file.

        Args:
            filepath: Path to the input JSON file.

        Raises:
            FileNotFoundError: If the file does not exist.
            json.JSONDecodeError: If the file contains invalid JSON.
            KeyError: If required fields are missing from the file.
        """
        filepath = Path(filepath)
        if not filepath.exists():
            raise FileNotFoundError(f"Memory file not found: {filepath}")

        raw = filepath.read_text(encoding="utf-8")
        data = json.loads(raw)

        with self._lock:
            self._messages.clear()
            self._summaries.clear()

            self.session_id = data.get("session_id", self.session_id)
            self._created_at = data.get("created_at", self._created_at)
            self._updated_at = data.get(
                "updated_at", datetime.now(timezone.utc).isoformat()
            )
            self.max_messages = data.get("max_messages", self.max_messages)
            self._messages = deque(maxlen=self.max_messages)

            # Rebuild the deque with loaded messages
            for msg_data in data.get("messages", []):
                try:
                    msg = Message.from_dict(msg_data)
                    self._messages.append(msg)
                except (KeyError, TypeError) as e:
                    logger.warning("Skipping malformed message: %s", e)

            # Load summaries
            self._summaries = data.get("summaries", [])

        logger.info(
            "Memory loaded from: %s (%d messages, %d summaries)",
            filepath,
            len(self._messages),
            len(self._summaries),
        )

    def _generate_rolling_summary(self) -> None:
        """Generate a rolling summary of older conversation messages.

        This is called internally when the message buffer is near capacity.
        It takes a portion of older messages and generates a summary using
        the configured summary_model, then stores the summary for later
        reference.
        """
        if not self.summary_model or len(self._messages) < 10:
            return

        # Take the oldest half of messages for summarization
        messages_to_summarize = list(self._messages)[: len(self._messages) // 2]
        if not messages_to_summarize:
            return

        try:
            conversation_text = "\n".join(
                f"{msg.role}: {msg.content}" for msg in messages_to_summarize
            )
            summary_text = self.summary_model(conversation_text)

            summary_entry = {
                "id": str(uuid.uuid4()),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "message_count": len(messages_to_summarize),
                "summary": summary_text,
                "period_start": messages_to_summarize[0].timestamp,
                "period_end": messages_to_summarize[-1].timestamp,
            }
            self._summaries.append(summary_entry)

            logger.info(
                "Rolling summary generated: %d messages summarized",
                len(messages_to_summarize),
            )
        except Exception as e:
            logger.error("Failed to generate rolling summary: %s", e)

    def get_statistics(self) -> dict[str, Any]:
        """Return statistics about the conversation memory.

        Returns:
            A dictionary containing memory usage statistics including
            message counts by role, total messages, summaries, etc.
        """
        with self._lock:
            role_counts: dict[str, int] = {}
            total_chars: int = 0
            for msg in self._messages:
                role_counts[msg.role] = role_counts.get(msg.role, 0) + 1
                total_chars += len(msg.content)

        return {
            "session_id": self.session_id,
            "created_at": self._created_at,
            "updated_at": self._updated_at,
            "total_messages": len(self._messages),
            "max_messages": self.max_messages,
            "summaries_count": len(self._summaries),
            "role_counts": role_counts,
            "total_characters": total_chars,
            "average_message_length": (
                total_chars / len(self._messages) if self._messages else 0
            ),
            "memory_utilization": len(self._messages) / self.max_messages,
        }

    def export_as_markdown(self) -> str:
        """Export the conversation as a formatted Markdown string.

        Returns:
            A Markdown-formatted string of the entire conversation.
        """
        lines: list[str] = [
            f"# Conversation: {self.session_id}",
            f"**Created**: {self._created_at}",
            f"**Updated**: {self._updated_at}",
            "",
        ]

        # Include summaries
        if self._summaries:
            lines.append("## Previous Summaries")
            for summary in self._summaries:
                lines.append(f"- **{summary['period_start']}** to "
                             f"**{summary['period_end']}**: {summary['summary']}")
            lines.append("")

        # Include messages
        lines.append("## Messages")
        with self._lock:
            for msg in self._messages:
                role_label = msg.role.capitalize()
                lines.append(f"**{role_label}** ({msg.timestamp}):")
                lines.append(f"> {msg.content}")
                lines.append("")

        return "\n".join(lines)

    def export_as_text(self) -> str:
        """Export the conversation as plain text.

        Returns:
            A plain-text representation of the conversation.
        """
        lines: list[str] = []
        with self._lock:
            for msg in self._messages:
                lines.append(f"[{msg.timestamp}] {msg.role}: {msg.content}")
        return "\n".join(lines)

    def get_last_message(self) -> Optional[dict[str, Any]]:
        """Return the most recent message, or None if memory is empty.

        Returns:
            The last message as a dictionary, or None.
        """
        with self._lock:
            if self._messages:
                return self._messages[-1].to_dict()
        return None

    def get_last_user_message(self) -> Optional[dict[str, Any]]:
        """Return the most recent user message, or None if no user messages.

        Returns:
            The last user message as a dictionary, or None.
        """
        with self._lock:
            for msg in reversed(self._messages):
                if msg.role == "user":
                    return msg.to_dict()
        return None

    def get_last_assistant_message(self) -> Optional[dict[str, Any]]:
        """Return the most recent assistant message, or None.

        Returns:
            The last assistant message as a dictionary, or None.
        """
        with self._lock:
            for msg in reversed(self._messages):
                if msg.role == "assistant":
                    return msg.to_dict()
        return None

    def remove_message(self, message_id: str) -> bool:
        """Remove a specific message by its ID.

        Args:
            message_id: The unique identifier of the message to remove.

        Returns:
            True if the message was found and removed, False otherwise.
        """
        with self._lock:
            new_messages = deque(maxlen=self.max_messages)
            found = False
            for msg in self._messages:
                if msg.id == message_id:
                    found = True
                    continue
                new_messages.append(msg)
            if found:
                self._messages = new_messages
                self._updated_at = datetime.now(timezone.utc).isoformat()
        return found

    def update_message_metadata(
        self, message_id: str, metadata: dict[str, Any]
    ) -> bool:
        """Update the metadata of a specific message.

        Args:
            message_id: The unique identifier of the message to update.
            metadata: The new metadata dictionary to merge with existing.

        Returns:
            True if the message was found and updated, False otherwise.
        """
        with self._lock:
            for msg in self._messages:
                if msg.id == message_id:
                    msg.metadata.update(metadata)
                    self._updated_at = datetime.now(timezone.utc).isoformat()
                    return True
        return False

    def __len__(self) -> int:
        """Return the number of messages in memory."""
        return len(self._messages)

    def __repr__(self) -> str:
        """Return a string representation of the conversation memory."""
        return (
            f"ConversationMemory(session={self.session_id!r}, "
            f"messages={len(self._messages)}, "
            f"summaries={len(self._summaries)})"
        )
