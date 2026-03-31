// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVaultCoreDataPush
 * @notice Data-push surface on VaultCore used by business/ledger modules to forward cache updates to the View layer.
 * @dev Reverts if:
 *      - the VaultCore implementation rejects the caller under its business-module authorization rules
 *      - the VaultCore implementation is misconfigured for downstream view routing
 *
 * Security:
 * - Push operations are expected to be best-effort from the caller's perspective only if the implementation says so.
 * - Callers should treat this interface as a privileged bridge into view or cache propagation logic.
 *
 * Architecture:
 * - Strong-constraint split:
 *      - User entry ABI stays in IVaultCore.
 *      - View address resolver stays in IVaultCoreMinimal.
 *      - push* lives here to avoid "minimal" interface drift and to make module dependencies explicit.
 */
interface IVaultCoreDataPush {
    /**
     * @notice Push a full (absolute) user position update to VaultCore, which forwards to VaultRouter.
     * @dev Reverts if:
     *      - caller is not an authorized business module (implementation-defined)
     *      - VaultCore is misconfigured (e.g., view address missing)
     *
     * Security:
     * - Intended to be called by registered business/ledger modules only (role/allowlist enforced by VaultCore).
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
     * @notice Push a delta user position update to VaultCore, which forwards to VaultRouter.
     * @dev Reverts if:
     *      - caller is not an authorized business module (implementation-defined)
     *      - VaultCore is misconfigured (e.g., view address missing)
     *
     * Security:
     * - Intended to be called by registered business/ledger modules only (role/allowlist enforced by VaultCore).
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
     * @notice Push an aggregated per-asset stats update to VaultCore, which forwards to VaultRouter.
     * @dev Reverts if:
     *      - caller is not an authorized business module (implementation-defined)
     *      - VaultCore is misconfigured (e.g., view address missing)
     *
     * Security:
     * - Intended to be called by registered business/ledger modules only (role/allowlist enforced by VaultCore).
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
