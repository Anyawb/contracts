// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVaultRouter (Strict Slim Router)
 * @notice Router-only contract surface: routes deposit/withdraw and forwards push* updates.
 * @dev Architecture SSOT:
 *      - User write entrypoints live in VaultCore (authority path).
 *      - VaultRouter only routes deposit/withdraw (VaultCore -> VaultRouter -> CollateralManager).
 *      - Borrow/repay/settle MUST NOT go through VaultRouter.
 *      - push* MUST only be callable by VaultCore (single entrypoint for View updates).
 *      - All read-only queries live in dedicated View modules (PositionView/UserView/SystemView/...).
 */
interface IVaultRouter {
    /* ============ Core Routing ============ */
    /**
     * @notice Route a user deposit/withdraw operation from VaultCore to the ledger module.
     * @dev Reverts if:
     *      - Registry is not configured / required modules are missing
     *      - caller is not VaultCore (strict single entrypoint)
     *      - operationType is not supported by the router (must be deposit/withdraw)
     *      - asset is invalid or not allowed (router-level allowlist / guardrails)
     *      - amount is zero
     *
     * Security:
     * - Only VaultCore should be allowed to call (implementation enforces an onlyVaultCore gate).
     * - Router may be pausable and nonReentrant in the implementation.
     *
     * @param user User address (the principal of the operation)
     * @param operationType Action key (see ActionKeys)
     * @param asset Asset address
     * @param amount Amount (token decimals)
     * @param timestamp Timestamp supplied by VaultCore (seconds); for observability/auditing
     */
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 timestamp
    ) external;

    /* ============ Push forwarding (VaultCore -> View modules) ============ */
    /**
     * @notice Forward a full (absolute) user position update to PositionView.
     * @dev Reverts if:
     *      - Registry is not configured / PositionView is missing
     *      - caller is not VaultCore
     *      - downstream PositionView reverts
     *
     * Security:
     * - Only VaultCore should be allowed to call (implementation enforces an onlyVaultCore gate).
     *
     * @param user User address
     * @param asset Asset address
     * @param collateral Collateral amount (token decimals)
     * @param debt Debt amount (token decimals)
     * @param requestId Optional idempotency key (may be 0x0)
     * @param seq Optional monotonic sequence number (may be 0)
     * @param nextVersion Target version for optimistic concurrency (0 means "auto-increment mode")
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
     * @notice Forward a delta user position update to PositionView.
     * @dev Reverts if:
     *      - Registry is not configured / PositionView is missing
     *      - caller is not VaultCore
     *      - downstream PositionView reverts
     *
     * Security:
     * - Only VaultCore should be allowed to call (implementation enforces an onlyVaultCore gate).
     *
     * @param user User address
     * @param asset Asset address
     * @param collateralDelta Collateral delta (token decimals; signed)
     * @param debtDelta Debt delta (token decimals; signed)
     * @param requestId Optional idempotency key (may be 0x0)
     * @param seq Optional monotonic sequence number (may be 0)
     * @param nextVersion Target version for optimistic concurrency (0 means "auto-increment mode")
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

    /**
     * @notice Emit / forward an aggregated per-asset stats update (for off-chain consumers).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller is not VaultCore
     *
     * Security:
     * - Only VaultCore should be allowed to call (implementation enforces an onlyVaultCore gate).
     *
     * @param asset Asset address
     * @param totalCollateral Total collateral (token decimals)
     * @param totalDebt Total debt (token decimals)
     * @param price Price (precision defined by upstream oracle/view)
     * @param requestId Optional idempotency key (may be 0x0)
     * @param seq Optional monotonic sequence number (may be 0)
     */
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) external;
}


