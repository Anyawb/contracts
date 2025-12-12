// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LoanEvents
 * @dev 定义借贷平台的保证金相关事件
 * @notice 包含保证金锁定、释放和没收等事件
 * @dev 这些事件被 VaultLendingEngine 和 GuaranteeFundManager 使用
 * @custom:security-contact security@example.com
 */
contract LoanEvents {
    // =================== 保证金相关事件 ===================
    /**
     * @dev 保证金锁定事件
     * @param user 用户地址
     * @param asset 资产地址
     * @param amount 保证金金额
     * @param timestamp 时间戳
     */
    event GuaranteeLocked(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );

    /**
     * @dev 保证金释放事件
     * @param user 用户地址
     * @param asset 资产地址
     * @param amount 保证金金额
     * @param timestamp 时间戳
     */
    event GuaranteeReleased(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 timestamp
    );

    /**
     * @dev 保证金没收事件
     * @param user 用户地址
     * @param asset 资产地址
     * @param amount 保证金金额
     * @param feeReceiver 费用接收者地址
     * @param timestamp 时间戳
     */
    event GuaranteeForfeited(
        address indexed user,
        address indexed asset,
        uint256 amount,
        address indexed feeReceiver,
        uint256 timestamp
    );
} 