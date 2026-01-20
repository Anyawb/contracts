// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPositionView
 * @notice Minimal PositionView surface used by router/modules for cache writes and reads.
 * @dev Notes:
 * - PositionView is the SSOT for cached user positions (read path), with validity flags / TTL.
 * - Write functions are intended to be called by the authorized writer (typically VaultRouter),
 *   which is resolved via `Registry.KEY_VAULT_CORE -> VaultCore.viewContractAddrVar()`.
 * - This interface includes legacy overloads for migration; strict deployments should prefer the
 *   contexted + versioned variants.
 */
interface IPositionView {
    /**
     * @notice Push a full (absolute) user position update (legacy overload).
     * @dev Reverts if:
     *      - caller is not an authorized writer
     *      - inputs are invalid per implementation rules
     *
     * Security:
     * - Writer-gated (e.g., ACTION_VIEW_PUSH / onlyVaultRouter depending on implementation).
     *
     * @param user User address
     * @param asset Asset address
     * @param collateral Collateral amount (token decimals)
     * @param debt Debt amount (token decimals)
     */
    function pushUserPositionUpdate(address user, address asset, uint256 collateral, uint256 debt) external;

    /**
     * @notice Push a full (absolute) user position update with idempotency context.
     * @dev Reverts if:
     *      - caller is not an authorized writer
     *      - context violates ordering/idempotency rules (implementation-defined)
     *
     * Security:
     * - Writer-gated.
     *
     * @param user User address
     * @param asset Asset address
     * @param collateral Collateral amount (token decimals)
     * @param debt Debt amount (token decimals)
     * @param requestId Optional idempotency key (may be 0x0)
     * @param seq Optional monotonic sequence number (may be 0)
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
     *      - caller is not an authorized writer
     *      - nextVersion violates optimistic concurrency rules (implementation-defined)
     *
     * Security:
     * - Writer-gated.
     *
     * @param user User address
     * @param asset Asset address
     * @param collateral Collateral amount (token decimals)
     * @param debt Debt amount (token decimals)
     * @param nextVersion Target version (0 means "auto-increment mode")
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
     *      - caller is not an authorized writer
     *      - context/version violates idempotency or optimistic concurrency rules
     *
     * Security:
     * - Writer-gated.
     *
     * @param user User address
     * @param asset Asset address
     * @param collateral Collateral amount (token decimals)
     * @param debt Debt amount (token decimals)
     * @param requestId Optional idempotency key (may be 0x0)
     * @param seq Optional monotonic sequence number (may be 0)
     * @param nextVersion Target version (0 means "auto-increment mode")
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
     * @notice Push a delta user position update (legacy overload).
     * @dev Reverts if:
     *      - caller is not an authorized writer
     *      - applying delta would violate bounds/underflow rules (implementation-defined)
     *
     * Security:
     * - Writer-gated.
     *
     * @param user User address
     * @param asset Asset address
     * @param collateralDelta Collateral delta (token decimals; signed)
     * @param debtDelta Debt delta (token decimals; signed)
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta
    ) external;

    /**
     * @notice Push a delta user position update with idempotency context.
     * @dev Reverts if:
     *      - caller is not an authorized writer
     *      - context violates ordering/idempotency rules (implementation-defined)
     *
     * Security:
     * - Writer-gated.
     *
     * @param user User address
     * @param asset Asset address
     * @param collateralDelta Collateral delta (token decimals; signed)
     * @param debtDelta Debt delta (token decimals; signed)
     * @param requestId Optional idempotency key (may be 0x0)
     * @param seq Optional monotonic sequence number (may be 0)
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
     *      - caller is not an authorized writer
     *      - nextVersion violates optimistic concurrency rules (implementation-defined)
     *
     * Security:
     * - Writer-gated.
     *
     * @param user User address
     * @param asset Asset address
     * @param collateralDelta Collateral delta (token decimals; signed)
     * @param debtDelta Debt delta (token decimals; signed)
     * @param nextVersion Target version (0 means "auto-increment mode")
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
     *      - caller is not an authorized writer
     *      - context/version violates idempotency or optimistic concurrency rules
     *
     * Security:
     * - Writer-gated.
     *
     * @param user User address
     * @param asset Asset address
     * @param collateralDelta Collateral delta (token decimals; signed)
     * @param debtDelta Debt delta (token decimals; signed)
     * @param requestId Optional idempotency key (may be 0x0)
     * @param seq Optional monotonic sequence number (may be 0)
     * @param nextVersion Target version (0 means "auto-increment mode")
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
     * @notice Get the current cached version for a (user, asset) position.
     * @dev Reverts if:
     *      - implementation applies read access control and caller is not authorized
     *
     * Security:
     * - Read access may be gated depending on implementation policy.
     *
     * @param user User address
     * @param asset Asset address
     * @return version Current version (0 means never written)
     */
    function getPositionVersion(address user, address asset) external view returns (uint64);

    /**
     * @notice Get the cached user position for a given asset (collateral and debt).
     * @dev Reverts if:
     *      - implementation applies read access control and caller is not authorized
     *
     * Security:
     * - Read access may be gated depending on implementation policy.
     *
     * @param user User address
     * @param asset Asset address
     * @return collateral Cached collateral (token decimals)
     * @return debt Cached debt (token decimals)
     */
    function getUserPosition(address user, address asset) external view returns (uint256 collateral, uint256 debt);

    /**
     * @notice Get a user position along with cache validity.
     * @dev Reverts if:
     *      - implementation applies read access control and caller is not authorized
     *
     * Security:
     * - Read access may be gated depending on implementation policy.
     *
     * @param user User address
     * @param asset Asset address
     * @return collateral Position collateral (may fall back to ledger when cache is invalid)
     * @return debt Position debt (may fall back to ledger when cache is invalid)
     * @return isValid True if cached value is considered valid; false if fallback path was used
     */
    function getUserPositionWithValidity(
        address user,
        address asset
    ) external view returns (uint256 collateral, uint256 debt, bool isValid);
}




