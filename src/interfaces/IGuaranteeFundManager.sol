// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IGuaranteeFundManager 保证金管理接口
/// @notice 提供保证金锁定、释放和没收的统一接口
/// @dev 支持多种资产的保证金管理，仅 VaultCore 可调用核心功能
interface IGuaranteeFundManager {
    /**
     * @notice 锁定用户保证金
     * @param user 用户地址
     * @param asset 资产地址
     * @param amount 保证金金额
     */
    function lockGuarantee(address user, address asset, uint256 amount) external;

    /**
     * @notice 释放用户保证金
     * @param user 用户地址
     * @param asset 资产地址
     * @param amount 释放金额
     */
    function releaseGuarantee(address user, address asset, uint256 amount) external;

    /**
     * @notice 没收用户保证金
     * @param user 用户地址
     * @param asset 资产地址
     * @param feeReceiver 费用接收者地址
     */
    function forfeitGuarantee(address user, address asset, address feeReceiver) external;

    /**
     * @notice Early repayment settlement (3-way distribution).
     * @dev Distributes the entire locked guarantee balance into:
     *      - refundToBorrower (to user)
     *      - penaltyToLender (to lender)
     *      - platformFee (routed via FeeRouter)
     *
     * Reverts if:
     * - sum(refundToBorrower, penaltyToLender, platformFee) does not match the user's locked guarantee balance
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
     * @dev Typically used for default / penalty settlement paths.
     * @param user Borrower address.
     * @param asset ERC20 guarantee asset address.
     * @param receiver Receiver of the forfeited amount.
     * @param amount Amount to forfeit.
     */
    function forfeitPartial(address user, address asset, address receiver, uint256 amount) external;

    /**
     * @notice Forfeit to multiple receivers in one call.
     * @dev Implementations may require the forfeited sum equals the full locked balance.
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
     * @notice 查询用户指定资产的锁定保证金
     * @param user 用户地址
     * @param asset 资产地址
     * @return amount 锁定保证金金额
     */
    function getLockedGuarantee(address user, address asset) external view returns (uint256 amount);

    /**
     * @notice 查询指定资产的总保证金
     * @param asset 资产地址
     * @return totalAmount 总保证金金额
     */
    function getTotalGuaranteeByAsset(address asset) external view returns (uint256 totalAmount);

    /**
     * @notice 查询用户所有保证金资产列表
     * @param user 用户地址
     * @return assets 用户保证金的资产地址数组
     */
    function getUserGuaranteeAssets(address user) external view returns (address[] memory assets);

    /**
     * @notice 查询用户是否已支付（当前持有）指定资产的保证金
     * @param user 用户地址
     * @param asset 资产地址
     * @return paid 是否已支付
     */
    function isGuaranteePaid(address user, address asset) external view returns (bool paid);

    /**
     * @notice 批量锁定保证金
     * @param user 用户地址
     * @param assets 资产地址数组
     * @param amounts 金额数组
     */
    function batchLockGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external;

    /**
     * @notice 批量释放保证金
     * @param user 用户地址
     * @param assets 资产地址数组
     * @param amounts 金额数组
     */
    function batchReleaseGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external;
} 