"""
src/storage/__init__.py
DuckDB + ZSTD Parquet vault and yearly raw .fit/.gpx zip archival layer.
"""

from src.storage.parquet_vault import (
    PARQUET_VAULT_DIR,
    REMOTE_VAULT_ACTIVITIES_PATH,
    REMOTE_VAULT_MANIFEST_PATH,
    REMOTE_VAULT_WELLNESS_PATH,
    ParquetVault,
    RawZipArchive,
    VaultManifest,
)

__all__ = [
    "PARQUET_VAULT_DIR",
    "REMOTE_VAULT_ACTIVITIES_PATH",
    "REMOTE_VAULT_MANIFEST_PATH",
    "REMOTE_VAULT_WELLNESS_PATH",
    "ParquetVault",
    "RawZipArchive",
    "VaultManifest",
]
