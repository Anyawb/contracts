// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

// 常量迁移至 DataPushTypes

/// @title FeeRouterView
/// @notice 费用路由查询视图模块 - 超低Gas的费用数据查询
/// @dev 使用内部数据镜像，实现超低Gas查询（~100 gas）
/// @dev 数据通过FeeRouter主动推送更新，确保实时性
/// @dev 严格权限控制：用户只能查看自己的数据，管理员可查看全部数据
/// @custom:security-contact security@example.com
contract FeeRouterView is Initializable, UUPSUpgradeable, ViewVersioned {
    
    /// @notice Registry 合约地址
    address private _registryAddr;
    
    /// @notice 最大批量查询大小（统一常量）
    uint256 public constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    
    /*━━━━━━━━━━━━━━━ 内部数据镜像（超低 Gas 优化）━━━━━━━━━━━━━━━*/
    
    /// @notice 用户费用统计 user => feeType => amount
    mapping(address => mapping(bytes32 => uint256)) private _userFeeStatistics;
    
    /// @notice 用户动态费用配置 user => feeType => feeBps
    mapping(address => mapping(bytes32 => uint256)) private _userDynamicFees;
    
    /// @notice 全局费用统计（仅管理员可见）token => feeType => amount
    mapping(address => mapping(bytes32 => uint256)) private _globalFeeStatistics;
    
    /// @notice 全局操作统计（仅管理员可见）
    struct GlobalStats {
        uint256 totalDistributions;
        uint256 totalAmountDistributed;
    }
    GlobalStats private _globalStats;
    
    /// @notice 系统配置（仅管理员可见）
    struct SystemConfig {
        address platformTreasury;
        address ecosystemVault;
        uint256 platformFeeBps;
        uint256 ecosystemFeeBps;
        address[] supportedTokens;
    }
    SystemConfig private _systemConfig;
    
    /// @notice 支持的代币映射（公开可见）
    mapping(address => bool) private _supportedTokens;
    
    /// @notice 用户个人统计
    struct UserStats {
        uint256 totalFeePaid;
        uint256 transactionCount;
        uint256 lastActivityTime;
    }
    mapping(address => UserStats) private _userStats;
    
    /// @notice 数据同步时间戳
    uint256 private _lastSyncTimestamp;
    
    /// @notice 同步间隔（秒）
    uint256 public constant SYNC_INTERVAL = 300; // 5分钟
    
    /*━━━━━━━━━━━━━━━ 结构体定义 ━━━━━━━━━━━━━━━*/

    /// @notice 用户费用配置结构体
    struct UserFeeConfig {
        uint256 personalFeeBps;
        uint256 discountLevel;
        bool vipStatus;
        uint256 totalFeePaid;
        uint256 transactionCount;
    }

    /// @notice 系统费用分析（仅管理员）
    struct SystemFeeAnalytics {
        uint256 totalVolume;
        uint256 totalFees;
        uint256 platformRevenue;
        uint256 ecosystemRevenue;
        uint256 averageFeeRate;
        uint256 distributionCount;
    }

    /// @notice 用户费用分析
    struct UserFeeAnalytics {
        uint256 totalPaidFees;
        uint256 averageFeeRate;
        uint256 transactionCount;
        uint256 lastTransactionTime;
        bytes32[] feeTypes;
        uint256[] feeAmounts;
    }

    /*━━━━━━━━━━━━━━━ 事件 ━━━━━━━━━━━━━━━*/
    
    /// @notice 数据同步事件
    event DataSynced(address indexed caller, uint256 timestamp);
    
    /// @notice 用户数据推送事件
    event UserDataPushed(address indexed user, string dataType, uint256 timestamp); // DEPRECATED – use IDataPush.DataPushed
    
    /// @notice 系统数据推送事件
    event SystemDataPushed(address indexed pusher, string dataType, uint256 timestamp); // DEPRECATED – use IDataPush.DataPushed

    /*━━━━━━━━━━━━━━━ 错误定义 ━━━━━━━━━━━━━━━*/
    
    error FeeRouterView__UnauthorizedAccess();
    error FeeRouterView__InvalidUser();
    error FeeRouterView__InsufficientPermission();
    error FeeRouterView__OnlyFeeRouter();
    error FeeRouterView__BatchSizeTooLarge();
    error FeeRouterView__ArrayLengthMismatch();
    error FeeRouterView__EmptyArray();

    /*━━━━━━━━━━━━━━━ 修饰符 ━━━━━━━━━━━━━━━*/

    /// @notice Registry 有效性验证修饰符
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    /// @notice 验证用户是否为管理员
    modifier onlyAdmin() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        _;
    }
    
    /// @notice 仅允许 FeeRouter（注册表 KEY_FR）调用
    modifier onlyFeeRouter() {
        if (msg.sender != _getFeeRouter()) revert FeeRouterView__OnlyFeeRouter();
        _;
    }
    
    /// @notice 验证用户权限（用户只能查看自己的数据，管理员可查看所有数据）
    modifier onlyAuthorizedFor(address user) {
        if (msg.sender != user) {
            bool isAdmin = ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
            if (!isAdmin) revert FeeRouterView__UnauthorizedAccess();
        } else {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ 构造和初始化 ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    /// @notice 初始化费用路由视图模块
    /// @param initialRegistryAddr Registry合约地址
    function initialize(address initialRegistryAddr) external initializer {
        // Validate the provided registry address instead of the un-initialised storage slot
        if (initialRegistryAddr == address(0)) revert ZeroAddress();

        _registryAddr = initialRegistryAddr;
        _lastSyncTimestamp = block.timestamp;
        
        __UUPSUpgradeable_init();
    }
    
    /*━━━━━━━━━━━━━━━ 数据同步和推送 ━━━━━━━━━━━━━━━*/
    
    /// @notice FeeRouter 推送用户数据更新
    /// @param user 用户地址
    /// @param feeType 费用类型
    /// @param feeAmount 用户支付的费用金额
    /// @param personalFeeBps 用户个人费率
    function pushUserFeeUpdate(
        address user,
        bytes32 feeType,
        uint256 feeAmount,
        uint256 personalFeeBps
    ) external onlyValidRegistry onlyFeeRouter {
        
        // 更新用户费用数据
        _userFeeStatistics[user][feeType] += feeAmount;
        _userDynamicFees[user][feeType] = personalFeeBps;
        
        // 更新用户统计
        _userStats[user].totalFeePaid += feeAmount;
        _userStats[user].transactionCount += 1;
        _userStats[user].lastActivityTime = block.timestamp;
        
        emit UserDataPushed(user, "FeeUpdate", block.timestamp);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_USER_FEE, abi.encode(user, feeType, feeAmount, personalFeeBps));
    }
    
    /// @notice FeeRouter 推送全局统计更新（仅管理员权限的推送）
    /// @param totalDistributions 总分发次数
    /// @param totalAmountDistributed 总分发金额
    function pushGlobalStatsUpdate(
        uint256 totalDistributions,
        uint256 totalAmountDistributed
    ) external onlyValidRegistry onlyFeeRouter {
        _globalStats.totalDistributions = totalDistributions;
        _globalStats.totalAmountDistributed = totalAmountDistributed;
        _lastSyncTimestamp = block.timestamp;

        emit SystemDataPushed(msg.sender, "GlobalStatsUpdate", block.timestamp);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_GLOBAL_FEE_STATS, abi.encode(totalDistributions, totalAmountDistributed));
    }

    /// @notice FeeRouter 推送系统配置更新
    function pushSystemConfigUpdate(
        address platformTreasury,
        address ecosystemVault,
        uint256 platformFeeBps,
        uint256 ecosystemFeeBps,
        address[] calldata supportedTokens
    ) external onlyValidRegistry onlyFeeRouter {
        address[] memory previousTokens = _systemConfig.supportedTokens;
        for (uint256 i; i < previousTokens.length; ++i) {
            _supportedTokens[previousTokens[i]] = false;
        }

        _systemConfig.platformTreasury = platformTreasury;
        _systemConfig.ecosystemVault = ecosystemVault;
        _systemConfig.platformFeeBps = platformFeeBps;
        _systemConfig.ecosystemFeeBps = ecosystemFeeBps;
        _systemConfig.supportedTokens = supportedTokens;

        for (uint256 i; i < supportedTokens.length; ++i) {
            _supportedTokens[supportedTokens[i]] = true;
        }

        emit DataSynced(msg.sender, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED,
            abi.encode(platformTreasury, ecosystemVault, platformFeeBps, ecosystemFeeBps, supportedTokens)
        );
    }

    /// @notice FeeRouter 推送按资产/费用类型的全局统计
    function pushGlobalFeeStatistic(
        address token,
        bytes32 feeType,
        uint256 amount
    ) external onlyValidRegistry onlyFeeRouter {
        _globalFeeStatistics[token][feeType] = amount;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED,
            abi.encode(token, feeType, amount)
        );
    }
    
    /*━━━━━━━━━━━━━━━ 用户查询函数（权限控制）━━━━━━━━━━━━━━━*/
    
    /// @notice 检查数据是否需要同步
    function needsSync() public view returns (bool) {
        return (block.timestamp - _lastSyncTimestamp) > SYNC_INTERVAL;
    }
    
    /// @notice 获取用户费用统计（用户只能查看自己的）
    /// @param user 用户地址
    /// @param feeType 费用类型
    /// @return 用户支付的费用金额
    function getUserFeeStatistics(address user, bytes32 feeType) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256) {
        return _userFeeStatistics[user][feeType];
    }

    /// @notice 获取用户动态费率（用户只能查看自己的）
    /// @param user 用户地址
    /// @param feeType 费用类型
    /// @return 用户的个人费率
    function getUserDynamicFee(address user, bytes32 feeType) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256) {
        return _userDynamicFees[user][feeType];
    }

    /// @notice 获取用户个人统计（用户只能查看自己的）
    /// @param user 用户地址
    /// @return stats 用户统计数据
    function getUserStats(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (UserStats memory stats) {
        return _userStats[user];
    }

    /// @notice 获取用户费用配置（用户只能查看自己的）
    /// @param user 用户地址
    /// @return config 用户费用配置
    function getUserFeeConfig(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (UserFeeConfig memory config) {
        config.personalFeeBps = _userDynamicFees[user][bytes32(0)]; // 默认费率
        config.totalFeePaid = _userStats[user].totalFeePaid;
        config.transactionCount = _userStats[user].transactionCount;
        // 根据费用支付情况计算VIP状态和折扣级别
        config.vipStatus = _userStats[user].totalFeePaid > 1000 ether;
        config.discountLevel = _calculateDiscountLevel(user);
    }

    /// @notice 检查代币是否支持（公开查询）
    /// @param token 代币地址
    /// @return 是否支持
    function isTokenSupported(address token) external view returns (bool) {
        return _supportedTokens[token];
    }

    /// @notice 获取支持的代币列表（公开查询）
    /// @return 支持的代币地址数组
    function getSupportedTokens() external view returns (address[] memory) {
        return _systemConfig.supportedTokens;
    }

    /*━━━━━━━━━━━━━━━ 管理员查询函数（仅管理员）━━━━━━━━━━━━━━━*/
    
    /// @notice 获取全局费用统计（仅管理员）
    /// @param token 代币地址
    /// @param feeType 费用类型
    /// @return 全局费用统计金额
    function getGlobalFeeStatistics(address token, bytes32 feeType) 
        external view onlyValidRegistry onlyAdmin returns (uint256) {
        return _globalFeeStatistics[token][feeType];
    }

    /// @notice 获取全局操作统计（仅管理员）
    /// @return distributions 总分发次数
    /// @return totalAmount 总分发金额
    function getGlobalOperationStats() 
        external view onlyValidRegistry onlyAdmin returns (uint256 distributions, uint256 totalAmount) {
        return (_globalStats.totalDistributions, _globalStats.totalAmountDistributed);
    }

    /// @notice 获取系统配置（仅管理员）
    /// @return config 系统配置
    function getSystemConfig() 
        external view onlyValidRegistry onlyAdmin returns (SystemConfig memory config) {
        return _systemConfig;
    }

    /// @notice 获取系统费用分析（仅管理员）
    /// @return analytics 系统费用分析数据
    function getSystemFeeAnalytics() 
        external view onlyValidRegistry onlyAdmin returns (SystemFeeAnalytics memory analytics) {
        analytics.distributionCount = _globalStats.totalDistributions;
        analytics.totalVolume = _globalStats.totalAmountDistributed;
        
        uint256 platformFeeBps = _systemConfig.platformFeeBps;
        uint256 ecosystemFeeBps = _systemConfig.ecosystemFeeBps;
        
        analytics.totalFees = (analytics.totalVolume * (platformFeeBps + ecosystemFeeBps)) / 10000;
        analytics.platformRevenue = (analytics.totalVolume * platformFeeBps) / 10000;
        analytics.ecosystemRevenue = (analytics.totalVolume * ecosystemFeeBps) / 10000;
        analytics.averageFeeRate = platformFeeBps + ecosystemFeeBps;
    }

    /*━━━━━━━━━━━━━━━ 批量查询功能 ━━━━━━━━━━━━━━━*/
    
    /// @notice 批量获取用户费用统计（用户只能查询自己的）
    /// @param user 用户地址
    /// @param feeTypes 费用类型数组
    /// @return feeStatistics 费用统计数组
    function batchGetUserFeeStatistics(
        address user,
        bytes32[] calldata feeTypes
    ) external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256[] memory feeStatistics) {
        if (feeTypes.length > MAX_BATCH_SIZE) revert FeeRouterView__BatchSizeTooLarge();
        
        feeStatistics = new uint256[](feeTypes.length);
        for (uint256 i = 0; i < feeTypes.length; i++) {
            feeStatistics[i] = _userFeeStatistics[user][feeTypes[i]];
        }
    }

    /// @notice 批量获取全局费用统计（仅管理员）
    /// @param tokens 代币地址数组
    /// @param feeTypes 费用类型数组
    /// @return feeStatistics 费用统计数组
    function batchGetGlobalFeeStatistics(
        address[] calldata tokens, 
        bytes32[] calldata feeTypes
    ) external view onlyValidRegistry onlyAdmin returns (uint256[] memory feeStatistics) {
        if (tokens.length != feeTypes.length) revert FeeRouterView__ArrayLengthMismatch();
        if (tokens.length > MAX_BATCH_SIZE) revert FeeRouterView__BatchSizeTooLarge();
        
        feeStatistics = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            feeStatistics[i] = _globalFeeStatistics[tokens[i]][feeTypes[i]];
        }
    }

    /// @notice 批量检查代币支持状态（公开查询）
    /// @param tokens 代币地址数组
    /// @return supported 支持状态数组
    function batchCheckTokenSupport(address[] calldata tokens) 
        external view returns (bool[] memory supported) {
        if (tokens.length == 0) revert FeeRouterView__EmptyArray();
        if (tokens.length > MAX_BATCH_SIZE) revert FeeRouterView__BatchSizeTooLarge();
        
        supported = new bool[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            supported[i] = _supportedTokens[tokens[i]];
        }
    }
    
    /*━━━━━━━━━━━━━━━ 高级分析功能 ━━━━━━━━━━━━━━━*/
    
    /// @notice 获取用户费用分析（用户只能查看自己的）
    /// @param user 用户地址
    /// @param feeTypes 要分析的费用类型数组
    /// @return analytics 用户费用分析数据
    function getUserFeeAnalytics(address user, bytes32[] calldata feeTypes) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (UserFeeAnalytics memory analytics) {
        if (feeTypes.length > MAX_BATCH_SIZE) revert FeeRouterView__BatchSizeTooLarge();
        
        UserStats memory userStats = _userStats[user];
        
        analytics.totalPaidFees = userStats.totalFeePaid;
        analytics.transactionCount = userStats.transactionCount;
        analytics.lastTransactionTime = userStats.lastActivityTime;
        analytics.feeTypes = feeTypes;
        analytics.feeAmounts = new uint256[](feeTypes.length);
        
        uint256 totalFees = 0;
        for (uint256 i = 0; i < feeTypes.length; i++) {
            uint256 feeAmount = _userFeeStatistics[user][feeTypes[i]];
            analytics.feeAmounts[i] = feeAmount;
            totalFees += feeAmount;
        }
        
        // 计算平均费率
        if (analytics.transactionCount > 0) {
            analytics.averageFeeRate = (totalFees * 10000) / analytics.transactionCount;
        }
    }

    /*━━━━━━━━━━━━━━━ 内部辅助函数 ━━━━━━━━━━━━━━━*/
    
    /// @notice 计算用户折扣级别
    /// @param user 用户地址
    /// @return 折扣级别
    function _calculateDiscountLevel(address user) internal view returns (uint256) {
        UserStats memory userStats = _userStats[user];
        
        if (userStats.totalFeePaid >= 10000 ether) return 5; // 最高级别
        if (userStats.totalFeePaid >= 5000 ether) return 4;
        if (userStats.totalFeePaid >= 1000 ether) return 3;
        if (userStats.totalFeePaid >= 500 ether) return 2;
        if (userStats.totalFeePaid >= 100 ether) return 1;
        return 0; // 无折扣
    }
    
    /*━━━━━━━━━━━━━━━ Registry 管理功能 ━━━━━━━━━━━━━━━*/
    
    /// @notice 获取Registry地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 获取FeeRouter模块地址
    function getFeeRouter() external view returns (address) {
        return _getFeeRouter();
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}

    /*━━━━━━━━━━━━━━━ 合约升级 ━━━━━━━━━━━━━━━*/
    
    /// @notice 授权合约升级
    /// @param newImplementation 新实现地址
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    function _getFeeRouter() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FR);
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ 存储槽预留 ━━━━━━━━━━━━━━━*/
    
    /// @notice 为未来升级预留的存储槽
    uint256[35] private __gap;
}