"""
src/encryption package
Zero-Knowledge Build-Time Encryption Pipeline for Garmin Dashboard.
"""

from src.encryption.crypto_engine import (
    HEADER_SIZE,
    IV_SIZE,
    KEY_SIZE,
    MIN_WIRE_SIZE,
    PBKDF2_ITERATIONS,
    SALT_SIZE,
    TAG_SIZE,
    AuthenticationError,
    AuthenticationTagError,
    DecryptionError,
    MalformedWireError,
    decrypt_payload,
    derive_key,
    encrypt_payload,
)

__all__ = [
    "derive_key",
    "encrypt_payload",
    "decrypt_payload",
    "build_and_encrypt_rollup",
    "main",
    "DecryptionError",
    "AuthenticationError",
    "AuthenticationTagError",
    "MalformedWireError",
    "SALT_SIZE",
    "IV_SIZE",
    "KEY_SIZE",
    "TAG_SIZE",
    "HEADER_SIZE",
    "MIN_WIRE_SIZE",
    "PBKDF2_ITERATIONS",
]


def __getattr__(name: str):
    if name in ("build_and_encrypt_rollup", "main"):
        from src.encryption.encrypt import build_and_encrypt_rollup, main
        return {"build_and_encrypt_rollup": build_and_encrypt_rollup, "main": main}[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
