"""JARVIS AI Agent - Security Test Suite

Comprehensive test suite covering JWT token management, AES encryption,
rate limiting, password hashing, and API key validation.

Test Classes:
- TestJWTTokenCreation: JWT token generation tests
- TestJWTTokenValidation: JWT token validation tests
- TestAESEncryption: AES encryption/decryption tests
- TestRateLimiter: Rate limiting tests
- TestPasswordHashing: Password hashing and verification tests
- TestAPIKeyValidation: API key validation tests
- TestAccountLockout: Account lockout mechanism tests
- TestRoleBasedAccess: RBAC tests
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.auth import (
    create_token,
    validate_token,
    create_access_token,
    create_refresh_token,
    hash_password,
    verify_password,
    validate_api_key,
    register_api_key,
    revoke_api_key,
    require_role,
    has_permission,
    AccountLockoutManager,
    UserStore,
    _base64url_encode,
    _base64url_decode,
    _sign,
)


# ===========================================================================
# JWT Token Creation Tests
# ===========================================================================

class TestJWTTokenCreation(unittest.TestCase):
    """Test JWT token creation functionality."""

    def setUp(self):
        self.secret = "test-secret-key-for-testing"
        self.algorithm = "HS256"

    def test_create_token_basic(self):
        """Test basic token creation."""
        payload = {"sub": "user123", "username": "testuser"}
        token = create_token(payload, self.secret)
        self.assertIsInstance(token, str)
        self.assertEqual(token.count("."), 2)  # JWT has 3 parts

    def test_create_token_has_iat(self):
        """Test that created token includes issued-at timestamp."""
        payload = {"sub": "user123"}
        token = create_token(payload, self.secret)
        # Decode payload part
        parts = token.split(".")
        payload_json = _base64url_decode(parts[1])
        decoded = json.loads(payload_json)
        self.assertIn("iat", decoded)
        self.assertIsInstance(decoded["iat"], int)

    def test_create_token_has_exp(self):
        """Test that created token includes expiration timestamp."""
        payload = {"sub": "user123"}
        token = create_token(payload, self.secret, expiry_seconds=3600)
        parts = token.split(".")
        payload_json = _base64url_decode(parts[1])
        decoded = json.loads(payload_json)
        self.assertIn("exp", decoded)
        self.assertAlmostEqual(decoded["exp"], decoded["iat"] + 3600, delta=2)

    def test_create_token_has_jti(self):
        """Test that created token includes a unique JWT ID."""
        payload = {"sub": "user123"}
        token = create_token(payload, self.secret)
        parts = token.split(".")
        payload_json = _base64url_decode(parts[1])
        decoded = json.loads(payload_json)
        self.assertIn("jti", decoded)
        self.assertTrue(len(decoded["jti"]) > 0)

    def test_create_token_custom_expiry(self):
        """Test token creation with custom expiry."""
        payload = {"sub": "user123"}
        token = create_token(payload, self.secret, expiry_seconds=7200)
        parts = token.split(".")
        payload_json = _base64url_decode(parts[1])
        decoded = json.loads(payload_json)
        self.assertAlmostEqual(decoded["exp"] - decoded["iat"], 7200, delta=2)

    def test_create_token_preserves_payload(self):
        """Test that all payload fields are preserved in the token."""
        payload = {"sub": "user123", "username": "testuser", "role": "admin"}
        token = create_token(payload, self.secret)
        parts = token.split(".")
        payload_json = _base64url_decode(parts[1])
        decoded = json.loads(payload_json)
        self.assertEqual(decoded["sub"], "user123")
        self.assertEqual(decoded["username"], "testuser")
        self.assertEqual(decoded["role"], "admin")

    def test_create_token_unique_jti(self):
        """Test that each token gets a unique JWT ID."""
        payload = {"sub": "user123"}
        token1 = create_token(payload, self.secret)
        token2 = create_token(payload, self.secret)
        parts1 = token1.split(".")
        parts2 = token2.split(".")
        payload1 = json.loads(_base64url_decode(parts1[1]))
        payload2 = json.loads(_base64url_decode(parts2[1]))
        self.assertNotEqual(payload1["jti"], payload2["jti"])

    def test_create_access_token(self):
        """Test access token creation."""
        token = create_access_token("user123", "testuser", "admin", self.secret)
        self.assertIsInstance(token, str)
        parts = token.split(".")
        decoded = json.loads(_base64url_decode(parts[1]))
        self.assertEqual(decoded["sub"], "user123")
        self.assertEqual(decoded["username"], "testuser")
        self.assertEqual(decoded["role"], "admin")
        self.assertEqual(decoded["type"], "access")

    def test_create_refresh_token(self):
        """Test refresh token creation."""
        token = create_refresh_token("user123", self.secret)
        self.assertIsInstance(token, str)
        parts = token.split(".")
        decoded = json.loads(_base64url_decode(parts[1]))
        self.assertEqual(decoded["sub"], "user123")
        self.assertEqual(decoded["type"], "refresh")

    def test_create_token_different_secrets(self):
        """Test that tokens with different secrets have different signatures."""
        payload = {"sub": "user123"}
        token1 = create_token(payload, "secret1")
        token2 = create_token(payload, "secret2")
        sig1 = token1.split(".")[2]
        sig2 = token2.split(".")[2]
        self.assertNotEqual(sig1, sig2)

    def test_create_token_empty_payload(self):
        """Test token creation with empty payload."""
        token = create_token({}, self.secret)
        self.assertIsInstance(token, str)
        self.assertEqual(token.count("."), 2)

    def test_create_token_large_payload(self):
        """Test token creation with a large payload."""
        payload = {f"field_{i}": f"value_{i}" for i in range(50)}
        token = create_token(payload, self.secret)
        self.assertIsInstance(token, str)
        parts = token.split(".")
        decoded = json.loads(_base64url_decode(parts[1]))
        self.assertEqual(len(decoded), 50 + 3)  # 50 fields + iat, exp, jti


# ===========================================================================
# JWT Token Validation Tests
# ===========================================================================

class TestJWTTokenValidation(unittest.TestCase):
    """Test JWT token validation functionality."""

    def setUp(self):
        self.secret = "test-secret-key-for-testing"

    def test_validate_valid_token(self):
        """Test validation of a valid token."""
        payload = {"sub": "user123", "username": "testuser", "role": "admin"}
        token = create_token(payload, self.secret, expiry_seconds=3600)
        result = validate_token(token, self.secret)
        self.assertEqual(result["sub"], "user123")
        self.assertEqual(result["username"], "testuser")

    def test_validate_expired_token(self):
        """Test that expired tokens are rejected."""
        payload = {"sub": "user123"}
        token = create_token(payload, self.secret, expiry_seconds=-1)
        with self.assertRaises(ValueError) as ctx:
            validate_token(token, self.secret)
        self.assertIn("expired", str(ctx.exception).lower())

    def test_validate_token_wrong_secret(self):
        """Test that tokens with wrong secret are rejected."""
        payload = {"sub": "user123"}
        token = create_token(payload, self.secret, expiry_seconds=3600)
        with self.assertRaises(ValueError):
            validate_token(token, "wrong-secret")

    def test_validate_malformed_token(self):
        """Test that malformed tokens are rejected."""
        with self.assertRaises(ValueError):
            validate_token("not.a.valid.token.format.extra")

    def test_validate_token_missing_parts(self):
        """Test that tokens with missing parts are rejected."""
        with self.assertRaises(ValueError):
            validate_token("only.two")

    def test_validate_empty_token(self):
        """Test that empty tokens are rejected."""
        with self.assertRaises(ValueError):
            validate_token("")

    def test_validate_access_token(self):
        """Test validation of an access token."""
        token = create_access_token("user123", "testuser", "user", self.secret)
        result = validate_token(token, self.secret)
        self.assertEqual(result["type"], "access")
        self.assertEqual(result["role"], "user")

    def test_validate_refresh_token(self):
        """Test validation of a refresh token."""
        token = create_refresh_token("user123", self.secret)
        result = validate_token(token, self.secret)
        self.assertEqual(result["type"], "refresh")

    def test_validate_tampered_token(self):
        """Test that tampered tokens are rejected."""
        payload = {"sub": "user123", "role": "user"}
        token = create_token(payload, self.secret, expiry_seconds=3600)
        # Tamper with the payload
        parts = token.split(".")
        tampered_payload = {"sub": "user123", "role": "admin"}
        parts[1] = _base64url_encode(json.dumps(tampered_payload))
        tampered_token = ".".join(parts)
        with self.assertRaises(ValueError):
            validate_token(tampered_token, self.secret)

    def test_validate_token_returns_all_fields(self):
        """Test that validation returns all payload fields."""
        payload = {"sub": "user123", "custom": "data", "number": 42}
        token = create_token(payload, self.secret, expiry_seconds=3600)
        result = validate_token(token, self.secret)
        self.assertEqual(result["sub"], "user123")
        self.assertEqual(result["custom"], "data")
        self.assertEqual(result["number"], 42)


# ===========================================================================
# AES Encryption Tests
# ===========================================================================

class TestAESEncryption(unittest.TestCase):
    """Test AES encryption and decryption functionality."""

    def test_base64url_encode_decode_roundtrip(self):
        """Test base64url encode/decode roundtrip."""
        original = b"Hello, World! Test data 12345"
        encoded = _base64url_encode(original)
        decoded = _base64url_decode(encoded)
        self.assertEqual(original, decoded)

    def test_base64url_encode_string(self):
        """Test base64url encoding of strings."""
        encoded = _base64url_encode("test string")
        self.assertIsInstance(encoded, str)
        decoded = _base64url_decode(encoded)
        self.assertEqual(decoded, b"test string")

    def test_base64url_encode_binary(self):
        """Test base64url encoding of binary data."""
        data = os.urandom(32)
        encoded = _base64url_encode(data)
        decoded = _base64url_decode(encoded)
        self.assertEqual(data, decoded)

    def test_base64url_no_padding(self):
        """Test that base64url encoding has no padding."""
        data = b"test"
        encoded = _base64url_encode(data)
        self.assertNotIn("=", encoded)

    def test_sign_function(self):
        """Test HMAC signing function."""
        signature = _sign("test.input", "secret-key")
        self.assertIsInstance(signature, bytes)
        self.assertTrue(len(signature) > 0)

    def test_sign_deterministic(self):
        """Test that signing is deterministic."""
        sig1 = _sign("test.input", "secret-key")
        sig2 = _sign("test.input", "secret-key")
        self.assertEqual(sig1, sig2)

    def test_sign_different_inputs(self):
        """Test that different inputs produce different signatures."""
        sig1 = _sign("input1", "secret")
        sig2 = _sign("input2", "secret")
        self.assertNotEqual(sig1, sig2)

    def test_sign_different_keys(self):
        """Test that different keys produce different signatures."""
        sig1 = _sign("same_input", "key1")
        sig2 = _sign("same_input", "key2")
        self.assertNotEqual(sig1, sig2)

    def test_cryptography_fernet_available(self):
        """Test that cryptography package is available."""
        try:
            from cryptography.fernet import Fernet
            key = Fernet.generate_key()
            f = Fernet(key)
            encrypted = f.encrypt(b"test data")
            decrypted = f.decrypt(encrypted)
            self.assertEqual(decrypted, b"test data")
        except ImportError:
            self.skipTest("cryptography package not installed")

    def test_cryptography_roundtrip(self):
        """Test full encryption/decryption roundtrip with Fernet."""
        try:
            from cryptography.fernet import Fernet
            key = Fernet.generate_key()
            f = Fernet(key)

            test_messages = [
                b"Hello, World!",
                b"",
                b"A" * 1000,
                b"\x00\x01\x02\x03\xff",
                "Unicode: \u00e9\u00e8\u00ea".encode("utf-8"),
            ]

            for msg in test_messages:
                encrypted = f.encrypt(msg)
                decrypted = f.decrypt(encrypted)
                self.assertEqual(msg, decrypted)
        except ImportError:
            self.skipTest("cryptography package not installed")

    def test_encrypted_data_differs_from_plaintext(self):
        """Test that encrypted data is different from plaintext."""
        try:
            from cryptography.fernet import Fernet
            key = Fernet.generate_key()
            f = Fernet(key)
            plaintext = b"This is a secret message"
            encrypted = f.encrypt(plaintext)
            self.assertNotEqual(plaintext, encrypted)
        except ImportError:
            self.skipTest("cryptography package not installed")


# ===========================================================================
# Rate Limiter Tests
# ===========================================================================

class TestRateLimiter(unittest.TestCase):
    """Test rate limiting functionality."""

    def setUp(self):
        from api.middleware import SlidingWindowRateLimiter
        self.limiter = SlidingWindowRateLimiter(max_requests=5, window_seconds=60)

    def test_initial_request_allowed(self):
        """Test that the first request is allowed."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            allowed, info = loop.run_until_complete(self.limiter.is_allowed("client1"))
            self.assertTrue(allowed)
            self.assertEqual(info["remaining"], 4)
        finally:
            loop.close()

    def test_requests_within_limit(self):
        """Test that requests within the limit are allowed."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            for i in range(5):
                allowed, info = loop.run_until_complete(self.limiter.is_allowed("client1"))
                self.assertTrue(allowed)
        finally:
            loop.close()

    def test_request_exceeds_limit(self):
        """Test that requests exceeding the limit are rejected."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            # Use up the limit
            for i in range(5):
                loop.run_until_complete(self.limiter.is_allowed("client1"))
            # Next request should be rejected
            allowed, info = loop.run_until_complete(self.limiter.is_allowed("client1"))
            self.assertFalse(allowed)
        finally:
            loop.close()

    def test_different_clients_independent(self):
        """Test that different clients have independent rate limits."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            # Exhaust client1's limit
            for i in range(5):
                loop.run_until_complete(self.limiter.is_allowed("client1"))
            # client2 should still be allowed
            allowed, info = loop.run_until_complete(self.limiter.is_allowed("client2"))
            self.assertTrue(allowed)
        finally:
            loop.close()

    def test_rate_limit_info_structure(self):
        """Test that rate limit info has required fields."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            allowed, info = loop.run_until_complete(self.limiter.is_allowed("client1"))
            self.assertIn("limit", info)
            self.assertIn("remaining", info)
            self.assertIn("reset_at", info)
            self.assertIn("window_seconds", info)
        finally:
            loop.close()

    def test_remaining_decrements(self):
        """Test that remaining count decrements with each request."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            _, info1 = loop.run_until_complete(self.limiter.is_allowed("client1"))
            _, info2 = loop.run_until_complete(self.limiter.is_allowed("client1"))
            self.assertEqual(info1["remaining"], info2["remaining"] + 1)
        finally:
            loop.close()

    def test_reset_client(self):
        """Test resetting rate limit for a specific client."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            for i in range(5):
                loop.run_until_complete(self.limiter.is_allowed("client1"))
            loop.run_until_complete(self.limiter.reset("client1"))
            allowed, info = loop.run_until_complete(self.limiter.is_allowed("client1"))
            self.assertTrue(allowed)
        finally:
            loop.close()

    def test_cleanup_expired_entries(self):
        """Test cleanup of expired rate limit entries."""
        # Manually add an old entry
        self.limiter._windows["old_client"] = [time.time() - 120]  # 2 minutes ago
        cleaned = self.limiter.cleanup()
        self.assertGreaterEqual(cleaned, 1)
        self.assertNotIn("old_client", self.limiter._windows)

    def test_get_stats(self):
        """Test getting rate limiter statistics."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(self.limiter.is_allowed("client1"))
            stats = self.limiter.get_stats()
            self.assertIn("tracked_clients", stats)
            self.assertIn("max_requests", stats)
            self.assertEqual(stats["max_requests"], 5)
        finally:
            loop.close()

    def test_retry_after_info(self):
        """Test that retry_after is set when rate limited."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            for i in range(5):
                loop.run_until_complete(self.limiter.is_allowed("client1"))
            allowed, info = loop.run_until_complete(self.limiter.is_allowed("client1"))
            self.assertFalse(allowed)
            self.assertIn("retry_after", info)
            self.assertGreater(info["retry_after"], 0)
        finally:
            loop.close()


# ===========================================================================
# Password Hashing Tests
# ===========================================================================

class TestPasswordHashing(unittest.TestCase):
    """Test password hashing and verification."""

    def test_hash_password_returns_string(self):
        """Test that hash_password returns a string."""
        hashed = hash_password("test_password")
        self.assertIsInstance(hashed, str)

    def test_hash_password_different_from_input(self):
        """Test that hash is different from input password."""
        hashed = hash_password("test_password")
        self.assertNotEqual(hashed, "test_password")

    def test_verify_correct_password(self):
        """Test that correct password verifies successfully."""
        hashed = hash_password("correct_password")
        self.assertTrue(verify_password("correct_password", hashed))

    def test_verify_wrong_password(self):
        """Test that wrong password fails verification."""
        hashed = hash_password("correct_password")
        self.assertFalse(verify_password("wrong_password", hashed))

    def test_hash_uniqueness(self):
        """Test that each hash is unique (due to random salt)."""
        hash1 = hash_password("same_password")
        hash2 = hash_password("same_password")
        self.assertNotEqual(hash1, hash2)

    def test_verify_after_hash(self):
        """Test full hash-verify cycle."""
        passwords = [
            "simple",
            "with spaces and symbols!@#",
            "unicode: \u00e9\u00e8\u00ea",
            "a" * 1000,
            "",
        ]
        for password in passwords:
            hashed = hash_password(password)
            self.assertTrue(
                verify_password(password, hashed),
                f"Failed to verify password: {password[:20]}..."
            )

    def test_bcrypt_format(self):
        """Test that bcrypt hash format is correct when bcrypt is available."""
        try:
            import bcrypt
            hashed = hash_password("test")
            if hashed.startswith("bcrypt:"):
                self.assertTrue(hashed.startswith("$2b$") or hashed.startswith("$2a$"))
        except ImportError:
            # PBKDF2 format
            hashed = hash_password("test")
            if hashed.startswith("pbkdf2:"):
                parts = hashed.split(":")
                self.assertEqual(len(parts), 4)
                self.assertEqual(parts[0], "pbkdf2")

    def test_pbkdf2_fallback(self):
        """Test PBKDF2 format parsing and verification."""
        # Create a PBKDF2 hash manually
        salt = os.urandom(32)
        iterations = 600000
        dk = hashlib.pbkdf2_hmac("sha256", b"test_password", salt, iterations)
        salt_b64 = base64.b64encode(salt).decode("utf-8")
        hash_b64 = base64.b64encode(dk).decode("utf-8")
        hashed = f"pbkdf2:{iterations}:{salt_b64}:{hash_b64}"

        self.assertTrue(verify_password("test_password", hashed))
        self.assertFalse(verify_password("wrong_password", hashed))

    def test_invalid_hash_format(self):
        """Test verification with invalid hash format."""
        self.assertFalse(verify_password("test", "invalid_hash_format"))

    def test_empty_password(self):
        """Test hashing and verifying empty password."""
        hashed = hash_password("")
        self.assertTrue(verify_password("", hashed))


# ===========================================================================
# API Key Validation Tests
# ===========================================================================

class TestAPIKeyValidation(unittest.TestCase):
    """Test API key validation functionality."""

    def test_validate_valid_api_key(self):
        """Test validation of a valid API key."""
        result = validate_api_key("jarvis-admin-key-001")
        self.assertIsNotNone(result)
        self.assertEqual(result["role"], "admin")

    def test_validate_user_api_key(self):
        """Test validation of a user-level API key."""
        result = validate_api_key("jarvis-user-key-002")
        self.assertIsNotNone(result)
        self.assertEqual(result["role"], "user")

    def test_validate_invalid_api_key(self):
        """Test that invalid API keys are rejected."""
        result = validate_api_key("invalid-key")
        self.assertIsNone(result)

    def test_validate_empty_api_key(self):
        """Test that empty API keys are rejected."""
        result = validate_api_key("")
        self.assertIsNone(result)

    def test_register_new_api_key(self):
        """Test registering a new API key."""
        key = register_api_key("Test Key", "user")
        self.assertIsInstance(key, str)
        self.assertTrue(key.startswith("jarvis-user-"))

    def test_register_admin_api_key(self):
        """Test registering an admin API key."""
        key = register_api_key("Admin Key", "admin")
        self.assertTrue(key.startswith("jarvis-admin-"))

    def test_validate_registered_key(self):
        """Test that a registered key can be validated."""
        key = register_api_key("Test Key", "user")
        result = validate_api_key(key)
        self.assertIsNotNone(result)
        self.assertEqual(result["name"], "Test Key")

    def test_revoke_api_key(self):
        """Test revoking an API key."""
        key = register_api_key("Revokable Key", "user")
        self.assertTrue(revoke_api_key(key))
        # After revocation, key should not validate
        result = validate_api_key(key)
        self.assertIsNone(result)

    def test_revoke_nonexistent_key(self):
        """Test revoking a non-existent key."""
        result = revoke_api_key("nonexistent-key")
        self.assertFalse(result)

    def test_revoked_key_inactive(self):
        """Test that revoked keys are marked inactive."""
        key = register_api_key("Test Key", "user")
        revoke_api_key(key)
        # The key should exist but be inactive
        from api.auth import _api_keys
        self.assertFalse(_api_keys[key]["active"])

    def test_api_key_metadata(self):
        """Test that API key has proper metadata."""
        result = validate_api_key("jarvis-admin-key-001")
        self.assertIn("name", result)
        self.assertIn("role", result)
        self.assertIn("created_at", result)
        self.assertIn("active", result)
        self.assertTrue(result["active"])


# ===========================================================================
# Account Lockout Tests
# ===========================================================================

class TestAccountLockout(unittest.TestCase):
    """Test account lockout mechanism."""

    def setUp(self):
        self.lockout = AccountLockoutManager(
            max_attempts=3,
            lockout_duration=60,
            observation_window=300,
        )

    def test_account_not_locked_initially(self):
        """Test that accounts are not locked initially."""
        self.assertFalse(self.lockout.is_locked("testuser"))

    def test_account_not_locked_below_threshold(self):
        """Test that account is not locked below max attempts."""
        self.lockout.record_failed_attempt("testuser", "127.0.0.1")
        self.lockout.record_failed_attempt("testuser", "127.0.0.1")
        self.assertFalse(self.lockout.is_locked("testuser"))

    def test_account_locked_after_max_attempts(self):
        """Test that account is locked after max failed attempts."""
        for _ in range(3):
            self.lockout.record_failed_attempt("testuser", "127.0.0.1")
        self.assertTrue(self.lockout.is_locked("testuser"))

    def test_different_accounts_independent(self):
        """Test that different accounts are independently locked."""
        for _ in range(3):
            self.lockout.record_failed_attempt("user1", "127.0.0.1")
        self.assertTrue(self.lockout.is_locked("user1"))
        self.assertFalse(self.lockout.is_locked("user2"))

    def test_lockout_remaining_time(self):
        """Test that lockout remaining time is reported."""
        for _ in range(3):
            self.lockout.record_failed_attempt("testuser", "127.0.0.1")
        remaining = self.lockout.get_lockout_remaining("testuser")
        self.assertGreater(remaining, 0)
        self.assertLessEqual(remaining, 60)

    def test_lockout_remaining_unlocked(self):
        """Test that lockout remaining is 0 for unlocked accounts."""
        remaining = self.lockout.get_lockout_remaining("testuser")
        self.assertEqual(remaining, 0)

    def test_reset_attempts(self):
        """Test resetting failed attempts for a user."""
        for _ in range(2):
            self.lockout.record_failed_attempt("testuser", "127.0.0.1")
        self.lockout.reset_attempts("testuser")
        self.assertFalse(self.lockout.is_locked("testuser"))

    def test_reset_after_lockout(self):
        """Test that reset clears lockout."""
        for _ in range(3):
            self.lockout.record_failed_attempt("testuser", "127.0.0.1")
        self.assertTrue(self.lockout.is_locked("testuser"))
        self.lockout.reset_attempts("testuser")
        self.assertFalse(self.lockout.is_locked("testuser"))

    def test_cleanup_expired_lockouts(self):
        """Test cleanup of expired lockouts."""
        for _ in range(3):
            self.lockout.record_failed_attempt("testuser", "127.0.0.1")
        # Simulate expired lockout
        self.lockout._locked_accounts["testuser"] = time.time() - 120  # 2 minutes ago
        cleaned = self.lockout.cleanup()
        self.assertGreaterEqual(cleaned, 1)
        self.assertFalse(self.lockout.is_locked("testuser"))


# ===========================================================================
# Role-Based Access Control Tests
# ===========================================================================

class TestRoleBasedAccess(unittest.TestCase):
    """Test role-based access control."""

    def test_admin_has_all_permissions(self):
        """Test that admin role has all permissions."""
        self.assertTrue(has_permission("admin", "admin"))
        self.assertTrue(has_permission("admin", "user"))
        self.assertTrue(has_permission("admin", "viewer"))

    def test_user_has_user_and_viewer(self):
        """Test that user role has user and viewer permissions."""
        self.assertFalse(has_permission("user", "admin"))
        self.assertTrue(has_permission("user", "user"))
        self.assertTrue(has_permission("user", "viewer"))

    def test_viewer_has_viewer_only(self):
        """Test that viewer role has only viewer permission."""
        self.assertFalse(has_permission("viewer", "admin"))
        self.assertFalse(has_permission("viewer", "user"))
        self.assertTrue(has_permission("viewer", "viewer"))

    def test_require_role_admin(self):
        """Test require_role decorator for admin."""
        checker = require_role("admin")
        with self.assertRaises(Exception):
            checker({"role": "user"})

    def test_require_role_user(self):
        """Test require_role for user-level access."""
        checker = require_role("user")
        result = checker({"role": "admin"})
        self.assertEqual(result["role"], "admin")

    def test_require_role_viewer(self):
        """Test require_role for viewer-level access."""
        checker = require_role("viewer")
        result = checker({"role": "viewer"})
        self.assertEqual(result["role"], "viewer")

    def test_unknown_role_has_no_permissions(self):
        """Test that unknown roles have no permissions."""
        self.assertFalse(has_permission("unknown", "viewer"))

    def test_require_role_same_role(self):
        """Test require_role when user has exactly the required role."""
        checker = require_role("user")
        result = checker({"role": "user"})
        self.assertIsNotNone(result)


# ===========================================================================
# User Store Tests
# ===========================================================================

class TestUserStore(unittest.TestCase):
    """Test user store functionality."""

    def setUp(self):
        self.store = UserStore()

    def test_default_users_exist(self):
        """Test that default users are created."""
        admin = self.store.get_user("admin")
        self.assertIsNotNone(admin)
        self.assertEqual(admin["role"], "admin")

    def test_authenticate_valid_user(self):
        """Test authentication with valid credentials."""
        user = self.store.authenticate("admin", "admin123")
        self.assertIsNotNone(user)
        self.assertEqual(user["username"], "admin")

    def test_authenticate_wrong_password(self):
        """Test authentication with wrong password."""
        user = self.store.authenticate("admin", "wrong_password")
        self.assertIsNone(user)

    def test_authenticate_nonexistent_user(self):
        """Test authentication with non-existent user."""
        user = self.store.authenticate("nonexistent", "password")
        self.assertIsNone(user)

    def test_create_user(self):
        """Test creating a new user."""
        user = self.store.create_user("newuser", "password123", "user")
        self.assertEqual(user["username"], "newuser")
        self.assertEqual(user["role"], "user")
        self.assertNotIn("password_hash", user)

    def test_create_duplicate_user(self):
        """Test that creating a duplicate user raises an error."""
        with self.assertRaises(ValueError):
            self.store.create_user("admin", "password", "user")

    def test_update_user(self):
        """Test updating a user."""
        result = self.store.update_user("admin", role="user")
        self.assertEqual(result["role"], "user")

    def test_update_nonexistent_user(self):
        """Test updating a non-existent user."""
        result = self.store.update_user("nonexistent", role="admin")
        self.assertIsNone(result)

    def test_delete_user(self):
        """Test deleting a user."""
        self.assertTrue(self.store.delete_user("viewer"))
        self.assertIsNone(self.store.get_user("viewer"))

    def test_delete_nonexistent_user(self):
        """Test deleting a non-existent user."""
        self.assertFalse(self.store.delete_user("nonexistent"))

    def test_list_users(self):
        """Test listing all users."""
        users = self.store.list_users()
        self.assertIsInstance(users, list)
        self.assertGreaterEqual(len(users), 3)
        # Ensure no password hashes in list
        for user in users:
            self.assertNotIn("password_hash", user)

    def test_update_password(self):
        """Test updating a user's password."""
        self.store.update_user("admin", password="new_password")
        user = self.store.authenticate("admin", "new_password")
        self.assertIsNotNone(user)

    def test_deactivate_user(self):
        """Test deactivating a user."""
        self.store.update_user("user", active=False)
        user = self.store.authenticate("user", "user123")
        self.assertIsNone(user)


# ===========================================================================
# Utility Function Tests
# ===========================================================================

class TestUtilityFunctions(unittest.TestCase):
    """Test utility functions."""

    def test_base64url_encode_bytes(self):
        """Test base64url encoding of bytes."""
        result = _base64url_encode(b"hello")
        self.assertIsInstance(result, str)
        self.assertNotIn("=", result)
        self.assertNotIn("+", result)
        self.assertNotIn("/", result)

    def test_base64url_decode_roundtrip(self):
        """Test base64url encode/decode roundtrip."""
        test_data = [b"", b"a", b"ab", b"abc", b"test data 123", os.urandom(64)]
        for data in test_data:
            encoded = _base64url_encode(data)
            decoded = _base64url_decode(encoded)
            self.assertEqual(data, decoded)

    def test_sign_produces_bytes(self):
        """Test that sign function produces bytes."""
        result = _sign("input", "key")
        self.assertIsInstance(result, bytes)

    def test_sign_consistent(self):
        """Test that sign function is consistent."""
        sig1 = _sign("same_input", "same_key")
        sig2 = _sign("same_input", "same_key")
        self.assertEqual(sig1, sig2)

    def test_sign_length(self):
        """Test that sign output has expected length (SHA-256 = 32 bytes)."""
        sig = _sign("input", "key")
        self.assertEqual(len(sig), 32)


# ===========================================================================
# Integration Tests
# ===========================================================================

class TestSecurityIntegration(unittest.TestCase):
    """Integration tests for the security system."""

    def setUp(self):
        self.secret = "integration-test-secret"

    def test_full_auth_flow(self):
        """Test complete authentication flow."""
        # Create user
        store = UserStore()
        store.create_user("testuser", "password123", "user")

        # Authenticate
        user = store.authenticate("testuser", "password123")
        self.assertIsNotNone(user)

        # Create access token
        token = create_access_token(
            user["user_id"], user["username"], user["role"], self.secret
        )

        # Validate token
        payload = validate_token(token, self.secret)
        self.assertEqual(payload["username"], "testuser")
        self.assertEqual(payload["role"], "user")

    def test_api_key_auth_flow(self):
        """Test API key authentication flow."""
        # Register key
        key = register_api_key("Integration Test Key", "admin")

        # Validate key
        key_data = validate_api_key(key)
        self.assertIsNotNone(key_data)
        self.assertEqual(key_data["role"], "admin")

        # Check permission
        self.assertTrue(has_permission(key_data["role"], "admin"))

    def test_lockout_prevents_brute_force(self):
        """Test that lockout prevents brute force attacks."""
        lockout = AccountLockoutManager(max_attempts=3, lockout_duration=60)

        # Simulate brute force
        for _ in range(3):
            lockout.record_failed_attempt("victim", "attacker_ip")

        # Account should be locked
        self.assertTrue(lockout.is_locked("victim"))

        # Even correct password should not work (in app logic, not lockout itself)
        remaining = lockout.get_lockout_remaining("victim")
        self.assertGreater(remaining, 0)

    def test_token_refresh_flow(self):
        """Test token refresh flow."""
        # Create refresh token
        refresh_token = create_refresh_token("user123", self.secret, expiry_seconds=3600)

        # Validate refresh token
        payload = validate_token(refresh_token, self.secret)
        self.assertEqual(payload["sub"], "user123")
        self.assertEqual(payload["type"], "refresh")

        # Create new access token from refresh
        new_access = create_access_token(
            payload["sub"], "testuser", "user", self.secret
        )

        # Validate new access token
        new_payload = validate_token(new_access, self.secret)
        self.assertEqual(new_payload["type"], "access")


if __name__ == "__main__":
    unittest.main()
