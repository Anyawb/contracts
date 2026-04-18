// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPriceOracleAdapterAdmin
 * @notice Governance/configuration interface for external or heterogeneous oracle adapters.
 * @dev Reverts if:
 *      - the caller is not authorized to manage adapter routing
 *      - oracle registrations or asset-route assignments are malformed
 *      - the implementation rejects unsupported oracle types or invalid adapter addresses
 *
 * Security:
 * - Intended for governance or privileged configuration modules only.
 * - Adapter registration defines trusted external price sources and therefore changes protocol risk posture.
 */
interface IPriceOracleAdapterAdmin {
    /**
     * @notice Registers an adapter implementation under `oracleType`.
     * @dev Reverts if:
     *      - the caller is not authorized for adapter management
     *      - `oracleType` is invalid or already rejected by the implementation
     *      - `oracleAddress` is invalid or rejected by the implementation
     *
     * Security:
     * - Governance write path for onboarding adapter families.
     * - Registering an adapter establishes a new trusted routing target for future asset assignments.
     *
     * @param oracleType Oracle type label used to reference the adapter.
     * @param oracleAddress Adapter contract address associated with `oracleType`.
     */
    function registerOracle(
        string calldata oracleType,
        address oracleAddress
    ) external;

    /**
     * @notice Assigns `asset` to the adapter route identified by `oracleType`.
     * @dev Reverts if:
     *      - the caller is not authorized for adapter management
     *      - `asset` is invalid
     *      - `oracleType` is unknown or rejected by the implementation
     *
     * Security:
     * - Governance routing write path.
     * - Misconfiguration can redirect authoritative reads to the wrong adapter family.
     *
     * @param asset Asset address whose adapter route is being configured.
     * @param oracleType Oracle type label to assign to `asset`.
     */
    function configureAssetOracle(
        address asset,
        string calldata oracleType
    ) external;

    /**
     * @notice Assigns adapter routes aligned to `assets` and `oracleTypes`.
     * @dev Reverts if:
     *      - the caller is not authorized for adapter management
     *      - array lengths mismatch or any element is invalid
     *      - any oracle type is unknown or rejected by the implementation
     *
     * Security:
     * - Batch governance routing write path.
     * - Implementations commonly fail atomically if any element is invalid.
     *
     * @param assets Asset list being configured.
     * @param oracleTypes Oracle type list aligned to `assets`.
     */
    function configureAssetOracles(
        address[] calldata assets,
        string[] calldata oracleTypes
    ) external;
}
