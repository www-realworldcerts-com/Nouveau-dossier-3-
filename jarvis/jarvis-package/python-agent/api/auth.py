"""JARVIS AI Agent - Authentication Module

Complete authentication and authorization system with:
- JWT token creation and validation
- API key validation
- Password hashing with bcrypt (PBKDF2 fallback)
- Role-based access control (admin, user, viewer)
- Token refresh logic
- Account lockout after failed attempts
- ASGI middleware for request authentication
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

logger = logging.getLogger("jarvis.api.auth")

# ---------------------------------------------------------------------------
# Password Hashing
# ---------------------------------------------------------------------------

try:
    import bcrypt as _bcrypt

    BCRYPT_AVAILABLE = True
except ImportError:
    BCRYPT_AVAILABLE = False
    logger.warning("bcrypt not available, falling back to PBKDF2")


def hash_password(password: str, iterations: int = 600000) -> str:
    """Hash a password using bcrypt (preferred) or PBKDF2 (fallback).

    Args:
        password: Plain-text password to hash.
        iterations: PBKDF2 iteration count (used only as fallback).

    Returns:
        Hashed password string.
    """
    if BCRYPT_AVAILABLE:
        salt = _bcrypt.gensalt(rounds=12)
        hashed = _bcrypt.hashpw(password.encode("utf-8"), salt)
        return f"bcrypt:{hashed.decode('utf-8')}"
    else:
        salt = os.urandom(32)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        salt_b64 = base64.b64encode(salt).decode("utf-8")
        hash_b64 = base64.b64encode(dk).decode("utf-8")
        return f"pbkdf2:{iterations}:{salt_b64}:{hash_b64}"


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against its stored hash.

    Args:
        password: Plain-text password to verify.
        password_hash: Stored password hash.

    Returns:
        True if the password matches the hash.
    """
    try:
        if password_hash.startswith("bcrypt:"):
            if not BCRYPT_AVAILABLE:
                logger.error("Cannot verify bcrypt hash: bcrypt not installed")
                return False
            stored_hash = password_hash[7:].encode("utf-8")
            return _bcrypt.checkpw(password.encode("utf-8"), stored_hash)

        elif password_hash.startswith("pbkdf2:"):
            parts = password_hash.split(":")
            if len(parts) != 4:
                return False
            _, iterations_str, salt_b64, hash_b64 = parts
            iterations = int(iterations_str)
            salt = base64.b64decode(salt_b64)
            expected_hash = base64.b64decode(hash_b64)
            computed = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
            return hmac.compare_digest(computed, expected_hash)

        else:
            logger.error("Unknown password hash format")
            return False

    except Exception as exc:
        logger.error("Password verification error: %s", exc)
        return False


# ---------------------------------------------------------------------------
# JWT Token Management
# ---------------------------------------------------------------------------

def create_token(
    payload: Dict[str, Any],
    secret_key: str,
    algorithm: str = "HS256",
    expiry_seconds: int = 3600,
) -> str:
    """Create a JWT token with the given payload.

    Args:
        payload: Token payload claims.
        secret_key: Secret key for signing.
        algorithm: JWT signing algorithm.
        expiry_seconds: Token lifetime in seconds.

    Returns:
        Encoded JWT token string.
    """
    now = int(time.time())
    token_payload = {
        **payload,
        "iat": now,
        "exp": now + expiry_seconds,
        "jti": str(uuid.uuid4()),
    }

    # Encode header and payload
    header = {"alg": algorithm, "typ": "JWT"}
    header_b64 = _base64url_encode(json.dumps(header))
    payload_b64 = _base64url_encode(json.dumps(token_payload))

    # Sign
    signing_input = f"{header_b64}.{payload_b64}"
    signature = _sign(signing_input, secret_key, algorithm)
    signature_b64 = _base64url_encode(signature)

    return f"{header_b64}.{payload_b64}.{signature_b64}"


def validate_token(
    token: str,
    secret_key: Optional[str] = None,
    algorithm: Optional[str] = None,
) -> Dict[str, Any]:
    """Validate a JWT token and return its payload.

    Args:
        token: JWT token string to validate.
        secret_key: Secret key for verification.
        algorithm: Expected signing algorithm.

    Returns:
        Decoded token payload.

    Raises:
        ValueError: If the token is invalid, expired, or malformed.
    """
    # Try PyJWT first
    try:
        import jwt as pyjwt
        key = secret_key or os.environ.get("JWT_SECRET_KEY", "dev-secret-key")
        alg = algorithm or "HS256"
        payload = pyjwt.decode(token, key, algorithms=[alg])
        return payload
    except ImportError:
        pass
    except Exception:
        pass

    # Manual JWT validation fallback
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("Invalid token format")

        header_b64, payload_b64, signature_b64 = parts

        # Verify signature
        key = secret_key or os.environ.get("JWT_SECRET_KEY", "dev-secret-key")
        alg = algorithm or "HS256"
        signing_input = f"{header_b64}.{payload_b64}"
        expected_signature = _sign(signing_input, key, alg)
        actual_signature = _base64url_decode(signature_b64)

        if not hmac.compare_digest(expected_signature, actual_signature):
            raise ValueError("Invalid token signature")

        # Decode payload
        payload_json = _base64url_decode_string(payload_b64)
        payload = json.loads(payload_json)

        # Check expiration
        exp = payload.get("exp")
        if exp and int(time.time()) > exp:
            raise ValueError("Token has expired")

        return payload

    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"Token validation error: {exc}")


def create_access_token(
    user_id: str,
    username: str,
    role: str = "user",
    secret_key: str = "dev-secret-key",
    algorithm: str = "HS256",
    expiry: int = 3600,
) -> str:
    """Create an access token for a user.

    Args:
        user_id: Unique user identifier.
        username: User's display name.
        role: User role (admin, user, viewer).
        secret_key: JWT signing key.
        algorithm: Signing algorithm.
        expiry: Token lifetime in seconds.

    Returns:
        Encoded JWT access token.
    """
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "type": "access",
    }
    return create_token(payload, secret_key, algorithm, expiry)


def create_refresh_token(
    user_id: str,
    secret_key: str = "dev-secret-key",
    algorithm: str = "HS256",
    expiry: int = 604800,  # 7 days
) -> str:
    """Create a refresh token for token renewal.

    Args:
        user_id: Unique user identifier.
        secret_key: JWT signing key.
        algorithm: Signing algorithm.
        expiry: Token lifetime in seconds (default 7 days).

    Returns:
        Encoded JWT refresh token.
    """
    payload = {
        "sub": user_id,
        "type": "refresh",
    }
    return create_token(payload, secret_key, algorithm, expiry)


# ---------------------------------------------------------------------------
# API Key Validation
# ---------------------------------------------------------------------------

# In-memory API key store (production would use a database)
_api_keys: Dict[str, Dict[str, Any]] = {
    "jarvis-admin-key-001": {
        "name": "Admin API Key",
        "role": "admin",
        "created_at": time.time(),
        "active": True,
    },
    "jarvis-user-key-002": {
        "name": "User API Key",
        "role": "user",
        "created_at": time.time(),
        "active": True,
    },
}


def validate_api_key(api_key: str) -> Optional[Dict[str, Any]]:
    """Validate an API key and return its metadata.

    Args:
        api_key: API key string to validate.

    Returns:
        API key metadata if valid, None otherwise.
    """
    key_data = _api_keys.get(api_key)
    if key_data and key_data.get("active", False):
        return key_data
    return None


def register_api_key(name: str, role: str = "user") -> str:
    """Register a new API key.

    Args:
        name: Descriptive name for the key.
        role: Role assigned to the key.

    Returns:
        Generated API key string.
    """
    api_key = f"jarvis-{role}-{uuid.uuid4().hex[:12]}"
    _api_keys[api_key] = {
        "name": name,
        "role": role,
        "created_at": time.time(),
        "active": True,
    }
    return api_key


def revoke_api_key(api_key: str) -> bool:
    """Revoke an API key.

    Args:
        api_key: API key to revoke.

    Returns:
        True if the key was found and revoked.
    """
    if api_key in _api_keys:
        _api_keys[api_key]["active"] = False
        return True
    return False


# ---------------------------------------------------------------------------
# Role-Based Access Control
# ---------------------------------------------------------------------------

ROLE_HIERARCHY: Dict[str, Set[str]] = {
    "admin": {"admin", "user", "viewer"},
    "user": {"user", "viewer"},
    "viewer": {"viewer"},
}


def require_role(minimum_role: str):
    """Create a dependency that requires a minimum role.

    Args:
        minimum_role: Minimum required role (admin > user > viewer).

    Returns:
        Dependency function for FastAPI.
    """
    allowed_roles = ROLE_HIERARCHY.get(minimum_role, {minimum_role})

    def role_checker(user: Dict[str, Any]) -> Dict[str, Any]:
        user_role = user.get("role", "viewer")
        if user_role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions. Required role: {minimum_role}, got: {user_role}",
            )
        return user

    return role_checker


def has_permission(user_role: str, required_role: str) -> bool:
    """Check if a user role has the required permission level.

    Args:
        user_role: The user's current role.
        required_role: The minimum required role.

    Returns:
        True if the user has sufficient permissions.
    """
    allowed = ROLE_HIERARCHY.get(required_role, {required_role})
    return user_role in allowed


# ---------------------------------------------------------------------------
# Account Lockout
# ---------------------------------------------------------------------------

class AccountLockoutManager:
    """Manages account lockout after failed authentication attempts.

    Tracks failed login attempts per username and locks accounts
    that exceed the threshold within the observation window.
    """

    def __init__(
        self,
        max_attempts: int = 5,
        lockout_duration: int = 900,  # 15 minutes
        observation_window: int = 300,  # 5 minutes
    ):
        self.max_attempts = max_attempts
        self.lockout_duration = lockout_duration
        self.observation_window = observation_window
        # {username: [(timestamp, ip_address), ...]}
        self._failed_attempts: Dict[str, List[Tuple[float, str]]] = {}
        # {username: lockout_timestamp}
        self._locked_accounts: Dict[str, float] = {}

    def record_failed_attempt(self, username: str, ip_address: str = "unknown") -> None:
        """Record a failed login attempt.

        Args:
            username: The username that failed authentication.
            ip_address: The IP address of the client.
        """
        now = time.time()

        if username not in self._failed_attempts:
            self._failed_attempts[username] = []

        # Clean up old attempts outside the observation window
        self._failed_attempts[username] = [
            (ts, ip) for ts, ip in self._failed_attempts[username]
            if now - ts < self.observation_window
        ]

        # Record this attempt
        self._failed_attempts[username].append((now, ip_address))

        # Check if we should lock the account
        if len(self._failed_attempts[username]) >= self.max_attempts:
            self._locked_accounts[username] = now
            logger.warning("Account locked due to %d failed attempts: %s",
                         self.max_attempts, username)

    def is_locked(self, username: str) -> bool:
        """Check if an account is currently locked.

        Args:
            username: Username to check.

        Returns:
            True if the account is locked.
        """
        if username not in self._locked_accounts:
            return False

        now = time.time()
        lock_time = self._locked_accounts[username]

        # Check if lockout has expired
        if now - lock_time > self.lockout_duration:
            del self._locked_accounts[username]
            self._failed_attempts.pop(username, None)
            return False

        return True

    def get_lockout_remaining(self, username: str) -> int:
        """Get remaining lockout time in seconds.

        Args:
            username: Username to check.

        Returns:
            Remaining lockout seconds, or 0 if not locked.
        """
        if not self.is_locked(username):
            return 0

        now = time.time()
        lock_time = self._locked_accounts[username]
        remaining = self.lockout_duration - (now - lock_time)
        return max(0, int(remaining))

    def reset_attempts(self, username: str) -> None:
        """Reset failed attempts for a username (e.g., after successful login).

        Args:
            username: Username to reset.
        """
        self._failed_attempts.pop(username, None)
        self._locked_accounts.pop(username, None)

    def cleanup(self) -> int:
        """Clean up expired lockouts and old attempt records.

        Returns:
            Number of entries cleaned up.
        """
        now = time.time()
        cleaned = 0

        # Remove expired lockouts
        expired_locks = [
            username for username, lock_time in self._locked_accounts.items()
            if now - lock_time > self.lockout_duration
        ]
        for username in expired_locks:
            del self._locked_accounts[username]
            self._failed_attempts.pop(username, None)
            cleaned += 1

        # Clean old attempts
        for username in list(self._failed_attempts.keys()):
            self._failed_attempts[username] = [
                (ts, ip) for ts, ip in self._failed_attempts[username]
                if now - ts < self.observation_window
            ]
            if not self._failed_attempts[username]:
                del self._failed_attempts[username]
                cleaned += 1

        return cleaned


# Global lockout manager instance
lockout_manager = AccountLockoutManager()


# ---------------------------------------------------------------------------
# User Store (in-memory, production would use a database)
# ---------------------------------------------------------------------------

class UserStore:
    """In-memory user store for authentication.

    In production, this would be replaced with a database-backed store.
    """

    def __init__(self):
        self._users: Dict[str, Dict[str, Any]] = {}
        self._initialize_default_users()

    def _initialize_default_users(self) -> None:
        """Create default admin and user accounts."""
        self._users["admin"] = {
            "user_id": str(uuid.uuid4()),
            "username": "admin",
            "password_hash": hash_password("admin123"),
            "role": "admin",
            "active": True,
            "created_at": time.time(),
        }
        self._users["user"] = {
            "user_id": str(uuid.uuid4()),
            "username": "user",
            "password_hash": hash_password("user123"),
            "role": "user",
            "active": True,
            "created_at": time.time(),
        }
        self._users["viewer"] = {
            "user_id": str(uuid.uuid4()),
            "username": "viewer",
            "password_hash": hash_password("viewer123"),
            "role": "viewer",
            "active": True,
            "created_at": time.time(),
        }

    def get_user(self, username: str) -> Optional[Dict[str, Any]]:
        """Get a user by username."""
        return self._users.get(username)

    def authenticate(self, username: str, password: str) -> Optional[Dict[str, Any]]:
        """Authenticate a user and return user data.

        Args:
            username: Username to authenticate.
            password: Password to verify.

        Returns:
            User data dict if authenticated, None otherwise.
        """
        user = self._users.get(username)
        if not user:
            return None
        if not user.get("active", True):
            return None
        if not verify_password(password, user["password_hash"]):
            return None
        return user

    def create_user(
        self,
        username: str,
        password: str,
        role: str = "user",
    ) -> Dict[str, Any]:
        """Create a new user.

        Args:
            username: Unique username.
            password: Plain-text password (will be hashed).
            role: User role.

        Returns:
            Created user data.

        Raises:
            ValueError: If username already exists.
        """
        if username in self._users:
            raise ValueError(f"Username already exists: {username}")

        user = {
            "user_id": str(uuid.uuid4()),
            "username": username,
            "password_hash": hash_password(password),
            "role": role,
            "active": True,
            "created_at": time.time(),
        }
        self._users[username] = user
        logger.info("Created user: %s (role=%s)", username, role)
        return {k: v for k, v in user.items() if k != "password_hash"}

    def update_user(self, username: str, **updates) -> Optional[Dict[str, Any]]:
        """Update user attributes.

        Args:
            username: Username to update.
            **updates: Fields to update.

        Returns:
            Updated user data, or None if user not found.
        """
        user = self._users.get(username)
        if not user:
            return None

        for key, value in updates.items():
            if key == "password":
                user["password_hash"] = hash_password(value)
            elif key in ("role", "active"):
                user[key] = value

        return {k: v for k, v in user.items() if k != "password_hash"}

    def delete_user(self, username: str) -> bool:
        """Delete a user.

        Args:
            username: Username to delete.

        Returns:
            True if user was deleted.
        """
        if username in self._users:
            del self._users[username]
            return True
        return False

    def list_users(self) -> List[Dict[str, Any]]:
        """List all users (without password hashes)."""
        return [
            {k: v for k, v in user.items() if k != "password_hash"}
            for user in self._users.values()
        ]


# Global user store instance
user_store = UserStore()


# ---------------------------------------------------------------------------
# Authentication Middleware
# ---------------------------------------------------------------------------

class AuthMiddleware(BaseHTTPMiddleware):
    """ASGI middleware for request authentication.

    Validates JWT tokens and API keys for protected routes.
    Supports configurable exempt paths that bypass authentication.
    """

    def __init__(
        self,
        app,
        jwt_secret: str = "dev-secret-key",
        jwt_algorithm: str = "HS256",
        exempt_paths: Optional[List[str]] = None,
    ):
        super().__init__(app)
        self.jwt_secret = jwt_secret
        self.jwt_algorithm = jwt_algorithm
        self.exempt_paths = set(exempt_paths or [])
        # Paths that start with these prefixes are also exempt
        self.exempt_prefixes = ["/docs", "/redoc", "/openapi.json", "/static"]

    async def dispatch(self, request: Request, call_next):
        """Process request through authentication.

        Args:
            request: Incoming HTTP request.
            call_next: Next middleware or route handler.

        Returns:
            Response from downstream handler or 401 error.
        """
        path = request.url.path

        # Skip auth for exempt paths
        if path in self.exempt_paths:
            return await call_next(request)

        if any(path.startswith(prefix) for prefix in self.exempt_prefixes):
            return await call_next(request)

        # Skip auth for OPTIONS (CORS preflight)
        if request.method == "OPTIONS":
            return await call_next(request)

        # Try to extract auth credentials
        auth_header = request.headers.get("Authorization", "")
        api_key = request.headers.get("X-API-Key", "")

        # Check API key auth
        if api_key:
            key_data = validate_api_key(api_key)
            if key_data:
                # Store user info in request state
                request.state.user = {
                    "user_id": f"apikey:{api_key[:8]}",
                    "username": key_data.get("name", "API User"),
                    "role": key_data.get("role", "user"),
                    "auth_method": "api_key",
                }
                return await call_next(request)
            else:
                return JSONResponse(
                    status_code=401,
                    content={"error": True, "detail": "Invalid API key"},
                )

        # Check JWT Bearer auth
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
            try:
                payload = validate_token(token, self.jwt_secret, self.jwt_algorithm)
                request.state.user = {
                    "user_id": payload.get("sub", ""),
                    "username": payload.get("username", ""),
                    "role": payload.get("role", "viewer"),
                    "auth_method": "jwt",
                }
                return await call_next(request)
            except ValueError as exc:
                return JSONResponse(
                    status_code=401,
                    content={"error": True, "detail": str(exc)},
                )

        # No auth provided - for some endpoints this is OK
        # (optional auth - the route handler decides)
        request.state.user = None
        return await call_next(request)


# ---------------------------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------------------------

def _base64url_encode(data: bytes) -> str:
    """Base64url encode bytes without padding."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("utf-8")


def _base64url_decode(data: str) -> bytes:
    """Base64url decode a string with padding restoration."""
    padding = 4 - len(data) % 4
    if padding != 4:
        data += "=" * padding
    return base64.urlsafe_b64decode(data)


def _base64url_decode_string(data: str) -> str:
    """Base64url decode to string."""
    return _base64url_decode(data).decode("utf-8")


def _sign(input_string: str, secret_key: str, algorithm: str = "HS256") -> bytes:
    """Sign a string using HMAC.

    Args:
        input_string: String to sign.
        secret_key: Secret key for HMAC.
        algorithm: Signing algorithm (only HS256 supported in fallback).

    Returns:
        Signature bytes.
    """
    hash_alg = hashlib.sha256
    return hmac.new(
        secret_key.encode("utf-8"),
        input_string.encode("utf-8"),
        hash_alg,
    ).digest()
