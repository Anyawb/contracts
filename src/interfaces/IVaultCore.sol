// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVaultCore
 * @notice VaultCore user-facing write entrypoints (authority path).
 * @dev Architecture SSOT:
 * - User write entrypoints live in VaultCore.
 * - deposit/withdraw route through VaultRouter -> CollateralManager.
 * - Borrow disbursement + orderId creation is orchestrated via SSOT match/settlement paths
 *   (e.g., VaultBusinessLogic.finalizeMatch(...) -> VaultCore.borrowFor(...) -> ORDER_ENGINE.createLoanOrder(...)).
 *   Therefore there is intentionally no direct user-facing borrow entrypoint in VaultCore.
 * - repay MUST go through SettlementManager.repayAndSettle(orderId,...) (SSOT for repay/settle).
 *
 * Security:
 * - VaultCore is a privileged entrypoint: it routes writes to modules resolved via Registry.
 * - This interface intentionally excludes cache-push entrypoints; see IVaultCoreDataPush.
 *
 * Observability:
 * - Prefer module-level events and `DataPushed` for off-chain consumption.
 */
interface IVaultCore {
    /*━━━━━━━━━━━━━━━ Core Business Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Deposit collateral (authority path).
     * @dev Reverts if:
     *      - asset == address(0)
     *      - amount == 0
     *      - downstream routing (VaultRouter / CollateralManager) reverts
     *
     * Security:
     * - User entrypoint.
     * - Non-reentrant in implementation.
     *
     * @param asset Collateral asset address
     * @param amount Collateral amount (token decimals)
     */
    function deposit(address asset, uint256 amount) external;

    /**
     * @notice Repay and settle (SSOT via SettlementManager).
     * @dev Reverts if:
     *      - asset == address(0)
     *      - amount == 0
     *      - Registry module resolution fails (e.g., SettlementManager missing)
     *      - ERC20 transferFrom fails
     *      - SettlementManager reverts (orderId/state validation, etc.)
     *
     * Security:
     * - User entrypoint.
     * - Non-reentrant in implementation.
     *
     * @param orderId Loan/order identifier (SSOT)
     * @param asset Debt asset address
     * @param amount Repay amount (token decimals)
     */
    function repay(uint256 orderId, address asset, uint256 amount) external;

    /**
     * @notice Withdraw collateral (authority path).
     * @dev Reverts if:
     *      - asset == address(0)
     *      - amount == 0
     *      - downstream routing (VaultRouter / CollateralManager) reverts
     *
     * Security:
     * - User entrypoint.
     * - Non-reentrant in implementation.
     *
     * @param asset Collateral asset address
     * @param amount Withdraw amount (token decimals)
     */
    function withdraw(address asset, uint256 amount) external;

    /**
     * @notice Batch deposit collateral.
     * @dev Reverts if:
     *      - assets.length != amounts.length
     *      - assets.length == 0
     *      - assets.length exceeds the implementation batch cap
     *      - any asset == address(0)
     *      - any amount == 0
     *      - downstream routing (VaultRouter / CollateralManager) reverts
     *
     * Security:
     * - User entrypoint.
     * - Non-reentrant in implementation.
     *
     * @param assets Collateral asset addresses
     * @param amounts Collateral amounts (token decimals)
     */
    function batchDeposit(
        address[] calldata assets,
        uint256[] calldata amounts
    ) external;

    /**
     * @notice Batch repay and settle.
     * @dev Reverts if:
     *      - orderIds.length != assets.length
     *      - assets.length != amounts.length
     *      - assets.length == 0
     *      - assets.length exceeds the implementation batch cap
     *      - any asset == address(0)
     *      - any amount == 0
     *      - Registry module resolution fails (e.g., SettlementManager missing)
     *      - ERC20 transferFrom fails for any item
     *      - SettlementManager reverts for any item
     *
     * Security:
     * - User entrypoint.
     * - Non-reentrant in implementation.
     *
     * @param orderIds Loan/order identifiers (SSOT)
     * @param assets Debt asset addresses
     * @param amounts Repay amounts (token decimals)
     */
    function batchRepay(
        uint256[] calldata orderIds,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external;

    /**
     * @notice Batch withdraw collateral.
     * @dev Reverts if:
     *      - assets.length != amounts.length
     *      - assets.length == 0
     *      - assets.length exceeds the implementation batch cap
     *      - any asset == address(0)
     *      - any amount == 0
     *      - downstream routing (VaultRouter / CollateralManager) reverts for any item
     *
     * Security:
     * - User entrypoint.
     * - Non-reentrant in implementation.
     *
     * @param assets Collateral asset addresses
     * @param amounts Withdraw amounts (token decimals)
     */
    function batchWithdraw(
        address[] calldata assets,
        uint256[] calldata amounts
    ) external;

    /**
     * @notice Borrow on behalf of a borrower (orchestrated module path).
     * @dev Reverts if:
     *      - caller is not an authorized business module (implementation-defined allowlist)
     *      - borrower == address(0) or asset == address(0)
     *      - amount == 0
     *      - Registry module resolution fails (e.g., LendingEngine missing)
     *      - LendingEngine reverts
     *
     * Security:
     * - Non-user entrypoint; implementation restricts callers to registered business modules.
     *
     * @param borrower Borrower address
     * @param asset Debt asset address
     * @param amount Borrow amount (token decimals)
     * @param termDays Loan term (days)
     */
    function borrowFor(
        address borrower,
        address asset,
        uint256 amount,
        uint16 termDays
    ) external;
}
