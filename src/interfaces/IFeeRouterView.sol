// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFeeRouterView
 * @notice View-layer mirror interface for FeeRouter (push-only; best-effort writers call into these entrypoints).
 * @dev Reverts if:
 *      - implementation-defined (typically: registry not configured / caller not authorized as FeeRouter)
 *
 * Security:
 * - Writer-gated in implementation (expected: only the SSOT FeeRouter contract may push)
 */
interface IFeeRouterView {
    /**
     * @notice Push a user-scoped fee update into the view cache (best-effort).
     * @dev Reverts if:
     *      - implementation-defined (authorization/registry not configured)
     *
     * Security:
     * - Writer-gated in implementation (expected: only FeeRouter)
     *
     * @param user User address (cache key)
     * @param feeType Fee type identifier (bytes32)
     * @param feeAmount Fee amount to accumulate (token decimals; same unit as writer)
     * @param personalFeeBps Applied personal fee rate in bps (\(1e4 = 100%\))
     */
    function pushUserFeeUpdate(
        address user,
        bytes32 feeType,
        uint256 feeAmount,
        uint256 personalFeeBps
    ) external;

    /**
     * @notice Push global distribution counters into the view cache (best-effort).
     * @dev Reverts if:
     *      - implementation-defined (authorization/registry not configured)
     *
     * Security:
     * - Writer-gated in implementation (expected: only FeeRouter)
     *
     * @param totalDistributions Total distribution count (unitless)
     * @param totalAmountDistributed Total distributed amount (token decimals aggregated by writer)
     */
    function pushGlobalStatsUpdate(
        uint256 totalDistributions,
        uint256 totalAmountDistributed
    ) external;

    /**
     * @notice Push the FeeRouter system config into the view cache (best-effort).
     * @dev Reverts if:
     *      - implementation-defined (authorization/registry not configured)
     *
     * Security:
     * - Writer-gated in implementation (expected: only FeeRouter)
     *
     * @param platformTreasury Platform treasury address
     * @param ecosystemVault Ecosystem vault address
     * @param platformFeeBps Platform fee rate in bps (\(1e4 = 100%\))
     * @param ecosystemFeeBps Ecosystem fee rate in bps (\(1e4 = 100%\))
     * @param supportedTokens List of supported ERC20 token addresses
     */
    function pushSystemConfigUpdate(
        address platformTreasury,
        address ecosystemVault,
        uint256 platformFeeBps,
        uint256 ecosystemFeeBps,
        address[] calldata supportedTokens
    ) external;

    /**
     * @notice Push a single global fee statistic value for (token, feeType) (best-effort).
     * @dev Reverts if:
     *      - implementation-defined (authorization/registry not configured)
     *
     * Security:
     * - Writer-gated in implementation (expected: only FeeRouter)
     *
     * @param token ERC20 token address
     * @param feeType Fee type identifier (bytes32)
     * @param amount Total accumulated amount (token decimals)
     */
    function pushGlobalFeeStatistic(
        address token,
        bytes32 feeType,
        uint256 amount
    ) external;
}
