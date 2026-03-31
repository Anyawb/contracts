// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFeeRouterDistribution
 * @notice Narrow fee distribution interface for callers that only trigger fee settlement.
 * @dev Reverts if:
 *      - the caller is not authorized to trigger fee distribution
 *      - token, amount, or fee-type inputs are invalid for the requested distribution path
 *      - the underlying fee-router implementation rejects the operation due to unsupported tokens, invalid batch
 *        shapes, or insufficient prepaid balance
 *
 * Security:
 * - Use this action-cut interface in business/liquidation paths to avoid depending on unrelated fee views and
 *   governance configuration methods.
 */
interface IFeeRouterDistribution {
    /**
     * @notice Distribute fee amount according to the current configuration.
     * @dev Reverts if:
     *      - the caller is not authorized to trigger fee distribution
     *      - `token` is unsupported or `amount` is zero/invalid
     *      - the underlying transfer or routing path fails
     *
     * Security:
     * - Write path for immediate fee collection from the caller.
     * - Implementations typically gate this call with the same action key used by business modules that originate the
     *   fee-bearing action.
     *
     * @param token ERC20 token address.
     * @param amount Fee amount (token decimals of `token`).
     */
    function distributeNormal(address token, uint256 amount) external;

    /**
     * @notice Distribute fee amount according to the dynamic fee configuration for (token, feeType).
     * @dev Reverts if:
     *      - the caller is not authorized to trigger fee distribution
     *      - `token` is unsupported, `amount` is zero/invalid, or `feeType` is not configured
     *      - the underlying transfer or routing path fails
     *
     * Security:
     * - Write path for fee settlement using a fee-type-specific configuration.
     *
     * @param token ERC20 token address.
     * @param amount Fee amount (token decimals of `token`).
     * @param feeType Fee type identifier.
     */
    function distributeDynamic(
        address token,
        uint256 amount,
        bytes32 feeType
    ) external;

    /**
     * @notice Distribute a prepaid fee amount already held by FeeRouter.
        * @dev Reverts if:
        *      - the caller is not authorized to trigger prepaid distribution
        *      - `token` is unsupported or `amount` is zero/invalid
        *      - the implementation lacks sufficient prepaid balance for the requested transfer
        *
        * Security:
        * - Write path for fee amounts already custodied by FeeRouter.
        * - `payer` is typically used for attribution/observability rather than token transfer authorization.
        *
     * @param token ERC20 token address.
     * @param amount Prepaid fee amount already transferred to FeeRouter.
     * @param feeType Fee type identifier.
     * @param payer Payer address for fee statistics attribution.
     */
    function distributePrepaid(
        address token,
        uint256 amount,
        bytes32 feeType,
        address payer
    ) external;

    /**
     * @notice Batch distribute multiple fee items for a token.
        * @dev Reverts if:
        *      - the caller is not authorized to trigger fee distribution
        *      - `token` is unsupported
        *      - batch lengths mismatch, exceed implementation limits, or otherwise violate routing constraints
        *      - any underlying transfer or routing path fails
        *
        * Security:
        * - Batch write path used to amortize multiple fee settlements into one transaction.
        * - Implementations commonly fail atomically if the batch shape is invalid.
        *
     * @param token ERC20 token address.
     * @param amounts Per-item total amounts (token decimals of `token`).
     * @param feeTypes Per-item fee type identifiers.
     */
    function batchDistribute(
        address token,
        uint256[] calldata amounts,
        bytes32[] calldata feeTypes
    ) external;
}