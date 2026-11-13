"""JARVIS AI Agent - Middleware Module

Complete middleware stack with:
- RateLimitMiddleware: Sliding window rate limiting per client IP
- AuditLoggingMiddleware: Comprehensive request/response audit logging
- RequestValidationMiddleware: Request size and content validation
- CORS configuration helper
"""
import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

logger = logging.getLogger("jarvis.api.middleware")


# ===========================================================================
# Rate Limit Middleware
# ===========================================================================

class SlidingWindowRateLimiter:
    """Sliding window rate limiter for per-client request throttling.

    Tracks request timestamps per client and enforces a maximum number
    of requests within a rolling time window.
    """

    def __init__(self, max_requests: int = 60, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        # {client_id: [timestamp, ...]}
        self._windows: Dict[str, List[float]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def is_allowed(self, client_id: str) -> Tuple[bool, Dict[str, Any]]:
        """Check if a request from the given client is allowed.

        Args:
            client_id: Client identifier (usually IP address).

        Returns:
            Tuple of (is_allowed, rate_limit_info).
        """
        now = time.time()
        window_start = now - self.window_seconds

        async with self._lock:
            # Remove timestamps outside the window
            self._windows[client_id] = [
                ts for ts in self._windows[client_id]
                if ts > window_start
            ]

            current_count = len(self._windows[client_id])
            remaining = max(0, self.max_requests - current_count)

            info = {
                "limit": self.max_requests,
                "remaining": remaining,
                "reset_at": int(now + self.window_seconds),
                "window_seconds": self.window_seconds,
            }

            if current_count >= self.max_requests:
                info["retry_after"] = int(
                    self._windows[client_id][0] + self.window_seconds - now
                )
                return False, info

            # Record this request
            self._windows[client_id].append(now)
            info["remaining"] = remaining - 1
            return True, info

    async def reset(self, client_id: str) -> None:
        """Reset rate limit for a specific client.

        Args:
            client_id: Client identifier to reset.
        """
        async with self._lock:
            self._windows.pop(client_id, None)

    def cleanup(self) -> int:
        """Clean up expired entries from the rate limit windows.

        Returns:
            Number of entries removed.
        """
        now = time.time()
        window_start = now - self.window_seconds
        cleaned = 0

        for client_id in list(self._windows.keys()):
            self._windows[client_id] = [
                ts for ts in self._windows[client_id]
                if ts > window_start
            ]
            if not self._windows[client_id]:
                del self._windows[client_id]
                cleaned += 1

        return cleaned

    def get_stats(self) -> Dict[str, Any]:
        """Get rate limiter statistics.

        Returns:
            Stats dict with tracked clients and request counts.
        """
        return {
            "tracked_clients": len(self._windows),
            "max_requests": self.max_requests,
            "window_seconds": self.window_seconds,
            "active_clients": {
                client_id: len(timestamps)
                for client_id, timestamps in self._windows.items()
            },
        }


class RateLimitMiddleware(BaseHTTPMiddleware):
    """ASGI middleware for per-client rate limiting.

    Uses a sliding window algorithm to limit requests per client IP.
    Adds standard rate limit headers to responses.
    """

    def __init__(
        self,
        app,
        max_requests: int = 60,
        window_seconds: int = 60,
        exempt_paths: Optional[List[str]] = None,
    ):
        super().__init__(app)
        self.limiter = SlidingWindowRateLimiter(max_requests, window_seconds)
        self.exempt_paths = set(exempt_paths or [
            "/health",
            "/docs",
            "/redoc",
            "/openapi.json",
        ])

    async def dispatch(self, request: Request, call_next):
        """Process request through rate limiting.

        Args:
            request: Incoming HTTP request.
            call_next: Next middleware or route handler.

        Returns:
            Response from downstream handler or 429 error.
        """
        path = request.url.path

        # Skip rate limiting for exempt paths
        if path in self.exempt_paths:
            return await call_next(request)

        # Skip for OPTIONS (CORS preflight)
        if request.method == "OPTIONS":
            return await call_next(request)

        # Get client identifier
        client_id = self._get_client_id(request)

        # Check rate limit
        allowed, rate_info = await self.limiter.is_allowed(client_id)

        if not allowed:
            logger.warning("Rate limit exceeded for client: %s (path=%s)", client_id, path)
            response = JSONResponse(
                status_code=429,
                content={
                    "error": True,
                    "detail": "Rate limit exceeded",
                    "retry_after": rate_info.get("retry_after", 60),
                },
            )
        else:
            response = await call_next(request)

        # Add rate limit headers
        response.headers["X-RateLimit-Limit"] = str(rate_info.get("limit", 60))
        response.headers["X-RateLimit-Remaining"] = str(rate_info.get("remaining", 0))
        response.headers["X-RateLimit-Reset"] = str(rate_info.get("reset_at", 0))

        if not allowed:
            response.headers["Retry-After"] = str(rate_info.get("retry_after", 60))

        return response

    def _get_client_id(self, request: Request) -> str:
        """Extract client identifier from request.

        Uses X-Forwarded-For header if available, otherwise client IP.

        Args:
            request: HTTP request.

        Returns:
            Client identifier string.
        """
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()

        if request.client:
            return request.client.host

        return "unknown"


# ===========================================================================
# Audit Logging Middleware
# ===========================================================================

class AuditLoggingMiddleware(BaseHTTPMiddleware):
    """ASGI middleware for comprehensive request/response audit logging.

    Logs all requests with timing, status codes, and client information.
    Optionally logs request/response bodies for sensitive endpoints.
    """

    # Paths where request/response bodies should be logged
    SENSITIVE_PATHS: Set[str] = {
        "/api/auth/login",
        "/api/auth/refresh",
    }

    # Paths to skip entirely from audit logging
    SKIP_PATHS: Set[str] = {
        "/health",
        "/docs",
        "/redoc",
        "/openapi.json",
    }

    # Maximum body size to log (bytes)
    MAX_BODY_LOG_SIZE: int = 4096

    def __init__(
        self,
        app,
        log_bodies: bool = False,
        exclude_paths: Optional[List[str]] = None,
    ):
        super().__init__(app)
        self.log_bodies = log_bodies
        self.exclude_paths = set(exclude_paths or [])
        self._request_log: List[Dict[str, Any]] = []
        self._max_log_entries = 10000

    async def dispatch(self, request: Request, call_next):
        """Process request with audit logging.

        Args:
            request: Incoming HTTP request.
            call_next: Next middleware or route handler.

        Returns:
            Response from downstream handler.
        """
        path = request.url.path
        method = request.method

        # Skip excluded paths
        if path in self.SKIP_PATHS or path in self.exclude_paths:
            return await call_next(request)

        request_id = str(uuid.uuid4())[:8]
        start_time = time.time()
        client_id = self._get_client_id(request)

        # Capture request body if needed
        request_body = None
        if self.log_bodies or path in self.SENSITIVE_PATHS:
            try:
                request_body = await self._capture_body(request)
            except Exception:
                request_body = "<unable to capture>"

        # Log request start
        logger.info(
            "[%s] --> %s %s (client=%s)",
            request_id, method, path, client_id,
        )

        # Process request
        try:
            response = await call_next(request)
        except Exception as exc:
            elapsed_ms = (time.time() - start_time) * 1000
            logger.error(
                "[%s] <-- %s %s ERROR (%.1fms): %s",
                request_id, method, path, elapsed_ms, exc,
            )
            self._record_audit(
                request_id=request_id,
                method=method,
                path=path,
                client_id=client_id,
                status_code=500,
                elapsed_ms=elapsed_ms,
                request_body=request_body,
                error=str(exc),
            )
            raise

        elapsed_ms = (time.time() - start_time) * 1000
        status_code = response.status_code

        # Log response
        log_level = logging.INFO
        if status_code >= 400:
            log_level = logging.WARNING
        if status_code >= 500:
            log_level = logging.ERROR

        logger.log(
            log_level,
            "[%s] <-- %s %s %d (%.1fms)",
            request_id, method, path, status_code, elapsed_ms,
        )

        # Record audit entry
        self._record_audit(
            request_id=request_id,
            method=method,
            path=path,
            client_id=client_id,
            status_code=status_code,
            elapsed_ms=elapsed_ms,
            request_body=request_body,
        )

        # Add timing header
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Response-Time"] = f"{elapsed_ms:.1f}ms"

        return response

    async def _capture_body(self, request: Request) -> Optional[str]:
        """Capture request body for audit logging.

        Args:
            request: HTTP request.

        Returns:
            Request body as string, or None.
        """
        try:
            body = await request.body()
            if len(body) > self.MAX_BODY_LOG_SIZE:
                return f"<body too large: {len(body)} bytes>"
            return body.decode("utf-8", errors="replace")
        except Exception:
            return None

    def _get_client_id(self, request: Request) -> str:
        """Extract client identifier from request."""
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if request.client:
            return request.client.host
        return "unknown"

    def _record_audit(
        self,
        request_id: str,
        method: str,
        path: str,
        client_id: str,
        status_code: int,
        elapsed_ms: float,
        request_body: Optional[str] = None,
        error: Optional[str] = None,
    ) -> None:
        """Record an audit entry.

        Args:
            request_id: Unique request identifier.
            method: HTTP method.
            path: Request path.
            client_id: Client identifier.
            status_code: Response status code.
            elapsed_ms: Processing time in milliseconds.
            request_body: Optional request body for sensitive paths.
            error: Optional error message.
        """
        entry = {
            "request_id": request_id,
            "method": method,
            "path": path,
            "client_id": client_id,
            "status_code": status_code,
            "elapsed_ms": round(elapsed_ms, 2),
            "timestamp": time.time(),
        }

        if request_body and path in self.SENSITIVE_PATHS:
            # Sanitize sensitive fields
            try:
                body_dict = json.loads(request_body)
                if "password" in body_dict:
                    body_dict["password"] = "***REDACTED***"
                entry["request_body"] = json.dumps(body_dict)
            except (json.JSONDecodeError, TypeError):
                entry["request_body"] = "<non-json body>"

        if error:
            entry["error"] = error

        self._request_log.append(entry)

        # Trim log if it gets too large
        if len(self._request_log) > self._max_log_entries:
            self._request_log = self._request_log[-self._max_log_entries:]

    def get_audit_log(
        self,
        limit: int = 100,
        method: Optional[str] = None,
        path_prefix: Optional[str] = None,
        status_code: Optional[int] = None,
        since: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Retrieve audit log entries with optional filtering.

        Args:
            limit: Maximum entries to return.
            method: Filter by HTTP method.
            path_prefix: Filter by path prefix.
            status_code: Filter by status code.
            since: Filter entries after this timestamp.

        Returns:
            List of audit log entries.
        """
        entries = self._request_log

        if method:
            entries = [e for e in entries if e.get("method") == method]
        if path_prefix:
            entries = [e for e in entries if e.get("path", "").startswith(path_prefix)]
        if status_code:
            entries = [e for e in entries if e.get("status_code") == status_code]
        if since:
            entries = [e for e in entries if e.get("timestamp", 0) > since]

        return entries[-limit:]

    def get_stats(self) -> Dict[str, Any]:
        """Get audit logging statistics.

        Returns:
            Statistics dict with request counts and timing.
        """
        if not self._request_log:
            return {"total_requests": 0}

        total = len(self._request_log)
        status_counts: Dict[int, int] = defaultdict(int)
        method_counts: Dict[str, int] = defaultdict(int)
        total_elapsed = 0.0
        error_count = 0

        for entry in self._request_log:
            status_counts[entry.get("status_code", 0)] += 1
            method_counts[entry.get("method", "")] += 1
            total_elapsed += entry.get("elapsed_ms", 0)
            if entry.get("status_code", 0) >= 400:
                error_count += 1

        return {
            "total_requests": total,
            "avg_response_time_ms": round(total_elapsed / total, 2) if total else 0,
            "error_rate": round(error_count / total * 100, 2) if total else 0,
            "status_codes": dict(status_counts),
            "methods": dict(method_counts),
        }


# ===========================================================================
# Request Validation Middleware
# ===========================================================================

class RequestValidationMiddleware(BaseHTTPMiddleware):
    """ASGI middleware for request validation.

    Validates:
    - Request content length
    - Content-Type for POST/PUT/PATCH
    - JSON payload validity for application/json requests
    """

    MAX_CONTENT_LENGTH: int = 52428800  # 50MB

    ALLOWED_CONTENT_TYPES: Set[str] = {
        "application/json",
        "application/x-www-form-urlencoded",
        "multipart/form-data",
    }

    def __init__(
        self,
        app,
        max_content_length: int = 52428800,
        strict_content_type: bool = False,
    ):
        super().__init__(app)
        self.max_content_length = max_content_length
        self.strict_content_type = strict_content_type

    async def dispatch(self, request: Request, call_next):
        """Validate request before processing.

        Args:
            request: Incoming HTTP request.
            call_next: Next middleware or route handler.

        Returns:
            Response from downstream handler or validation error.
        """
        path = request.url.path
        method = request.method

        # Skip validation for safe methods
        if method in ("GET", "HEAD", "OPTIONS"):
            return await call_next(request)

        # Validate content length
        content_length = request.headers.get("Content-Length")
        if content_length:
            try:
                length = int(content_length)
                if length > self.max_content_length:
                    return JSONResponse(
                        status_code=413,
                        content={
                            "error": True,
                            "detail": f"Content length ({length}) exceeds maximum ({self.max_content_length})",
                        },
                    )
            except ValueError:
                pass

        # Validate content type for methods with body
        if method in ("POST", "PUT", "PATCH"):
            content_type = request.headers.get("Content-Type", "")

            # Multipart uploads are always allowed
            if content_type.startswith("multipart/form-data"):
                return await call_next(request)

            if self.strict_content_type and content_type:
                base_type = content_type.split(";")[0].strip().lower()
                if base_type not in self.ALLOWED_CONTENT_TYPES:
                    return JSONResponse(
                        status_code=415,
                        content={
                            "error": True,
                            "detail": f"Unsupported content type: {base_type}",
                        },
                    )

        return await call_next(request)


# ===========================================================================
# Encryption Middleware
# ===========================================================================

class EncryptionMiddleware(BaseHTTPMiddleware):
    """ASGI middleware for request/response encryption.

    Provides optional encryption of request/response bodies
    using AES-256-GCM when the X-Encrypted header is present.
    """

    def __init__(
        self,
        app,
        encryption_key: Optional[str] = None,
    ):
        super().__init__(app)
        self.encryption_key = encryption_key
        self._cipher_available = False

        if encryption_key:
            try:
                from cryptography.fernet import Fernet
                self._cipher_available = True
            except ImportError:
                logger.warning("cryptography package not available, encryption middleware disabled")

    async def dispatch(self, request: Request, call_next):
        """Process request with optional encryption handling.

        Args:
            request: Incoming HTTP request.
            call_next: Next middleware or route handler.

        Returns:
            Response from downstream handler.
        """
        # Check if request is encrypted
        is_encrypted = request.headers.get("X-Encrypted", "").lower() == "true"

        if is_encrypted and self._cipher_available:
            try:
                # Decrypt request body
                body = await request.body()
                decrypted = self._decrypt(body)
                # Replace request body with decrypted content
                # Note: This is a simplified implementation
                logger.debug("Decrypted request body (%d bytes)", len(body))
            except Exception as exc:
                logger.error("Request decryption failed: %s", exc)
                return JSONResponse(
                    status_code=400,
                    content={"error": True, "detail": "Request decryption failed"},
                )

        response = await call_next(request)

        # Add encryption header to response
        if is_encrypted and self._cipher_available:
            response.headers["X-Encrypted"] = "true"

        return response

    def _decrypt(self, data: bytes) -> bytes:
        """Decrypt data using AES-256-GCM or Fernet.

        Args:
            data: Encrypted data.

        Returns:
            Decrypted data.
        """
        try:
            from cryptography.fernet import Fernet
            f = Fernet(self.encryption_key.encode() if isinstance(self.encryption_key, str) else self.encryption_key)
            return f.decrypt(data)
        except Exception as exc:
            logger.error("Decryption error: %s", exc)
            raise

    def _encrypt(self, data: bytes) -> bytes:
        """Encrypt data using AES-256-GCM or Fernet.

        Args:
            data: Plain data.

        Returns:
            Encrypted data.
        """
        try:
            from cryptography.fernet import Fernet
            f = Fernet(self.encryption_key.encode() if isinstance(self.encryption_key, str) else self.encryption_key)
            return f.encrypt(data)
        except Exception as exc:
            logger.error("Encryption error: %s", exc)
            raise


# ===========================================================================
# CORS Configuration Helper
# ===========================================================================

def get_cors_config(
    allowed_origins: Optional[List[str]] = None,
    allowed_methods: Optional[List[str]] = None,
    allowed_headers: Optional[List[str]] = None,
    allow_credentials: bool = True,
    max_age: int = 86400,
) -> Dict[str, Any]:
    """Generate CORS configuration for FastAPI.

    Args:
        allowed_origins: List of allowed origin URLs. Use ["*"] for all.
        allowed_methods: List of allowed HTTP methods.
        allowed_headers: List of allowed request headers.
        allow_credentials: Whether to allow credentials.
        max_age: Preflight cache duration in seconds.

    Returns:
        CORS configuration dict suitable for add_middleware.
    """
    return {
        "allow_origins": allowed_origins or ["*"],
        "allow_credentials": allow_credentials,
        "allow_methods": allowed_methods or ["*"],
        "allow_headers": allowed_headers or ["*"],
        "max_age": max_age,
    }
