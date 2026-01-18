// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IDataPush
/// @notice Unified, gas-efficient data push interface for off-chain monitoring.
/// @dev Any module that needs to stream structured data to off-chain services SHOULD
///      emit the `DataPushed` event instead of bespoke events.  
///      `dataTypeHash` MUST be the keccak256 hash of a short, UPPER_SNAKE_CASE identifier
///      (e.g. "USER_HEALTH", "GLOBAL_STATS").  The `payload` **SHOULD** be ABI-encoded
///      as a struct defined in its respective module contract to keep context.
interface IDataPush {
    /**
     * @notice Unified data bus event for off-chain consumers.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - `dataTypeHash` MUST be a stable constant (prefer DataPushTypes).
     * - `payload` MUST be ABI-encoded; decoding schema is determined by `dataTypeHash`.
     *
     * @param dataTypeHash keccak256("SOME_TYPE") constant for filtering
     * @param payload ABI-encoded bytes payload
     */
    event DataPushed(bytes32 indexed dataTypeHash, bytes payload);

    /**
     * @notice Push structured data to off-chain listeners.
     * @dev Reverts if:
     *      - implementation-defined
     *
     * Security:
     * - Most modules in this repo emit `DataPushed` directly (typically via DataPushLibrary) and do not
     *   implement a stateful pushData endpoint. This function exists as an ABI-level constraint for
     *   potential adapters/routers.
     *
     * @param dataTypeHash keccak256("SOME_TYPE") constant (prefer DataPushTypes)
     * @param payload ABI-encoded bytes payload
     */
    function pushData(bytes32 dataTypeHash, bytes calldata payload) external;
}
