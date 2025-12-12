// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAccessControlManager } from "./IAccessControlManager.sol";

/// @title IFeeRouter 手续费路由接口
/// @notice 定义各类手续费收取与分发逻辑
/// @dev 实际费率与分配策略由实现合约决定
interface IFeeRouter {
    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    
    event FeeDistributed(address indexed token, uint256 platformAmount, uint256 ecoAmount);
    event FeeConfigUpdated(uint256 platformFeeBps, uint256 ecoFeeBps);
    event TreasuryUpdated(address platformTreasury, address ecoVault);
    event DynamicFeeUpdated(address indexed token, bytes32 indexed feeType, uint256 feeBps);
    event TokenSupported(address indexed token, bool supported);
    event BatchFeeDistributed(address indexed token, uint256 totalAmount, uint256 distribution);
    event FeeStatisticsUpdated(address indexed token, bytes32 indexed feeType, uint256 totalAmount);
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event PermissionVerified(address indexed caller, bytes32 indexed action, bool success);
    event TransferRetryAttempt(address indexed token, address indexed destination, uint256 amount, uint256 attempt);
    event TransferFailed(address indexed token, address indexed destination, uint256 amount, string reason);
    event BackupRouterRegistered(bytes32 indexed routerKey, address indexed routerContract, string routerName);
    event RouterStatusChanged(address indexed routerContract, bool isActive);
    event RouterHealthCheck(address indexed router, bool isHealthy, string message);

    /*━━━━━━━━━━━━━━━ CORE FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 向用户收取存款手续费
     * @param user 用户地址
     * @param amount 存款金额
     * @return fee 实际收取的手续费（0 表示手续费未启用）
     */
    function chargeDepositFee(address user, uint256 amount) external view returns (uint256 fee);

    /**
     * @notice 向用户收取借款手续费
     * @param user 用户地址
     * @param amount 借款金额
     * @return fee 实际收取的手续费
     */
    function chargeBorrowFee(address user, uint256 amount) external view returns (uint256 fee);

    /**
     * @notice 将手续费按常规规则分发
     * @param token 代币地址
     * @param amount 手续费金额
     */
    function distributeNormal(address token, uint256 amount) external;

    /**
     * @notice 获取当前手续费率
     * @return 当前手续费率（基点，10000 = 100%）
     */
    function getFeeRate() external view returns (uint256);

    /*━━━━━━━━━━━━━━━ VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 查询代币是否支持
     * @param token 代币地址
     * @return 是否支持
     */
    function isTokenSupported(address token) external view returns (bool);

    /**
     * @notice 获取支持的代币列表
     * @return 支持的代币地址数组
     */
    function getSupportedTokens() external view returns (address[] memory);



    /**
     * @notice 获取Registry地址
     * @return Registry合约地址
     */
    function getRegistry() external view returns (address);

    /**
     * @notice 获取平台金库地址
     * @return 平台金库地址
     */
    function getPlatformTreasury() external view returns (address);

    /**
     * @notice 获取生态金库地址
     * @return 生态金库地址
     */
    function getEcosystemVault() external view returns (address);

    /**
     * @notice 获取平台手续费比例
     * @return 平台手续费比例（基点）
     */
    function getPlatformFeeBps() external view returns (uint256);

    /**
     * @notice 获取生态手续费比例
     * @return 生态手续费比例（基点）
     */
    function getEcosystemFeeBps() external view returns (uint256);

    /**
     * @notice 获取总分发次数
     * @return 总分发次数
     */
    function getTotalDistributions() external view returns (uint256);

    /**
     * @notice 获取总分发金额
     * @return 总分发金额
     */
    function getTotalAmountDistributed() external view returns (uint256);

    /*━━━━━━━━━━━━━━━ ADMIN VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 获取费用统计（管理员功能）
     * @param token 代币地址
     * @param feeType 费用类型
     * @return 费用统计金额
     */
    function getFeeStatistics(address token, bytes32 feeType) external view returns (uint256);

    /**
     * @notice 获取动态费用配置（管理员功能）
     * @param token 代币地址
     * @param feeType 费用类型
     * @return 动态费用配置值
     */
    function getDynamicFee(address token, bytes32 feeType) external view returns (uint256);

    /**
     * @notice 获取费用缓存（管理员功能）
     * @param token 代币地址
     * @param feeType 费用类型
     * @return 费用缓存金额
     */
    function getFeeCache(address token, bytes32 feeType) external view returns (uint256);

    /**
     * @notice 获取操作统计信息（管理员功能）
     * @return distributions 总分发次数
     * @return totalAmount 总分发金额
     */
    function getOperationStats() external view returns (uint256 distributions, uint256 totalAmount);
} 