// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IGuaranteeFundManager
 * @notice Interface for locking, releasing, and forfeiting guarantee balances across supported assets.
 * @dev Reverts if:
 *      - callers invoke state-mutating paths without the implementation's required privileged role or module binding
 *      - user, asset, receiver, or amount inputs violate implementation invariants
 *      - requested release/forfeit/settlement amounts exceed currently locked guarantee balance
 *
 * Security:
 * - Core state-mutating flows are expected to be restricted to privileged modules such as VaultCore.
 * - Amounts are expressed in token base units of the referenced guarantee asset.
 */
interface IGuaranteeFundManager {
    /**
     * @notice Locks guarantee funds for `user` in `asset`.
     * @dev Reverts if:
     *      - the caller is not authorized to lock guarantee balances
     *      - `user` or `asset` is invalid
     *      - `amount` is zero, invalid, or token transfer into custody fails
     *
     * Security:
     * - Privileged write path that moves assets into guarantee custody.
     *
     * @param user User address.
     * @param asset Guarantee asset address.
     * @param amount Guarantee amount in token base units.
     */
    function lockGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external;

    /**
     * @notice Releases guarantee funds for `user` in `asset`.
     * @dev Reverts if:
     *      - the caller is not authorized to release guarantee balances
     *      - `user` or `asset` is invalid
     *      - `amount` exceeds the currently locked balance
     *      - token transfer out of custody fails
     *
     * Security:
     * - Privileged write path that decreases locked guarantee exposure.
     *
     * @param user User address.
     * @param asset Guarantee asset address.
     * @param amount Amount to release in token base units.
     */
    function releaseGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external;

    /**
     * @notice Forfeits the user's guarantee balance to `feeReceiver`.
     * @dev Reverts if:
     *      - the caller is not authorized to forfeit guarantee balances
     *      - `user`, `asset`, or `feeReceiver` is invalid
     *      - no locked guarantee balance exists for `(user, asset)`
     *      - token transfer out of custody fails
     *
     * Security:
     * - Privileged terminal settlement path that consumes the full remaining locked balance.
     *
     * @param user User address.
     * @param asset Guarantee asset address.
     * @param feeReceiver Receiver of the forfeited funds.
     */
    function forfeitGuarantee(
        address user,
        address asset,
        address feeReceiver
    ) external;

    /**
     * @notice Early repayment settlement (3-way distribution).
     * @dev Distributes the entire locked guarantee balance into:
     *      - refundToBorrower (to user)
     *      - penaltyToLender (to lender)
     *      - platformFee (routed via FeeRouter)
     *
     * Reverts if:
     *      - the caller is not authorized to execute early-repayment settlement
     *      - `user`, `asset`, or `lender` is invalid
     *      - the sum of `refundToBorrower + penaltyToLender + platformFee` does not equal the full locked balance
     *      - any downstream transfer or FeeRouter distribution fails
     *
     * Security:
     * - Privileged full-balance settlement path.
     * - The implementation is expected to zero the user's locked balance atomically before external transfers.
     *
     * @param user Borrower address.
     * @param asset ERC20 guarantee asset address.
     * @param lender Lender address that receives penaltyToLender.
     * @param refundToBorrower Amount refunded to borrower.
     * @param penaltyToLender Amount paid to lender as penalty.
     * @param platformFee Amount paid to platform as fee.
     */
    function settleEarlyRepayment(
        address user,
        address asset,
        address lender,
        uint256 refundToBorrower,
        uint256 penaltyToLender,
        uint256 platformFee
    ) external;

    /**
     * @notice Forfeit a partial amount of user's guarantee to a receiver.
     * @dev Reverts if:
     *      - the caller is not authorized to execute partial forfeiture
     *      - `user`, `asset`, or `receiver` is invalid
     *      - `amount` exceeds the currently locked balance
     *      - token transfer out of custody fails
     *
     * Security:
     * - Privileged partial-settlement path, typically used for default or penalty flows.
     *
     * @param user Borrower address.
     * @param asset ERC20 guarantee asset address.
     * @param receiver Receiver of the forfeited amount.
     * @param amount Amount to forfeit.
     */
    function forfeitPartial(
        address user,
        address asset,
        address receiver,
        uint256 amount
    ) external;

    /**
     * @notice Forfeit a partial amount and then best-effort trigger Reward liquidation penalty.
     * @dev Reverts if:
     *      - the caller is not authorized to execute partial forfeiture
     *      - `user`, `asset`, or `receiver` is invalid
     *      - `amount` exceeds the currently locked balance
     *      - token transfer out of custody fails
     *
     * Security:
     * - Privileged default-settlement path.
     * - Reward penalty trigger is expected to be best-effort and must not affect custody settlement finality.
     *
     * @param user Borrower address.
     * @param asset ERC20 guarantee asset address.
     * @param receiver Receiver of the forfeited amount.
     * @param amount Amount to forfeit.
     */
    function forfeitPartialWithRewardPenalty(
        address user,
        address asset,
        address receiver,
        uint256 amount
    ) external;

    /**
     * @notice Forfeit to multiple receivers in one call.
     * @dev Reverts if:
     *      - the caller is not authorized to execute default settlement
     *      - `user` or `asset` is invalid
     *      - `receivers` and `amounts` lengths mismatch or are empty
     *      - the aggregate forfeited amount violates the implementation's full-balance settlement invariant
     *      - any receiver entry is invalid or downstream transfer fails
     *
     * Security:
     * - Privileged multi-recipient settlement path.
     * - Implementations may require the forfeited sum to equal the full locked balance.
     *
     * @param user Borrower address.
     * @param asset ERC20 guarantee asset address.
     * @param receivers Receiver addresses.
     * @param amounts Amounts for each receiver.
     */
    function settleDefault(
        address user,
        address asset,
        address[] calldata receivers,
        uint256[] calldata amounts
    ) external;

    /**
     * @notice Returns the locked guarantee amount for `user` and `asset`.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only balance query.
     *
     * @param user User address.
     * @param asset Guarantee asset address.
     * @return amount Locked guarantee amount.
     */
    function getLockedGuarantee(
        address user,
        address asset
    ) external view returns (uint256 amount);

    /**
     * @notice Returns the aggregate guarantee amount tracked for `asset`.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only aggregate query.
     *
     * @param asset Guarantee asset address.
     * @return totalAmount Total guarantee amount for the asset.
     */
    function getTotalGuaranteeByAsset(
        address asset
    ) external view returns (uint256 totalAmount);

    /**
     * @notice Returns the list of guarantee assets currently associated with `user`.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only metadata query.
     *
     * @param user User address.
     * @return assets Guarantee asset addresses for the user.
     */
    function getUserGuaranteeAssets(
        address user
    ) external view returns (address[] memory assets);

    /**
     * @notice Returns whether `user` currently has guarantee funds locked in `asset`.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only boolean probe.
     *
     * @param user User address.
     * @param asset Guarantee asset address.
     * @return paid Whether the guarantee is currently funded.
     */
    function isGuaranteePaid(
        address user,
        address asset
    ) external view returns (bool paid);

    /**
     * @notice Locks guarantee funds across multiple assets for `user`.
     * @dev Reverts if:
     *      - the caller is not authorized to batch-lock guarantees
     *      - `assets` and `amounts` lengths mismatch or are empty
     *      - any individual lock operation would fail
     *
     * Security:
     * - Privileged batch write path.
     * - Implementations are expected to fail atomically on malformed batches.
     *
     * @param user User address.
     * @param assets Guarantee asset addresses.
     * @param amounts Amounts aligned with `assets`.
     */
    function batchLockGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external;

    /**
     * @notice Releases guarantee funds across multiple assets for `user`.
     * @dev Reverts if:
     *      - the caller is not authorized to batch-release guarantees
     *      - `assets` and `amounts` lengths mismatch or are empty
     *      - any individual release operation would fail
     *
     * Security:
     * - Privileged batch write path.
     * - Implementations are expected to fail atomically on malformed batches.
     *
     * @param user User address.
     * @param assets Guarantee asset addresses.
     * @param amounts Amounts aligned with `assets`.
     */
    function batchReleaseGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external;
}
