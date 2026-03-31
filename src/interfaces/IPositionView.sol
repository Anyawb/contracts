// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPositionView
 * @notice Minimal PositionView surface for cache writes and reads.
 * @dev Notes:
 * - PositionView is the SSOT for cached user positions (read path), with validity flags and TTL.
 * - Write functions are intended to be called by authorized writers (e.g., VaultRouter),
 *   resolved via `Registry.KEY_VAULT_CORE -> VaultCore.viewContractAddrVar()`.
 * - This interface includes legacy overloads for migration; strict deployments should prefer
 *   contexted and versioned variants.
 */
interface IPositionView {
    /*━━━━━━━━━━━━━━━ Write Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Push a full (absolute) user position update with idempotency context.
     * @dev Reverts if:
     *      - Registry reference is invalid (implementation-defined)
     *      - caller is not an authorized writer (e.g., ACTION_VIEW_PUSH via ViewAccessLib)
     *      - context violates ordering/idempotency rules (implementation-defined)
     *
     * Security:
     * - Writer-gated (e.g., onlyBusinessContract + ACTION_VIEW_PUSH)
     *
     * @param user User address.
     * @param asset Asset address.
     * @param collateral Collateral amount (token decimals).
     * @param debt Debt amount (token decimals).
     * @param requestId Optional idempotency key (may be 0x0).
     * @param seq Optional monotonic sequence number (may be 0).
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq
    ) external;

    /**
     * @notice Push a full (absolute) user position update with a target version.
     * @dev Reverts if:
     *      - Registry reference is invalid (implementation-defined)
     *      - caller is not an authorized writer (e.g., ACTION_VIEW_PUSH via ViewAccessLib)
     *      - nextVersion violates optimistic concurrency rules (implementation-defined)
     *
     * Security:
     * - Writer-gated (e.g., onlyBusinessContract + ACTION_VIEW_PUSH)
     *
     * @param user User address.
     * @param asset Asset address.
     * @param collateral Collateral amount (token decimals).
     * @param debt Debt amount (token decimals).
     * @param nextVersion Target version (0 means "auto-increment mode").
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        uint64 nextVersion
    ) external;

    /**
     * @notice Push a full (absolute) user position update with context + target version.
     * @dev Reverts if:
     *      - Registry reference is invalid (implementation-defined)
     *      - caller is not an authorized writer (e.g., ACTION_VIEW_PUSH via ViewAccessLib)
     *      - context/version violates idempotency or optimistic concurrency rules
     *
     * Security:
     * - Writer-gated (e.g., onlyBusinessContract + ACTION_VIEW_PUSH)
     *
     * @param user User address.
     * @param asset Asset address.
     * @param collateral Collateral amount (token decimals).
     * @param debt Debt amount (token decimals).
     * @param requestId Optional idempotency key (may be 0x0).
     * @param seq Optional monotonic sequence number (may be 0).
     * @param nextVersion Target version (0 means "auto-increment mode").
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;

    /**
     * @notice Push a delta user position update with idempotency context.
     * @dev Reverts if:
     *      - Registry reference is invalid (implementation-defined)
     *      - caller is not an authorized writer (e.g., ACTION_VIEW_PUSH via ViewAccessLib)
     *      - context violates ordering/idempotency rules (implementation-defined)
     *
     * Security:
     * - Writer-gated (e.g., onlyBusinessContract + ACTION_VIEW_PUSH)
     *
     * @param user User address.
     * @param asset Asset address.
     * @param collateralDelta Collateral delta (token decimals; signed).
     * @param debtDelta Debt delta (token decimals; signed).
     * @param requestId Optional idempotency key (may be 0x0).
     * @param seq Optional monotonic sequence number (may be 0).
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq
    ) external;

    /**
     * @notice Push a delta user position update with a target version.
     * @dev Reverts if:
     *      - Registry reference is invalid (implementation-defined)
     *      - caller is not an authorized writer (e.g., ACTION_VIEW_PUSH via ViewAccessLib)
     *      - nextVersion violates optimistic concurrency rules (implementation-defined)
     *
     * Security:
     * - Writer-gated (e.g., onlyBusinessContract + ACTION_VIEW_PUSH)
     *
     * @param user User address.
     * @param asset Asset address.
     * @param collateralDelta Collateral delta (token decimals; signed).
     * @param debtDelta Debt delta (token decimals; signed).
     * @param nextVersion Target version (0 means "auto-increment mode").
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint64 nextVersion
    ) external;

    /**
     * @notice Push a delta user position update with context + target version.
     * @dev Reverts if:
     *      - Registry reference is invalid (implementation-defined)
     *      - caller is not an authorized writer (e.g., ACTION_VIEW_PUSH via ViewAccessLib)
     *      - context/version violates idempotency or optimistic concurrency rules
     *
     * Security:
     * - Writer-gated (e.g., onlyBusinessContract + ACTION_VIEW_PUSH)
     *
     * @param user User address.
     * @param asset Asset address.
     * @param collateralDelta Collateral delta (token decimals; signed).
     * @param debtDelta Debt delta (token decimals; signed).
     * @param requestId Optional idempotency key (may be 0x0).
     * @param seq Optional monotonic sequence number (may be 0).
     * @param nextVersion Target version (0 means "auto-increment mode").
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external;

    /*━━━━━━━━━━━━━━━ Read Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get the current cached version for a (user, asset) position.
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     *
     * Security:
     * - View-only
     * - Read access may be gated (e.g., ACTION_VIEW_USER_DATA or ACTION_ADMIN via ViewAccessLib)
     *
     * @param user User address.
     * @param asset Asset address.
     * @return version Current version (0 means never written).
     */
    function getPositionVersion(
        address user,
        address asset
    ) external view returns (uint64);

    /**
     * @notice Get a user position with cache validity, blockNumber, and version.
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     *
     * Security:
     * - View-only
     * - Read access may be gated (e.g., ACTION_VIEW_USER_DATA or ACTION_ADMIN via ViewAccessLib)
     *
     * @param user User address.
     * @param asset Asset address.
     * @return collateral Position collateral (may fall back to ledger when cache is invalid).
     * @return debt Position debt (may fall back to ledger when cache is invalid).
     * @return isValid True if cached value is considered valid; false if fallback path was used.
     * @return blockNumber Last cache update block number (block-based time axis).
     * @return version Position version (0 if never written).
     */
    function getUserPositionWithMeta(
        address user,
        address asset
    )
        external
        view
        returns (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        );

    /**
     * @notice Batch query user positions with cache metadata.
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     *      - users.length != assets.length (implementation-defined)
     *      - users.length exceeds max batch size (implementation-defined)
     *
     * Security:
     * - View-only
     * - Read access may be gated (e.g., ACTION_VIEW_USER_DATA or ACTION_ADMIN via ViewAccessLib)
     *
     * @param users User addresses.
     * @param assets Asset addresses.
     * @return collaterals Position collaterals.
     * @return debts Position debts.
     * @return validFlags Cache validity flags.
     * @return blockNumbers Cache update block numbers.
     * @return versions Position versions.
     */
    function batchGetUserPositionsWithMeta(
        address[] calldata users,
        address[] calldata assets
    )
        external
        view
        returns (
            uint256[] memory collaterals,
            uint256[] memory debts,
            bool[] memory validFlags,
            uint256[] memory blockNumbers,
            uint64[] memory versions
        );
}
