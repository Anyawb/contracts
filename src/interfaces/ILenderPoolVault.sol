// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILenderPoolVault
 * @notice Minimal interface for `LenderPoolVault`: pooled custody + restricted `transferOut` for settlement.
 * @dev Reverts if:
 *      - implementation-defined pool-custody validation fails, including zero-address, zero-amount, pause, or caller
 *        authorization checks
 *      - ERC20 transfer or transferFrom operations fail in the implementation
 *
 * @dev Architecture SSOT:
 * - Online liquidity is custodied in `LenderPoolVault` (Registry KEY_LENDER_POOL_VAULT).
 * - Under the pool-based model, `LoanOrder.lender` MUST be this pool address (not the lender signer).
 *
 * Security:
 * - In the implementation, `transferOut` MUST remain restricted to Registry-configured settlement orchestrators.
 * - Current blocks-only flows rely on BlocksOnlyCoordinator being authorized to source principal and repay/settle
 *   custody from the pool.
 */
interface ILenderPoolVault {
    /**
     * @notice Deposit assets into the pool vault (custody).
     * @dev Reverts if:
     *      - implementation-defined (typically: asset is zero / amount is zero / paused / ERC20 transferFrom fails)
     *
     * Security:
     * - In the implementation, this should be nonReentrant and pause-aware.
     *
     * @param asset ERC20 asset address
     * @param amount Amount to deposit (token native decimals)
     */
    function deposit(address asset, uint256 amount) external;

    /**
     * @notice Transfer assets out of the pool vault (restricted settlement outflow).
     * @dev Reverts if:
     *      - implementation-defined (typically: asset/to is zero / amount is zero / paused / caller not authorized)
     *
     * Security:
     * - MUST be restricted in the implementation to Registry-authorized settlement orchestrators.
     * - Current implementations allow VaultBusinessLogic and BlocksOnlyCoordinator to source settlement outflows.
     *
     * @param asset ERC20 asset address
     * @param to Recipient address
     * @param amount Amount to transfer (token native decimals)
     */
    function transferOut(address asset, address to, uint256 amount) external;

    /**
     * @notice Get configured Registry address.
     * @dev Reverts if:
     *      - none
     *
     * @return registry Registry address (module resolver)
     */
    function registryAddrVar() external view returns (address registry);
}
