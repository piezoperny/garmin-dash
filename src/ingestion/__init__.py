"""
src/ingestion package
Ingestion, SFTP archival, synthetic mock generator, and staging cleanup modules.
"""

from typing import Any

# Submodule attribute mapping for lazy loading
_SUBMODULE_MAP = {
    # sftp_client
    "HetznerSFTPClient": "sftp_client",
    "MockSFTPClient": "sftp_client",
    "SFTPArchivalError": "sftp_client",
    "SFTPClientProtocol": "sftp_client",
    "SFTPConfig": "sftp_client",
    "SFTPFileStat": "sftp_client",
    "get_sftp_client": "sftp_client",
    "parse_private_key": "sftp_client",

    # mock_generator
    "MockDataGenerator": "mock_generator",
    "SyntheticDatasetGenerator": "mock_generator",
    "SyntheticGenerator": "mock_generator",
    "build_fit_header": "mock_generator",
    "calculate_fit_crc": "mock_generator",
    "compile_dashboard_rollup": "mock_generator",
    "compile_rollup": "mock_generator",
    "generate_8_week_dataset": "mock_generator",

    # garmin_client
    "GarminAPIError": "garmin_client",
    "GarminAuthError": "garmin_client",
    "GarminClient": "garmin_client",
    "GarminClientProtocol": "garmin_client",
    "GarminCredentials": "garmin_client",
    "GarminError": "garmin_client",
    "GarminNetworkError": "garmin_client",
    "GarminNotFoundError": "garmin_client",
    "GarminRateLimitError": "garmin_client",
    "LiveGarminClient": "garmin_client",
    "MemoryTokenStore": "garmin_client",
    "MockGarminClient": "garmin_client",
    "OAuthSessionState": "garmin_client",
    "SFTPTokenStore": "garmin_client",
    "SecretRedactionFilter": "garmin_client",
    "TokenStoreProtocol": "garmin_client",

    # cleanup
    "purge_all_transient_data": "cleanup",
    "purge_directory": "cleanup",
    "purge_file": "cleanup",
    "purge_raw_staging": "cleanup",
    "purge_rollup": "cleanup",
    "purge_staging": "cleanup",
    "staging_cleanup_context": "cleanup",
    "verify_clean_workspace": "cleanup",
    "verify_workspace_clean": "cleanup",

    # sync
    "IngestionCoordinator": "sync",
    "SyncHistoryEntry": "sync",
    "SyncManifest": "sync",
    "execute_incremental_pull": "sync",
    "load_remote_manifest": "sync",
    "run_sync_pipeline": "sync",
    "save_remote_manifest": "sync",
}


def __getattr__(name: str) -> Any:
    if name in _SUBMODULE_MAP:
        mod_name = _SUBMODULE_MAP[name]
        mod = __import__(f"src.ingestion.{mod_name}", fromlist=[name])
        return getattr(mod, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = list(_SUBMODULE_MAP.keys())
