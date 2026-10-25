"""
src/encryption/crypto_engine.py
Production-grade cryptographic engine for zero-knowledge static payload encryption.

Specifications & Wire Layout:
- Algorithm: PBKDF2-HMAC-SHA256 (600,000 iterations, 16-byte random salt, 256-bit derived key)
- Cipher: AES-256-GCM AEAD (12-byte random IV/nonce, 16-byte authentication tag)
- Strict Binary Wire Format:
  [16-byte Salt] + [12-byte IV] + [AES-256-GCM Ciphertext + 16-byte Auth Tag]
  Offset 0..15:   16-byte PBKDF2 random salt
  Offset 16..27:  12-byte AES-GCM random IV
  Offset 28..End: AES-256-GCM ciphertext with appended 16-byte authentication tag
  Header size:    28 bytes
  Min wire size:  44 bytes (16 salt + 12 IV + 0 ciphertext + 16 tag)
- Zero Partial Plaintext Leakage on authentication tag failure or wrong passphrase.
- Dual Backend Support:
  Prefers 'cryptography' package if installed; seamlessly falls back to standard
  library OpenSSL 3.0 libcrypto via ctypes + hashlib.pbkdf2_hmac.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import logging
import os
import sys
from typing import Any, Dict, Optional, Tuple, Union

logger = logging.getLogger(__name__)

# Wire Format Constants
PBKDF2_ITERATIONS = 600_000
SALT_SIZE = 16
IV_SIZE = 12
KEY_SIZE = 32  # 256 bits
TAG_SIZE = 16  # 128 bits
HEADER_SIZE = SALT_SIZE + IV_SIZE  # 28 bytes
MIN_WIRE_SIZE = SALT_SIZE + IV_SIZE + TAG_SIZE  # 44 bytes


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class DecryptionError(Exception):
    """Base exception for all decryption and cryptographic envelope failures."""
    pass


class AuthenticationError(DecryptionError):
    """Raised when AES-GCM authentication tag verification fails or passphrase is wrong."""
    pass


# Alias for backward compatibility / spec compliance
AuthenticationTagError = AuthenticationError


class MalformedWireError(ValueError, DecryptionError):
    """Raised when payload wire format is truncated (< 44 bytes) or malformed."""
    pass


# ---------------------------------------------------------------------------
# Cryptography Backend Detection
# ---------------------------------------------------------------------------

_USE_CRYPTOGRAPHY = False
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
    _USE_CRYPTOGRAPHY = True
except ImportError:
    pass


# ---------------------------------------------------------------------------
# OpenSSL libcrypto CTypes Fallback Engine
# ---------------------------------------------------------------------------

_LIBCRYPTO_HANDLE = None


def _get_libcrypto() -> Any:
    """Locates and loads OpenSSL libcrypto DLL/so using standard library ctypes."""
    global _LIBCRYPTO_HANDLE
    if _LIBCRYPTO_HANDLE is not None:
        return _LIBCRYPTO_HANDLE

    base_dir = os.path.dirname(sys.executable)
    candidates = [
        os.path.join(base_dir, "DLLs", "libcrypto-3.dll"),
        os.path.join(base_dir, "libcrypto-3.dll"),
        os.path.join(base_dir, "DLLs", "libcrypto.dll"),
        os.path.join(base_dir, "libcrypto.dll"),
        "libcrypto-3.dll",
        "libcrypto.dll",
        "libcrypto.so.3",
        "libcrypto.so",
        "libcrypto.dylib",
    ]

    for c in candidates:
        if os.path.isabs(c) and os.path.exists(c):
            try:
                _LIBCRYPTO_HANDLE = ctypes.CDLL(c)
                return _LIBCRYPTO_HANDLE
            except Exception:
                continue

    # Try system search path
    for name in ["libcrypto-3.dll", "libcrypto.dll", "libcrypto.so.3", "libcrypto.so", "libcrypto.dylib"]:
        try:
            _LIBCRYPTO_HANDLE = ctypes.CDLL(name)
            return _LIBCRYPTO_HANDLE
        except Exception:
            continue

    raise RuntimeError(
        "OpenSSL libcrypto shared library could not be loaded. "
        "Please install the 'cryptography' package or ensure OpenSSL is in the system path."
    )


def _init_libcrypto_functions(lib: Any) -> None:
    """Configures ctypes function signatures for OpenSSL EVP cipher operations."""
    lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
    lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
    lib.EVP_CIPHER_CTX_free.restype = None

    lib.EVP_aes_256_gcm.restype = ctypes.c_void_p
    lib.EVP_aes_256_gcm.argtypes = []

    lib.EVP_CipherInit_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_int,
    ]
    lib.EVP_CipherInit_ex.restype = ctypes.c_int

    lib.EVP_CIPHER_CTX_ctrl.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
    ]
    lib.EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int

    lib.EVP_CipherUpdate.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_char_p,
        ctypes.c_int,
    ]
    lib.EVP_CipherUpdate.restype = ctypes.c_int

    lib.EVP_CipherFinal_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_int),
    ]
    lib.EVP_CipherFinal_ex.restype = ctypes.c_int


def _ctypes_aes_gcm_encrypt(key: bytes, iv: bytes, plaintext: bytes) -> bytes:
    """
    Encrypts plaintext using OpenSSL AES-256-GCM via ctypes.
    Returns: ciphertext + 16-byte authentication tag.
    """
    lib = _get_libcrypto()
    _init_libcrypto_functions(lib)

    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        raise RuntimeError("Failed to allocate OpenSSL EVP_CIPHER_CTX.")

    try:
        # Initialize cipher context for encryption (enc = 1)
        if lib.EVP_CipherInit_ex(ctx, lib.EVP_aes_256_gcm(), None, None, None, 1) != 1:
            raise RuntimeError("Failed to initialize OpenSSL AES-256-GCM cipher context.")

        # Set IV length: EVP_CTRL_GCM_SET_IVLEN = 0x9
        if lib.EVP_CIPHER_CTX_ctrl(ctx, 0x9, len(iv), None) != 1:
            raise RuntimeError("Failed to set GCM IV length in cipher context.")

        # Set key and IV
        if lib.EVP_CipherInit_ex(ctx, None, None, key, iv, 1) != 1:
            raise RuntimeError("Failed to configure key and IV in cipher context.")

        # Encrypt plaintext
        out_buf = ctypes.create_string_buffer(len(plaintext) + 16)
        out_len = ctypes.c_int(0)
        if len(plaintext) > 0:
            if lib.EVP_CipherUpdate(ctx, out_buf, ctypes.byref(out_len), plaintext, len(plaintext)) != 1:
                raise RuntimeError("EVP_CipherUpdate failed during encryption.")
        c_len = out_len.value

        # Finalize encryption
        dummy = ctypes.create_string_buffer(16)
        final_len = ctypes.c_int(0)
        lib.EVP_CipherFinal_ex(ctx, dummy, ctypes.byref(final_len))

        # Retrieve 16-byte authentication tag: EVP_CTRL_GCM_GET_TAG = 0x10
        tag_buf = ctypes.create_string_buffer(TAG_SIZE)
        if lib.EVP_CIPHER_CTX_ctrl(ctx, 0x10, TAG_SIZE, tag_buf) != 1:
            raise RuntimeError("Failed to extract GCM authentication tag.")

        ciphertext = out_buf.raw[:c_len]
        tag_bytes = tag_buf.raw[:TAG_SIZE]
        return ciphertext + tag_bytes
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)


def _ctypes_aes_gcm_decrypt(key: bytes, iv: bytes, ciphertext: bytes, tag: bytes) -> bytes:
    """
    Decrypts ciphertext and validates 16-byte authentication tag using OpenSSL AES-256-GCM via ctypes.
    Raises AuthenticationError if tag mismatch or tampered data.
    Ensures zero partial plaintext is returned on error and zeroes out memory buffers immediately.
    """
    lib = _get_libcrypto()
    _init_libcrypto_functions(lib)

    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        raise RuntimeError("Failed to allocate OpenSSL EVP_CIPHER_CTX.")

    out_buf = None
    success = False
    try:
        # Initialize cipher context for decryption (enc = 0)
        if lib.EVP_CipherInit_ex(ctx, lib.EVP_aes_256_gcm(), None, None, None, 0) != 1:
            raise RuntimeError("Failed to initialize OpenSSL AES-256-GCM cipher context for decryption.")

        # Set IV length: EVP_CTRL_GCM_SET_IVLEN = 0x9
        if lib.EVP_CIPHER_CTX_ctrl(ctx, 0x9, len(iv), None) != 1:
            raise RuntimeError("Failed to set GCM IV length in cipher context.")

        # Set key and IV
        if lib.EVP_CipherInit_ex(ctx, None, None, key, iv, 0) != 1:
            raise RuntimeError("Failed to configure key and IV in cipher context.")

        # Decrypt ciphertext
        out_buf = ctypes.create_string_buffer(len(ciphertext) + 16)
        out_len = ctypes.c_int(0)
        if len(ciphertext) > 0:
            ret_up = lib.EVP_CipherUpdate(ctx, out_buf, ctypes.byref(out_len), ciphertext, len(ciphertext))
            if ret_up <= 0:
                ctypes.memset(out_buf, 0, len(out_buf))
                raise AuthenticationError("Authentication failed: invalid tag or corrupted ciphertext.")
        p_len = out_len.value

        # Set expected authentication tag: EVP_CTRL_GCM_SET_TAG = 0x11
        tag_buf = ctypes.create_string_buffer(tag, TAG_SIZE)
        if lib.EVP_CIPHER_CTX_ctrl(ctx, 0x11, TAG_SIZE, tag_buf) != 1:
            if out_buf is not None:
                ctypes.memset(out_buf, 0, len(out_buf))
            raise RuntimeError("Failed to set expected GCM authentication tag.")

        # Finalize and verify tag
        dummy = ctypes.create_string_buffer(16)
        final_len = ctypes.c_int(0)
        ret = lib.EVP_CipherFinal_ex(ctx, dummy, ctypes.byref(final_len))
        if ret <= 0:
            if out_buf is not None:
                ctypes.memset(out_buf, 0, len(out_buf))
            raise AuthenticationError("Authentication failed: invalid tag or incorrect passphrase.")

        success = True
        return out_buf.raw[:p_len]
    finally:
        if not success and out_buf is not None:
            ctypes.memset(out_buf, 0, len(out_buf))
        lib.EVP_CIPHER_CTX_free(ctx)


# ---------------------------------------------------------------------------
# Core Public API
# ---------------------------------------------------------------------------

def derive_key(passphrase: str, salt: bytes, iterations: int = PBKDF2_ITERATIONS) -> bytes:
    """
    Derives a 256-bit symmetric AES key from passphrase using PBKDF2-HMAC-SHA256.

    Parameters:
        passphrase: User master passphrase string (UTF-8 encoded).
        salt: Exactly 16 cryptographically random salt bytes.
        iterations: Number of PBKDF2 iterations (default 600,000 per NIST/OWASP recommendations).

    Returns:
        32-byte (256-bit) derived symmetric key.
    """
    if not isinstance(passphrase, str):
        raise TypeError(f"Passphrase must be a string, got {type(passphrase).__name__}")
    if not isinstance(salt, (bytes, bytearray)):
        raise TypeError(f"Salt must be bytes, got {type(salt).__name__}")
    if len(salt) != SALT_SIZE:
        raise ValueError(f"Salt must be exactly {SALT_SIZE} bytes, got {len(salt)} bytes")
    if iterations <= 0:
        raise ValueError(f"Iterations must be a positive integer, got {iterations}")

    passphrase_bytes = passphrase.encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", passphrase_bytes, bytes(salt), iterations, KEY_SIZE)


def encrypt_payload(
    arg1: Optional[Union[str, bytes, bytearray, Dict[str, Any]]] = None,
    arg2: Optional[Union[str, bytes, bytearray, Dict[str, Any]]] = None,
    iterations: int = PBKDF2_ITERATIONS,
    *,
    passphrase: Optional[str] = None,
    data: Optional[Union[str, bytes, bytearray, Dict[str, Any]]] = None,
    payload: Optional[Union[str, bytes, bytearray, Dict[str, Any]]] = None,
    payload_bytes: Optional[Union[str, bytes, bytearray, Dict[str, Any]]] = None,
) -> bytes:
    """
    Encrypts a payload with AES-256-GCM and packages it into the strict binary wire layout:
    [16-byte Salt] + [12-byte IV] + [Ciphertext + 16-byte Auth Tag]

    Supports flexible caller argument patterns:
      encrypt_payload(passphrase, data)
      encrypt_payload(payload_bytes, passphrase)
      encrypt_payload(passphrase="...", data=...)

    Data can be a dict (serialized to compact UTF-8 JSON), str, or raw bytes.
    """
    resolved_passphrase: Optional[str] = None
    resolved_data: Any = None

    # Handle explicit keyword arguments
    if passphrase is not None:
        resolved_passphrase = passphrase
        if data is not None:
            resolved_data = data
        elif payload is not None:
            resolved_data = payload
        elif payload_bytes is not None:
            resolved_data = payload_bytes
        else:
            resolved_data = arg1
    else:
        # Positional arguments: analyze arg1 and arg2
        if arg2 is None:
            raise TypeError("encrypt_payload requires both passphrase and data.")

        # Disambiguate types
        if isinstance(arg1, (dict, bytes, bytearray)) and isinstance(arg2, str):
            resolved_data = arg1
            resolved_passphrase = arg2
        elif isinstance(arg1, str) and isinstance(arg2, (dict, bytes, bytearray)):
            resolved_passphrase = arg1
            resolved_data = arg2
        elif isinstance(arg1, str) and isinstance(arg2, str):
            # Standard order: encrypt(passphrase, string_data)
            resolved_passphrase = arg1
            resolved_data = arg2
        else:
            resolved_passphrase = str(arg1)
            resolved_data = arg2

    if not isinstance(resolved_passphrase, str):
        raise TypeError(f"Passphrase must be a string, got {type(resolved_passphrase).__name__}")

    # Serialize data to bytes
    if isinstance(resolved_data, dict):
        plaintext = json.dumps(resolved_data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    elif isinstance(resolved_data, str):
        plaintext = resolved_data.encode("utf-8")
    elif isinstance(resolved_data, (bytes, bytearray)):
        plaintext = bytes(resolved_data)
    else:
        raise TypeError(f"Unsupported payload type for encryption: {type(resolved_data).__name__}")

    salt = os.urandom(SALT_SIZE)
    iv = os.urandom(IV_SIZE)
    key = derive_key(resolved_passphrase, salt, iterations)

    if _USE_CRYPTOGRAPHY:
        aesgcm = AESGCM(key)
        ciphertext_and_tag = aesgcm.encrypt(iv, plaintext, associated_data=None)
    else:
        ciphertext_and_tag = _ctypes_aes_gcm_encrypt(key, iv, plaintext)

    # Wire layout: [Salt 16B] + [IV 12B] + [Ciphertext + Tag 16B]
    return salt + iv + ciphertext_and_tag


def decrypt_payload(
    arg1: Optional[Union[str, bytes, bytearray]] = None,
    arg2: Optional[Union[str, bytes, bytearray]] = None,
    iterations: int = PBKDF2_ITERATIONS,
    *,
    passphrase: Optional[str] = None,
    encrypted_bytes: Optional[Union[bytes, bytearray]] = None,
    wire: Optional[Union[bytes, bytearray]] = None,
) -> bytes:
    """
    Validates binary wire format, derives key from embedded salt, decrypts ciphertext,
    and validates 16-byte authentication tag.

    Supports flexible caller argument patterns:
      decrypt_payload(passphrase, wire_bytes)
      decrypt_payload(encrypted_bytes, passphrase)
      decrypt_payload(wire=wire_bytes, passphrase="...")

    Raises:
      MalformedWireError: If payload length is less than 44 bytes.
      AuthenticationError: If tag verification fails or passphrase is wrong.
    """
    resolved_passphrase: Optional[str] = None
    resolved_wire: Optional[bytes] = None

    if passphrase is not None:
        resolved_passphrase = passphrase
        if encrypted_bytes is not None:
            resolved_wire = bytes(encrypted_bytes)
        elif wire is not None:
            resolved_wire = bytes(wire)
        else:
            resolved_wire = bytes(arg1) if isinstance(arg1, (bytes, bytearray)) else arg1.encode("latin1")
    else:
        if arg2 is None:
            raise TypeError("decrypt_payload requires both passphrase and encrypted_bytes.")

        if isinstance(arg1, (bytes, bytearray)) and isinstance(arg2, str):
            resolved_wire = bytes(arg1)
            resolved_passphrase = arg2
        elif isinstance(arg1, str) and isinstance(arg2, (bytes, bytearray)):
            resolved_passphrase = arg1
            resolved_wire = bytes(arg2)
        elif isinstance(arg1, str) and isinstance(arg2, str):
            # In case dummy wire was passed or arg2 is string
            resolved_passphrase = arg1
            resolved_wire = arg2.encode("utf-8")
        else:
            resolved_wire = bytes(arg1) if isinstance(arg1, (bytes, bytearray)) else bytes(arg2)
            resolved_passphrase = str(arg2) if isinstance(arg1, (bytes, bytearray)) else str(arg1)

    if not isinstance(resolved_passphrase, str):
        raise TypeError(f"Passphrase must be a string, got {type(resolved_passphrase).__name__}")
    if resolved_wire is None:
        raise TypeError("Encrypted wire data must be provided.")

    # Envelope validation: minimum wire format size is 44 bytes (16 salt + 12 IV + 16 tag)
    if len(resolved_wire) < MIN_WIRE_SIZE:
        raise MalformedWireError(
            f"Invalid wire format: payload is {len(resolved_wire)} bytes, "
            f"minimum required is {MIN_WIRE_SIZE} bytes."
        )

    # Slice strictly matching binary wire format
    salt = resolved_wire[:SALT_SIZE]
    iv = resolved_wire[SALT_SIZE:HEADER_SIZE]
    ciphertext_and_tag = resolved_wire[HEADER_SIZE:]
    ciphertext = resolved_wire[HEADER_SIZE:-TAG_SIZE]
    tag = resolved_wire[-TAG_SIZE:]

    key = derive_key(resolved_passphrase, salt, iterations)

    if _USE_CRYPTOGRAPHY:
        aesgcm = AESGCM(key)
        try:
            return aesgcm.decrypt(iv, ciphertext_and_tag, associated_data=None)
        except InvalidTag:
            raise AuthenticationError("Authentication failed: invalid tag or incorrect passphrase.") from None
    else:
        try:
            return _ctypes_aes_gcm_decrypt(key, iv, ciphertext, tag)
        except AuthenticationError:
            raise AuthenticationError("Authentication failed: invalid tag or incorrect passphrase.") from None
