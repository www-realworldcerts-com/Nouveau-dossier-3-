"""
JARVIS Security Module

Provides comprehensive security features including JWT authentication,
AES-256-GCM encryption, password hashing with PBKDF2, rate limiting
with sliding windows, API key validation, and audit logging.

Features:
    - JWT token creation, validation, refresh, and revocation
    - AES-256-GCM authenticated encryption/decryption
    - PBKDF2-HMAC-SHA256 password hashing and verification
    - Sliding window rate limiting per client IP
    - API key validation and management
    - Comprehensive audit logging with event types
    - TokenManager for automatic token lifecycle management

Security Notes:
    - AES-256-GCM provides both confidentiality and integrity
    - PBKDF2 uses 600,000 iterations (OWASP 2023 recommendation)
    - JWT tokens use HS256 with configurable secret
    - Rate limiting uses in-memory sliding window counters
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Optional

import jwt

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.backends import default_backend
from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)


class SecurityEventType(str, Enum):
    """Enumeration of security event types for audit logging."""
    LOGIN_SUCCESS = "login_success"
    LOGIN_FAILURE = "login_failure"
    TOKEN_CREATED = "token_created"
    TOKEN_VALIDATED = "token_validated"
    TOKEN_REFRESHED = "token_refreshed"
    TOKEN_REVOKED = "token_revoked"
    TOKEN_EXPIRED = "token_expired"
    RATE_LIMIT_HIT = "rate_limit_hit"
    RATE_LIMIT_BLOCKED = "rate_limit_blocked"
    API_KEY_VALIDATED = "api_key_validated"
    API_KEY_INVALID = "api_key_invalid"
    ENCRYPTION_PERFORMED = "encryption_performed"
    DECRYPTION_PERFORMED = "decryption_performed"
    PASSWORD_HASHED = "password_hashed"
    PASSWORD_VERIFIED = "password_verified"
    PASSWORD_VERIFICATION_FAILED = "password_verification_failed"
    UNAUTHORIZED_ACCESS = "unauthorized_access"
    SUSPICIOUS_ACTIVITY = "suspicious_activity"
    CONFIG_CHANGE = "config_change"
    DATA_EXPORT = "data_export"
    FILE_ACCESS = "file_access"


class AuditLog:
    """Thread-safe audit log for security events.

    Stores security events in memory with optional persistence to JSON files.
    Each event includes a timestamp, event type, details, and client info.

    Args:
        max_entries: Maximum number of log entries to retain in memory.
        persist_path: Optional file path for persistent log storage.
    """

    def __init__(
        self,
        max_entries: int = 10_000,
        persist_path: Optional[str | Path] = None,
    ) -> None:
        """Initialize the AuditLog.

        Args:
            max_entries: Maximum in-memory log entries before rotation.
            persist_path: Optional path to persist logs to disk.
        """
        self.max_entries: int = max_entries
        self.persist_path: Optional[Path] = (
            Path(persist_path) if persist_path else None
        )
        self._entries: list[dict[str, Any]] = []
        self._lock: threading.Lock = threading.Lock()

    def log(
        self,
        event_type: SecurityEventType,
        details: Optional[dict[str, Any]] = None,
        client_id: Optional[str] = None,
        severity: str = "info",
    ) -> dict[str, Any]:
        """Record a security event in the audit log.

        Args:
            event_type: The type of security event.
            details: Optional dictionary with event-specific details.
            client_id: Optional identifier for the client/source.
            severity: Severity level (info, warning, critical).

        Returns:
            The created log entry dictionary.
        """
        entry = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type.value,
            "severity": severity,
            "client_id": client_id,
            "details": details or {},
        }

        with self._lock:
            self._entries.append(entry)
            if len(self._entries) > self.max_entries:
                # Rotate: persist oldest entries if path configured
                if self.persist_path:
                    self._persist_entries(self._entries[:1000])
                self._entries = self._entries[-self.max_entries:]

        logger.debug(
            "Audit log: %s [%s] client=%s",
            event_type.value, severity, client_id,
        )
        return entry

    def _persist_entries(self, entries: list[dict[str, Any]]) -> None:
        """Append log entries to the persistent storage file.

        Args:
            entries: List of log entry dictionaries to persist.
        """
        if not self.persist_path:
            return

        self.persist_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.persist_path, "a", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry, default=str) + "\n")

    def get_entries(
        self,
        event_type: Optional[SecurityEventType] = None,
        client_id: Optional[str] = None,
        severity: Optional[str] = None,
        limit: int = 100,
        since: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Retrieve audit log entries with optional filtering.

        Args:
            event_type: Filter by event type.
            client_id: Filter by client identifier.
            severity: Filter by severity level.
            limit: Maximum number of entries to return.
            since: ISO timestamp to filter entries after this time.

        Returns:
            A list of matching log entry dictionaries.
        """
        with self._lock:
            entries = list(self._entries)

        if event_type:
            entries = [e for e in entries if e["event_type"] == event_type.value]
        if client_id:
            entries = [e for e in entries if e["client_id"] == client_id]
        if severity:
            entries = [e for e in entries if e["severity"] == severity]
        if since:
            entries = [e for e in entries if e["timestamp"] >= since]

        return entries[-limit:]

    def get_summary(self) -> dict[str, Any]:
        """Return a summary of the audit log.

        Returns:
            A dictionary with event counts and statistics.
        """
        with self._lock:
            total = len(self._entries)
            event_counts: dict[str, int] = defaultdict(int)
            severity_counts: dict[str, int] = defaultdict(int)
            for entry in self._entries:
                event_counts[entry["event_type"]] += 1
                severity_counts[entry["severity"]] += 1

        return {
            "total_entries": total,
            "event_counts": dict(event_counts),
            "severity_counts": dict(severity_counts),
        }

    def clear(self) -> int:
        """Clear all entries from the audit log.

        Returns:
            The number of entries that were cleared.
        """
        with self._lock:
            count = len(self._entries)
            self._entries.clear()
        return count


class RateLimiter:
    """Sliding window rate limiter for per-client request throttling.

    Implements a sliding window algorithm that tracks request timestamps
    per client ID. Requests within the window are counted, and clients
    exceeding the limit are blocked until the window slides.

    Args:
        max_requests: Maximum number of requests allowed in the window.
        window_seconds: Size of the sliding window in seconds.
        cleanup_interval: Seconds between cleanup of expired windows.

    Example:
        >>> limiter = RateLimiter(max_requests=100, window_seconds=60)
        >>> if limiter.check_rate_limit("client_1"):
        ...     # Process request
        ... else:
        ...     # Rate limit exceeded
    """

    def __init__(
        self,
        max_requests: int = 100,
        window_seconds: int = 60,
        cleanup_interval: int = 300,
    ) -> None:
        """Initialize the RateLimiter.

        Args:
            max_requests: Maximum requests per window per client.
            window_seconds: Sliding window duration in seconds.
            cleanup_interval: Seconds between cleanup of stale entries.
        """
        self.max_requests: int = max_requests
        self.window_seconds: int = window_seconds
        self.cleanup_interval: int = cleanup_interval
        self._requests: dict[str, list[float]] = defaultdict(list)
        self._blocked: dict[str, float] = {}
        self._lock: threading.Lock = threading.Lock()
        self._last_cleanup: float = time.time()

    def check_rate_limit(self, client_id: str) -> bool:
        """Check if a client is within rate limits.

        Records the request timestamp and checks if the client has exceeded
        the maximum number of requests within the sliding window.

        Args:
            client_id: The unique identifier for the client (e.g., IP address).

        Returns:
            True if the request is allowed, False if rate limited.
        """
        now = time.time()
        window_start = now - self.window_seconds

        with self._lock:
            # Periodic cleanup
            if now - self._last_cleanup > self.cleanup_interval:
                self._cleanup(now)
                self._last_cleanup = now

            # Check if client is temporarily blocked
            if client_id in self._blocked:
                if now < self._blocked[client_id]:
                    return False
                del self._blocked[client_id]

            # Filter requests within the current window
            self._requests[client_id] = [
                ts for ts in self._requests[client_id] if ts > window_start
            ]

            # Check if limit exceeded
            if len(self._requests[client_id]) >= self.max_requests:
                logger.warning(
                    "Rate limit exceeded for client %s: %d/%d in %ds window",
                    client_id,
                    len(self._requests[client_id]),
                    self.max_requests,
                    self.window_seconds,
                )
                return False

            # Record the request
            self._requests[client_id].append(now)
            return True

    def block_client(self, client_id: str, duration_seconds: int = 300) -> None:
        """Temporarily block a client from making requests.

        Args:
            client_id: The client identifier to block.
            duration_seconds: Duration of the block in seconds.
        """
        with self._lock:
            self._blocked[client_id] = time.time() + duration_seconds
        logger.warning(
            "Client %s blocked for %d seconds", client_id, duration_seconds
        )

    def unblock_client(self, client_id: str) -> bool:
        """Remove a block on a client.

        Args:
            client_id: The client identifier to unblock.

        Returns:
            True if the client was blocked and is now unblocked.
        """
        with self._lock:
            return self._blocked.pop(client_id, None) is not None

    def get_client_status(self, client_id: str) -> dict[str, Any]:
        """Get rate limit status for a specific client.

        Args:
            client_id: The client identifier to check.

        Returns:
            A dictionary with the client's rate limit status.
        """
        now = time.time()
        window_start = now - self.window_seconds

        with self._lock:
            requests = [
                ts for ts in self._requests.get(client_id, [])
                if ts > window_start
            ]
            is_blocked = client_id in self._blocked and now < self._blocked.get(client_id, 0)

        return {
            "client_id": client_id,
            "requests_in_window": len(requests),
            "max_requests": self.max_requests,
            "window_seconds": self.window_seconds,
            "remaining": max(0, self.max_requests - len(requests)),
            "is_blocked": is_blocked,
            "block_expires_at": (
                datetime.fromtimestamp(self._blocked[client_id], tz=timezone.utc).isoformat()
                if is_blocked else None
            ),
            "reset_at": (
                datetime.fromtimestamp(
                    min(requests) + self.window_seconds, tz=timezone.utc
                ).isoformat()
                if requests else None
            ),
        }

    def _cleanup(self, now: float) -> None:
        """Remove expired request timestamps and blocks.

        Args:
            now: Current timestamp for comparison.
        """
        window_start = now - self.window_seconds

        # Clean up expired request windows
        expired_clients = [
            client_id
            for client_id, timestamps in self._requests.items()
            if not any(ts > window_start for ts in timestamps)
        ]
        for client_id in expired_clients:
            del self._requests[client_id]

        # Clean up expired blocks
        expired_blocks = [
            client_id
            for client_id, expiry in self._blocked.items()
            if now >= expiry
        ]
        for client_id in expired_blocks:
            del self._blocked[client_id]

        logger.debug(
            "Rate limiter cleanup: removed %d expired clients, %d expired blocks",
            len(expired_clients),
            len(expired_blocks),
        )

    def reset(self) -> None:
        """Reset all rate limit counters and blocks."""
        with self._lock:
            self._requests.clear()
            self._blocked.clear()
        logger.info("Rate limiter reset")

    def get_stats(self) -> dict[str, Any]:
        """Return rate limiter statistics.

        Returns:
            A dictionary with rate limiter statistics.
        """
        with self._lock:
            return {
                "tracked_clients": len(self._requests),
                "blocked_clients": len(self._blocked),
                "max_requests": self.max_requests,
                "window_seconds": self.window_seconds,
            }


class TokenManager:
    """Manages JWT token lifecycle including creation, validation, and revocation.

    Handles creation of JWT access and refresh tokens, validation with
    revocation checking, and automatic refresh within the grace period.

    Args:
        secret_key: The secret key for JWT signing. Auto-generated if not provided.
        access_token_expiry: Access token validity duration in minutes.
        refresh_token_expiry: Refresh token validity duration in days.
        issuer: Token issuer identifier.
        audience: Token audience identifier.
    """

    def __init__(
        self,
        secret_key: Optional[str] = None,
        access_token_expiry: int = 30,
        refresh_token_expiry: int = 7,
        issuer: str = "jarvis-ai",
        audience: str = "jarvis-users",
    ) -> None:
        """Initialize the TokenManager.

        Args:
            secret_key: JWT signing secret. Auto-generated if not provided.
            access_token_expiry: Access token expiry in minutes.
            refresh_token_expiry: Refresh token expiry in days.
            issuer: Token issuer claim.
            audience: Token audience claim.
        """
        self.secret_key: str = secret_key or secrets.token_hex(32)
        self.access_token_expiry: int = access_token_expiry
        self.refresh_token_expiry: int = refresh_token_expiry
        self.issuer: str = issuer
        self.audience: str = audience
        self._revoked_tokens: set[str] = set()
        self._lock: threading.Lock = threading.Lock()

        logger.info("TokenManager initialized (access=%dm, refresh=%dd)",
                     access_token_expiry, refresh_token_expiry)

    def create_access_token(
        self,
        user_id: str,
        role: str = "user",
        additional_claims: Optional[dict[str, Any]] = None,
    ) -> str:
        """Create a new JWT access token.

        Args:
            user_id: The user identifier to embed in the token.
            role: The user role (user, admin, etc.).
            additional_claims: Optional additional JWT claims.

        Returns:
            The encoded JWT access token string.
        """
        now = datetime.now(timezone.utc)
        payload = {
            "sub": user_id,
            "role": role,
            "type": "access",
            "iss": self.issuer,
            "aud": self.audience,
            "iat": now,
            "nbf": now,
            "exp": now + timedelta(minutes=self.access_token_expiry),
            "jti": str(uuid.uuid4()),
        }
        if additional_claims:
            payload.update(additional_claims)

        token = jwt.encode(payload, self.secret_key, algorithm="HS256")
        logger.debug("Access token created for user: %s", user_id)
        return token

    def create_refresh_token(
        self,
        user_id: str,
        role: str = "user",
    ) -> str:
        """Create a new JWT refresh token.

        Args:
            user_id: The user identifier to embed in the token.
            role: The user role.

        Returns:
            The encoded JWT refresh token string.
        """
        now = datetime.now(timezone.utc)
        payload = {
            "sub": user_id,
            "role": role,
            "type": "refresh",
            "iss": self.issuer,
            "aud": self.audience,
            "iat": now,
            "nbf": now,
            "exp": now + timedelta(days=self.refresh_token_expiry),
            "jti": str(uuid.uuid4()),
        }

        token = jwt.encode(payload, self.secret_key, algorithm="HS256")
        logger.debug("Refresh token created for user: %s", user_id)
        return token

    def validate_token(self, token: str) -> dict[str, Any]:
        """Validate a JWT token and return its payload.

        Checks signature, expiry, revocation status, and required claims.

        Args:
            token: The JWT token string to validate.

        Returns:
            The decoded token payload dictionary.

        Raises:
            jwt.ExpiredSignatureError: If the token has expired.
            jwt.InvalidTokenError: If the token is invalid or revoked.
        """
        try:
            payload = jwt.decode(
                token,
                self.secret_key,
                algorithms=["HS256"],
                audience=self.audience,
                issuer=self.issuer,
            )
        except jwt.ExpiredSignatureError:
            logger.warning("Token expired")
            raise
        except jwt.InvalidTokenError as e:
            logger.warning("Invalid token: %s", e)
            raise

        # Check revocation
        jti = payload.get("jti", "")
        with self._lock:
            if jti in self._revoked_tokens:
                raise jwt.InvalidTokenError("Token has been revoked")

        return payload

    def refresh_token(self, refresh_token_str: str) -> dict[str, str]:
        """Refresh an access token using a valid refresh token.

        Args:
            refresh_token_str: The refresh token to use.

        Returns:
            A dictionary with new 'access_token' and 'refresh_token'.

        Raises:
            jwt.InvalidTokenError: If the refresh token is invalid.
            ValueError: If the token is not a refresh token.
        """
        payload = self.validate_token(refresh_token_str)

        if payload.get("type") != "refresh":
            raise ValueError("Not a refresh token")

        # Revoke the old refresh token
        old_jti = payload.get("jti", "")
        with self._lock:
            self._revoked_tokens.add(old_jti)

        # Create new tokens
        user_id = payload["sub"]
        role = payload.get("role", "user")

        new_access = self.create_access_token(user_id, role)
        new_refresh = self.create_refresh_token(user_id, role)

        logger.info("Token refreshed for user: %s", user_id)
        return {
            "access_token": new_access,
            "refresh_token": new_refresh,
        }

    def revoke_token(self, token: str) -> bool:
        """Revoke a JWT token by its JTI claim.

        Args:
            token: The JWT token to revoke.

        Returns:
            True if the token was successfully revoked.
        """
        try:
            payload = jwt.decode(
                token,
                self.secret_key,
                algorithms=["HS256"],
                options={"verify_exp": False},  # Allow revoking expired tokens
            )
            jti = payload.get("jti", "")
            with self._lock:
                self._revoked_tokens.add(jti)
            logger.info("Token revoked: jti=%s", jti)
            return True
        except jwt.InvalidTokenError as e:
            logger.warning("Failed to revoke token: %s", e)
            return False

    def is_revoked(self, jti: str) -> bool:
        """Check if a token JTI has been revoked.

        Args:
            jti: The JTI claim of the token.

        Returns:
            True if the token has been revoked.
        """
        with self._lock:
            return jti in self._revoked_tokens

    def cleanup_revoked(self) -> int:
        """Remove expired tokens from the revocation list.

        Returns:
            The number of revoked tokens that were cleaned up.
        """
        # Note: Without storing the full token, we can't easily check expiry
        # In production, use a Redis TTL or database with expiry
        logger.info("Revoked token cleanup performed")
        return 0


class SecurityManager:
    """Comprehensive security manager for JARVIS AI Agent.

    Provides a unified interface for all security operations including
    JWT token management, AES-256-GCM encryption, PBKDF2 password hashing,
    rate limiting, API key validation, and audit logging.

    Args:
        config: Optional configuration dictionary with security settings.

    Example:
        >>> sm = SecurityManager(config={"jwt_secret": "my-secret"})
        >>> token = sm.generate_token("user123", "admin")
        >>> payload = sm.validate_token(token)
        >>> encrypted = sm.encrypt_data("sensitive data")
        >>> decrypted = sm.decrypt_data(encrypted)
    """

    def __init__(self, config: Optional[dict[str, Any]] = None) -> None:
        """Initialize the SecurityManager.

        Args:
            config: Optional configuration dictionary. Supported keys:
                - jwt_secret: JWT signing secret
                - jwt_access_expiry: Access token expiry in minutes
                - jwt_refresh_expiry: Refresh token expiry in days
                - encryption_key: Fernet-compatible encryption key
                - rate_limit_max: Max requests per window
                - rate_limit_window: Window size in seconds
                - audit_log_path: Path for persistent audit logs
                - api_keys: Dict of valid API keys and their metadata
        """
        self._config: dict[str, Any] = config or {}

        # Initialize Token Manager
        self._token_manager = TokenManager(
            secret_key=self._config.get("jwt_secret"),
            access_token_expiry=self._config.get("jwt_access_expiry", 30),
            refresh_token_expiry=self._config.get("jwt_refresh_expiry", 7),
        )

        # Initialize encryption
        encryption_key = self._config.get("encryption_key")
        if encryption_key:
            self._fernet = Fernet(encryption_key.encode() if isinstance(encryption_key, str) else encryption_key)
        else:
            self._fernet = Fernet(Fernet.generate_key())
            logger.info("Auto-generated Fernet encryption key")

        # AES-256-GCM key (32 bytes)
        aes_key_b64 = self._config.get("aes_key")
        if aes_key_b64:
            self._aes_key = base64.b64decode(aes_key_b64)
        else:
            self._aes_key = os.urandom(32)
            logger.info("Auto-generated AES-256 key")

        self._aesgcm = AESGCM(self._aes_key)

        # Initialize Rate Limiter
        self._rate_limiter = RateLimiter(
            max_requests=self._config.get("rate_limit_max", 100),
            window_seconds=self._config.get("rate_limit_window", 60),
        )

        # Initialize Audit Log
        self._audit_log = AuditLog(
            persist_path=self._config.get("audit_log_path"),
        )

        # Initialize API keys
        self._api_keys: dict[str, dict[str, Any]] = self._config.get(
            "api_keys", {}
        )

        logger.info("SecurityManager initialized")

    # ─── Token Operations ─────────────────────────────────────────────────

    def generate_token(
        self,
        user_id: str,
        role: str = "user",
        additional_claims: Optional[dict[str, Any]] = None,
    ) -> str:
        """Generate a new JWT access token.

        Args:
            user_id: The user identifier.
            role: The user's role.
            additional_claims: Optional additional JWT claims.

        Returns:
            The encoded JWT access token string.
        """
        token = self._token_manager.create_access_token(
            user_id, role, additional_claims
        )
        self._audit_log.log(
            SecurityEventType.TOKEN_CREATED,
            details={"user_id": user_id, "role": role},
            client_id=user_id,
        )
        return token

    def generate_token_pair(
        self,
        user_id: str,
        role: str = "user",
    ) -> dict[str, str]:
        """Generate both access and refresh tokens.

        Args:
            user_id: The user identifier.
            role: The user's role.

        Returns:
            Dictionary with 'access_token' and 'refresh_token' keys.
        """
        access = self._token_manager.create_access_token(user_id, role)
        refresh = self._token_manager.create_refresh_token(user_id, role)
        self._audit_log.log(
            SecurityEventType.TOKEN_CREATED,
            details={"user_id": user_id, "role": role, "type": "pair"},
            client_id=user_id,
        )
        return {"access_token": access, "refresh_token": refresh}

    def validate_token(self, token: str) -> dict[str, Any]:
        """Validate a JWT token and return its payload.

        Args:
            token: The JWT token string.

        Returns:
            The decoded token payload.

        Raises:
            jwt.InvalidTokenError: If the token is invalid or revoked.
        """
        payload = self._token_manager.validate_token(token)
        self._audit_log.log(
            SecurityEventType.TOKEN_VALIDATED,
            details={"user_id": payload.get("sub")},
            client_id=payload.get("sub"),
        )
        return payload

    def refresh_token(self, refresh_token_str: str) -> dict[str, str]:
        """Refresh tokens using a valid refresh token.

        Args:
            refresh_token_str: The refresh token.

        Returns:
            New access and refresh token pair.

        Raises:
            jwt.InvalidTokenError: If the refresh token is invalid.
        """
        result = self._token_manager.refresh_token(refresh_token_str)
        self._audit_log.log(
            SecurityEventType.TOKEN_REFRESHED,
            details={"user_id": result.get("access_token", "")[:20] + "..."},
        )
        return result

    def revoke_token(self, token: str) -> bool:
        """Revoke a JWT token.

        Args:
            token: The JWT token to revoke.

        Returns:
            True if the token was revoked successfully.
        """
        success = self._token_manager.revoke_token(token)
        self._audit_log.log(
            SecurityEventType.TOKEN_REVOKED,
            details={"success": success},
        )
        return success

    # ─── Encryption Operations ────────────────────────────────────────────

    def encrypt_data(self, data: str) -> str:
        """Encrypt data using AES-256-GCM and return base64-encoded ciphertext.

        AES-256-GCM provides authenticated encryption, ensuring both
        confidentiality and integrity of the data. A random 12-byte nonce
        is generated for each encryption operation and prepended to the
        ciphertext.

        Args:
            data: The plaintext string to encrypt.

        Returns:
            A base64-encoded string containing nonce + ciphertext + tag.
        """
        nonce = os.urandom(12)
        plaintext = data.encode("utf-8")
        ciphertext = self._aesgcm.encrypt(nonce, plaintext, associated_data=None)

        # Prepend nonce to ciphertext for decryption
        encrypted = nonce + ciphertext
        encoded = base64.b64encode(encrypted).decode("utf-8")

        self._audit_log.log(
            SecurityEventType.ENCRYPTION_PERFORMED,
            details={"algorithm": "AES-256-GCM", "data_length": len(data)},
        )
        return encoded

    def decrypt_data(self, encrypted_data: str) -> str:
        """Decrypt base64-encoded AES-256-GCM encrypted data.

        Args:
            encrypted_data: The base64-encoded encrypted string (nonce + ciphertext + tag).

        Returns:
            The decrypted plaintext string.

        Raises:
            ValueError: If decryption fails (wrong key, corrupted data, etc.).
        """
        try:
            encrypted = base64.b64decode(encrypted_data)
            nonce = encrypted[:12]
            ciphertext = encrypted[12:]
            plaintext = self._aesgcm.decrypt(nonce, ciphertext, associated_data=None)
            result = plaintext.decode("utf-8")

            self._audit_log.log(
                SecurityEventType.DECRYPTION_PERFORMED,
                details={"algorithm": "AES-256-GCM"},
            )
            return result
        except Exception as e:
            self._audit_log.log(
                SecurityEventType.SUSPICIOUS_ACTIVITY,
                details={"action": "decryption_failed", "error": str(e)},
                severity="warning",
            )
            raise ValueError(f"Decryption failed: {e}") from e

    def encrypt_data_fernet(self, data: str) -> str:
        """Encrypt data using Fernet (AES-128-CBC with HMAC-SHA256).

        An alternative to AES-256-GCM using the Fernet construction.

        Args:
            data: The plaintext string to encrypt.

        Returns:
            A Fernet-encoded token string.
        """
        encrypted = self._fernet.encrypt(data.encode("utf-8")).decode("utf-8")
        self._audit_log.log(
            SecurityEventType.ENCRYPTION_PERFORMED,
            details={"algorithm": "Fernet"},
        )
        return encrypted

    def decrypt_data_fernet(self, encrypted_data: str) -> str:
        """Decrypt Fernet-encrypted data.

        Args:
            encrypted_data: The Fernet token string.

        Returns:
            The decrypted plaintext string.

        Raises:
            ValueError: If decryption fails.
        """
        try:
            decrypted = self._fernet.decrypt(encrypted_data.encode("utf-8")).decode("utf-8")
            self._audit_log.log(
                SecurityEventType.DECRYPTION_PERFORMED,
                details={"algorithm": "Fernet"},
            )
            return decrypted
        except Exception as e:
            raise ValueError(f"Fernet decryption failed: {e}") from e

    # ─── Password Operations ──────────────────────────────────────────────

    def hash_password(
        self,
        password: str,
        salt: Optional[bytes] = None,
        iterations: int = 600_000,
    ) -> dict[str, str]:
        """Hash a password using PBKDF2-HMAC-SHA256.

        Uses the OWASP-recommended 600,000 iterations for SHA-256.
        A random 16-byte salt is generated if not provided.

        Args:
            password: The plaintext password to hash.
            salt: Optional salt bytes; auto-generated if not provided.
            iterations: Number of PBKDF2 iterations (default: 600,000).

        Returns:
            A dictionary with 'hash' (hex), 'salt' (base64), and 'iterations'.
        """
        if salt is None:
            salt = os.urandom(16)

        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=iterations,
            backend=default_backend(),
        )
        password_hash = kdf.derive(password.encode("utf-8"))

        result = {
            "hash": password_hash.hex(),
            "salt": base64.b64encode(salt).decode("utf-8"),
            "iterations": iterations,
        }

        self._audit_log.log(
            SecurityEventType.PASSWORD_HASHED,
            details={"iterations": iterations},
        )
        return result

    def verify_password(
        self,
        password: str,
        stored_hash: str,
        salt: str,
        iterations: int = 600_000,
    ) -> bool:
        """Verify a password against a stored hash.

        Args:
            password: The plaintext password to verify.
            stored_hash: The stored hex-encoded hash.
            salt: The base64-encoded salt used during hashing.
            iterations: The number of PBKDF2 iterations used.

        Returns:
            True if the password matches, False otherwise.
        """
        try:
            salt_bytes = base64.b64decode(salt)
            kdf = PBKDF2HMAC(
                algorithm=hashes.SHA256(),
                length=32,
                salt=salt_bytes,
                iterations=iterations,
                backend=default_backend(),
            )
            computed_hash = kdf.derive(password.encode("utf-8"))
            match = secrets.compare_digest(
                computed_hash.hex(), stored_hash
            )

            event = (
                SecurityEventType.PASSWORD_VERIFIED
                if match
                else SecurityEventType.PASSWORD_VERIFICATION_FAILED
            )
            self._audit_log.log(
                event,
                details={"match": match},
                severity="info" if match else "warning",
            )
            return match
        except Exception as e:
            logger.error("Password verification error: %s", e)
            self._audit_log.log(
                SecurityEventType.PASSWORD_VERIFICATION_FAILED,
                details={"error": str(e)},
                severity="warning",
            )
            return False

    # ─── Rate Limiting ────────────────────────────────────────────────────

    def check_rate_limit(self, client_id: str) -> bool:
        """Check if a client is within rate limits.

        Args:
            client_id: The client identifier (e.g., IP address).

        Returns:
            True if the request is allowed, False if rate limited.
        """
        allowed = self._rate_limiter.check_rate_limit(client_id)
        if not allowed:
            self._audit_log.log(
                SecurityEventType.RATE_LIMIT_BLOCKED,
                details={"client_id": client_id},
                client_id=client_id,
                severity="warning",
            )
        return allowed

    def block_client(self, client_id: str, duration_seconds: int = 300) -> None:
        """Temporarily block a client from making requests.

        Args:
            client_id: The client identifier to block.
            duration_seconds: Block duration in seconds.
        """
        self._rate_limiter.block_client(client_id, duration_seconds)
        self._audit_log.log(
            SecurityEventType.RATE_LIMIT_BLOCKED,
            details={"client_id": client_id, "duration": duration_seconds},
            client_id=client_id,
            severity="warning",
        )

    def get_rate_limit_status(self, client_id: str) -> dict[str, Any]:
        """Get rate limit status for a specific client.

        Args:
            client_id: The client identifier.

        Returns:
            Rate limit status dictionary.
        """
        return self._rate_limiter.get_client_status(client_id)

    # ─── API Key Validation ───────────────────────────────────────────────

    def validate_api_key(self, api_key: str) -> Optional[dict[str, Any]]:
        """Validate an API key and return its metadata.

        Args:
            api_key: The API key string to validate.

        Returns:
            The API key metadata dictionary if valid, None otherwise.
        """
        key_data = self._api_keys.get(api_key)
        if key_data is None:
            self._audit_log.log(
                SecurityEventType.API_KEY_INVALID,
                details={"api_key_prefix": api_key[:8] + "..."},
                severity="warning",
            )
            return None

        # Check if key is expired
        if expires_at := key_data.get("expires_at"):
            if datetime.now(timezone.utc).isoformat() > expires_at:
                self._audit_log.log(
                    SecurityEventType.API_KEY_INVALID,
                    details={"reason": "expired", "api_key_prefix": api_key[:8] + "..."},
                    severity="warning",
                )
                return None

        # Check if key is disabled
        if key_data.get("disabled", False):
            self._audit_log.log(
                SecurityEventType.API_KEY_INVALID,
                details={"reason": "disabled", "api_key_prefix": api_key[:8] + "..."},
                severity="warning",
            )
            return None

        self._audit_log.log(
            SecurityEventType.API_KEY_VALIDATED,
            details={"name": key_data.get("name", "unknown")},
        )
        return key_data

    def add_api_key(
        self,
        api_key: str,
        name: str,
        role: str = "user",
        expires_at: Optional[str] = None,
    ) -> dict[str, Any]:
        """Add a new API key to the valid keys store.

        Args:
            api_key: The API key string.
            name: A human-readable name for the key.
            role: The role associated with this key.
            expires_at: Optional ISO timestamp for key expiry.

        Returns:
            The created API key metadata dictionary.
        """
        metadata = {
            "name": name,
            "role": role,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": expires_at,
            "disabled": False,
        }
        self._api_keys[api_key] = metadata
        logger.info("API key added: %s (role=%s)", name, role)
        return metadata

    def revoke_api_key(self, api_key: str) -> bool:
        """Revoke an API key by marking it as disabled.

        Args:
            api_key: The API key to revoke.

        Returns:
            True if the key was found and revoked.
        """
        if api_key in self._api_keys:
            self._api_keys[api_key]["disabled"] = True
            self._audit_log.log(
                SecurityEventType.CONFIG_CHANGE,
                details={"action": "api_key_revoked", "name": self._api_keys[api_key].get("name")},
                severity="warning",
            )
            return True
        return False

    def generate_api_key(
        self,
        name: str,
        role: str = "user",
        expires_days: Optional[int] = None,
    ) -> str:
        """Generate a new random API key and register it.

        Args:
            name: A human-readable name for the key.
            role: The role associated with this key.
            expires_days: Optional number of days until expiry.

        Returns:
            The generated API key string.
        """
        api_key = f"jarvis_{secrets.token_hex(24)}"
        expires_at = None
        if expires_days:
            expires_at = (
                datetime.now(timezone.utc) + timedelta(days=expires_days)
            ).isoformat()

        self.add_api_key(api_key, name, role, expires_at)
        return api_key

    # ─── Audit Logging ────────────────────────────────────────────────────

    def log_security_event(
        self,
        event_type: SecurityEventType,
        details: Optional[dict[str, Any]] = None,
        client_id: Optional[str] = None,
        severity: str = "info",
    ) -> dict[str, Any]:
        """Log a security event to the audit log.

        Args:
            event_type: The type of security event.
            details: Optional event-specific details.
            client_id: Optional client identifier.
            severity: Severity level (info, warning, critical).

        Returns:
            The created audit log entry.
        """
        return self._audit_log.log(event_type, details, client_id, severity)

    def get_audit_log(
        self,
        event_type: Optional[SecurityEventType] = None,
        client_id: Optional[str] = None,
        severity: Optional[str] = None,
        limit: int = 100,
        since: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Retrieve audit log entries with optional filtering.

        Args:
            event_type: Filter by event type.
            client_id: Filter by client identifier.
            severity: Filter by severity.
            limit: Maximum entries to return.
            since: ISO timestamp filter.

        Returns:
            A list of matching audit log entries.
        """
        return self._audit_log.get_entries(
            event_type, client_id, severity, limit, since
        )

    def get_audit_summary(self) -> dict[str, Any]:
        """Return a summary of the audit log.

        Returns:
            Audit log summary dictionary.
        """
        return self._audit_log.get_summary()

    # ─── Utility Methods ──────────────────────────────────────────────────

    def get_encryption_key_b64(self) -> str:
        """Return the AES-256 encryption key as a base64 string.

        Returns:
            The base64-encoded AES key for storage/configuration.
        """
        return base64.b64encode(self._aes_key).decode("utf-8")

    def get_fernet_key_str(self) -> str:
        """Return the Fernet encryption key as a string.

        Returns:
            The Fernet key string for storage/configuration.
        """
        return self._fernet._signing_key.hex()

    def get_security_status(self) -> dict[str, Any]:
        """Return the overall security system status.

        Returns:
            A dictionary with security system status information.
        """
        return {
            "token_manager": {
                "access_token_expiry_minutes": self._token_manager.access_token_expiry,
                "refresh_token_expiry_days": self._token_manager.refresh_token_expiry,
                "revoked_tokens_count": len(self._token_manager._revoked_tokens),
            },
            "rate_limiter": self._rate_limiter.get_stats(),
            "audit_log": self._audit_log.get_summary(),
            "api_keys": {
                "total": len(self._api_keys),
                "active": sum(
                    1 for v in self._api_keys.values() if not v.get("disabled", False)
                ),
            },
            "encryption": {
                "aes_256_gcm": True,
                "fernet": True,
                "pbkdf2_iterations": 600_000,
            },
        }

    def __repr__(self) -> str:
        """Return a string representation of the SecurityManager."""
        return (
            f"SecurityManager("
            f"rate_limit={self._rate_limiter.max_requests}/{self._rate_limiter.window_seconds}s, "
            f"api_keys={len(self._api_keys)})"
        )
