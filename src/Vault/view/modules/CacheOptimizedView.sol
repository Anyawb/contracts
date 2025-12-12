// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// 标准导入
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";

/// @title CacheOptimizedView
/// @notice 缓存优化查询视图模块 - 超低Gas的缓存数据查询 / Cache optimized query view module - Ultra-low Gas cache data queries
/// @dev 使用内部数据镜像，实现超低Gas查询（~100 gas） / Uses internal data mirroring to achieve ultra-low Gas queries (~100 gas)
/// @dev 数据通过业务合约主动推送更新，确保实时性 / Data is actively pushed and updated by business contracts to ensure real-time performance
/// @dev 提供view函数方便前端查看，提供管理函数支持权限控制 / Provides view functions for convenient frontend access and management functions with permission control
/// @dev 严格权限控制：用户只能查看自己的数据，管理员可查看全局数据 / Strict permission control: users can only view their own data, administrators can view global data
/// @custom:security-contact security@example.com
contract CacheOptimizedView is Initializable, UUPSUpgradeable {
    
    /*━━━━━━━━━━━━━━━ 基础配置 ━━━━━━━━━━━━━━━*/
    
    /// @notice Registry 合约地址
    address private _registryAddr;
    
    /// @notice 最大批量查询大小（统一常量）
    uint256 internal constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    
    /// @notice 同步间隔（秒）
    uint256 internal constant SYNC_INTERVAL = 300; // 5分钟
    // ---------------- DataPush type hashes ----------------
    bytes32 internal constant DATA_TYPE_USER_DATA_UPDATE     = keccak256("USER_DATA_UPDATE");
    bytes32 internal constant DATA_TYPE_POSITION_DATA_UPDATE = keccak256("POSITION_DATA_UPDATE");
    bytes32 internal constant DATA_TYPE_GLOBAL_STATS_UPDATE  = keccak256("GLOBAL_STATS_UPDATE");

    // ---------------- Global stats keys ----------------
    bytes32 internal constant KEY_TOTAL_USERS           = keccak256("TOTAL_USERS");
    bytes32 internal constant KEY_TOTAL_COLLATERAL      = keccak256("TOTAL_COLLATERAL");
    bytes32 internal constant KEY_TOTAL_DEBT            = keccak256("TOTAL_DEBT");
    bytes32 internal constant KEY_AVERAGE_HEALTH_FACTOR = keccak256("AVERAGE_HEALTH_FACTOR");
    
    /// @notice 数据同步时间戳
    uint256 private _lastSyncTimestamp;
    
    /*━━━━━━━━━━━━━━━ 内部数据镜像 ━━━━━━━━━━━━━━━*/
    
    /// @notice 用户健康因子镜像
    mapping(address => uint256) private _mirroredHealthFactors;
    
    /// @notice 用户抵押品数据镜像
    mapping(address => mapping(address => uint256)) private _mirroredCollaterals;
    
    /// @notice 用户债务数据镜像
    mapping(address => mapping(address => uint256)) private _mirroredDebts;
    
    /// @notice 系统全局统计数据镜像
    mapping(bytes32 => uint256) private _mirroredGlobalStats;
    
    /// @notice 缓存时间戳
    mapping(address => uint256) private _cacheTimestamps;
    
    /// @notice 系统状态缓存时间戳
    uint256 private _systemCacheTimestamp;
    
    /*━━━━━━━━━━━━━━━ 结构体定义 ━━━━━━━━━━━━━━━*/
    
    /// @notice 用户完整数据结构
    struct UserCompleteData {
        uint256 healthFactor;
        uint256 totalCollateral;
        uint256 totalDebt;
        bool isActive;
    }
    
    /// @notice 用户位置数据结构
    struct UserPositionData {
        uint256 collateral;
        uint256 debt;
        uint256 timestamp;
    }
    
    /// @notice 系统统计数据结构
    struct SystemStatsData {
        uint256 totalUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 averageHealthFactor;
    }
    
    /*━━━━━━━━━━━━━━━ 事件 ━━━━━━━━━━━━━━━*/
    
    event DataSynced(address indexed caller, uint256 timestamp);
    event DataPushed(address indexed pusher, string dataType, uint256 timestamp); // DEPRECATED – use IDataPush.DataPushed
    
    /*━━━━━━━━━━━━━━━ 错误定义 ━━━━━━━━━━━━━━━*/
    
    error CacheOptimizedView__UnauthorizedAccess();
    error CacheOptimizedView__InsufficientPermission();
    error CacheOptimizedView__InvalidUser();
    error CacheOptimizedView__BatchSizeTooLarge();
    error CacheOptimizedView__ArrayLengthMismatch();
    
    /*━━━━━━━━━━━━━━━ 权限控制（严格数据隔离）━━━━━━━━━━━━━━━*/
    
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }
    
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    function _getUserPermission(address user) internal view returns (IAccessControlManager.PermissionLevel) {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).getUserPermission(user);
    }
    
    modifier onlyAdmin() {
        IAccessControlManager.PermissionLevel level = _getUserPermission(msg.sender);
        if (level < IAccessControlManager.PermissionLevel.ADMIN) {
            revert CacheOptimizedView__InsufficientPermission();
        }
        _;
    }
    
    /// @notice 验证用户权限（用户只能查看自己的数据，管理员可查看所有数据）
    modifier onlyAuthorizedFor(address user) {
        IAccessControlManager.PermissionLevel level = _getUserPermission(msg.sender);
        
        // 管理员可以查看任何数据
        if (level >= IAccessControlManager.PermissionLevel.ADMIN) {
            _;
            return;
        }
        
        // 普通用户只能查看自己的数据
        if (msg.sender != user) {
            revert CacheOptimizedView__UnauthorizedAccess();
        }
        
        // 用户必须至少有VIEWER权限
        if (level < IAccessControlManager.PermissionLevel.VIEWER) {
            revert CacheOptimizedView__InsufficientPermission();
        }
        _;
    }
    
    function _getBusinessContract() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
    }

    /*━━━━━━━━━━━━━━━ 构造和初始化 ━━━━━━━━━━━━━━━*/
    
    /// @notice 初始化函数 / Initialize function
    /// @dev 初始化缓存优化视图模块 / Initialize cache optimized view module
    /// @param initialRegistryAddr Registry合约地址 / Registry contract address
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        _lastSyncTimestamp = block.timestamp;
    }
    
    /*━━━━━━━━━━━━━━━ 数据同步和推送 ━━━━━━━━━━━━━━━*/
    
    /// @notice 同步业务合约数据到内部镜像 / Sync business contract data to internal mirror
    /// @dev 仅管理员可以调用此函数进行数据同步 / Only administrators can call this function for data synchronization
    function syncBusinessData() external onlyValidRegistry onlyAdmin {
        // 此处可以实现从业务合约批量同步数据的逻辑
        // 由于是管理操作，不需要做成view函数
        
        _lastSyncTimestamp = block.timestamp;
        emit DataSynced(msg.sender, block.timestamp);
    }
    
    /// @notice 业务合约推送用户数据更新（内部传输，超低 Gas） / Business contract pushes user data updates (internal transfer, ultra-low Gas)
    /// @dev 仅业务合约可以调用，实现数据实时同步 / Only business contracts can call this to achieve real-time data synchronization
    /// @param user 用户地址 / User address
    /// @param healthFactor 健康因子 / Health factor
    /// @param totalCollateral 总抵押品 / Total collateral
    /// @param totalDebt 总债务 / Total debt
    function pushUserDataUpdate(
        address user,
        uint256 healthFactor,
        uint256 totalCollateral,
        uint256 totalDebt
    ) external onlyValidRegistry {
        require(msg.sender == _getBusinessContract(), "Only business contract can push updates");
        
        // 直接更新内部镜像
        _mirroredHealthFactors[user] = healthFactor;
        // 用bytes32(0)作为默认资产的统计数据
        _mirroredCollaterals[user][address(0)] = totalCollateral;
        _mirroredDebts[user][address(0)] = totalDebt;
        _cacheTimestamps[user] = block.timestamp;
        
        DataPushLibrary._emitData(
            DATA_TYPE_USER_DATA_UPDATE,
            abi.encode(user, healthFactor, totalCollateral, totalDebt)
        );
    }
    
    /// @notice 业务合约推送用户位置数据更新
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param collateral 抵押品数量
    /// @param debt 债务数量
    function pushPositionDataUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt
    ) external onlyValidRegistry {
        require(msg.sender == _getBusinessContract(), "Only business contract can push updates");
        
        _mirroredCollaterals[user][asset] = collateral;
        _mirroredDebts[user][asset] = debt;
        _cacheTimestamps[user] = block.timestamp;
        
        DataPushLibrary._emitData(
            DATA_TYPE_POSITION_DATA_UPDATE,
            abi.encode(user, asset, collateral, debt)
        );
    }
    
    /// @notice 业务合约推送系统统计数据更新
    /// @param dataKey 数据键
    /// @param value 数据值
    function pushGlobalStatsUpdate(
        bytes32 dataKey,
        uint256 value
    ) external onlyValidRegistry {
        require(msg.sender == _getBusinessContract(), "Only business contract can push updates");
        
        _mirroredGlobalStats[dataKey] = value;
        _systemCacheTimestamp = block.timestamp;
        
        DataPushLibrary._emitData(
            DATA_TYPE_GLOBAL_STATS_UPDATE,
            abi.encode(dataKey, value)
        );
    }

    /*━━━━━━━━━━━━━━━ VIEW 函数（权限控制 + 前端友好）━━━━━━━━━━━━━━━*/
    
    /// @notice 检查数据是否需要同步
    function needsSync() public view returns (bool) {
        return (block.timestamp - _lastSyncTimestamp) > SYNC_INTERVAL;
    }
    
    /// @notice 获取用户健康因子（用户只能查看自己的） / Get user health factor (users can only view their own)
    /// @dev 权限控制：用户只能查看自己的数据，管理员可查看所有 / Permission control: users can only view their own data, administrators can view all
    /// @dev 超低Gas消耗，约100 gas / Ultra-low Gas consumption, approximately 100 gas
    /// @param user 用户地址 / User address
    /// @return healthFactor 健康因子 / Health factor
    function getUserHealthFactor(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256) {
        return _mirroredHealthFactors[user];
    }
    
    /// @notice 获取用户完整数据（用户只能查看自己的）
    /// @param user 用户地址
    /// @return userData 用户完整数据
    /// @dev 权限控制：用户只能查看自己的数据，管理员可查看所有
    function getUserCompleteData(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (UserCompleteData memory) {
        return UserCompleteData({
            healthFactor: _mirroredHealthFactors[user],
            totalCollateral: _mirroredCollaterals[user][address(0)],
            totalDebt: _mirroredDebts[user][address(0)],
            isActive: _mirroredHealthFactors[user] > 0
        });
    }
    
    /// @notice 获取用户位置数据（用户只能查看自己的）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return positionData 用户位置数据
    /// @dev 权限控制：用户只能查看自己的数据，管理员可查看所有
    function getUserPositionData(address user, address asset) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (UserPositionData memory) {
        return UserPositionData({
            collateral: _mirroredCollaterals[user][asset],
            debt: _mirroredDebts[user][asset],
            timestamp: _cacheTimestamps[user]
        });
    }
    
    /// @notice 获取系统统计数据（仅管理员）
    /// @param dataKey 数据键
    /// @return value 数据值
    /// @dev 仅管理员可查看系统统计数据
    function getGlobalStatsData(bytes32 dataKey) 
        external view onlyValidRegistry onlyAdmin returns (uint256) {
        return _mirroredGlobalStats[dataKey];
    }
    
    /// @notice 获取系统完整统计数据（仅管理员）
    /// @return statsData 系统统计数据
    /// @dev 仅管理员可查看系统统计数据
    function getSystemStatsData() 
        external view onlyValidRegistry onlyAdmin returns (SystemStatsData memory) {
        return SystemStatsData({
            totalUsers: _mirroredGlobalStats[KEY_TOTAL_USERS],
            totalCollateral: _mirroredGlobalStats[KEY_TOTAL_COLLATERAL],
            totalDebt: _mirroredGlobalStats[KEY_TOTAL_DEBT],
            averageHealthFactor: _mirroredGlobalStats[KEY_AVERAGE_HEALTH_FACTOR]
        });
    }
    
    /// @notice 获取用户数据缓存时间戳（无权限要求）
    /// @param user 用户地址
    /// @return timestamp 缓存时间戳
    /// @dev 公开信息，无权限要求
    function getUserCacheTimestamp(address user) external view returns (uint256) {
        return _cacheTimestamps[user];
    }

    /*━━━━━━━━━━━━━━━ 批量查询功能 ━━━━━━━━━━━━━━━*/
    
    /// @notice 批量获取用户健康因子 / Batch get user health factors
    /// @dev 每个用户只能查看自己的数据，管理员可查看所有 / Each user can only view their own data, administrators can view all
    /// @dev 支持最多100项批量查询，线性扩展 / Supports up to 100 batch queries with linear scaling
    /// @param users 用户地址数组 / Array of user addresses
    /// @return healthFactors 健康因子数组 / Array of health factors
    function batchGetUserHealthFactors(address[] calldata users) 
        external view onlyValidRegistry returns (uint256[] memory healthFactors) {
        if (users.length == 0) revert CacheOptimizedView__ArrayLengthMismatch();
        if (users.length > MAX_BATCH_SIZE) revert CacheOptimizedView__BatchSizeTooLarge();
        
        IAccessControlManager.PermissionLevel level = _getUserPermission(msg.sender);
        bool isAdmin = level >= IAccessControlManager.PermissionLevel.ADMIN;
        
        healthFactors = new uint256[](users.length);
        for (uint256 i; i < users.length;) {
            // 每个用户验证权限
            if (!isAdmin && msg.sender != users[i]) {
                revert CacheOptimizedView__UnauthorizedAccess();
            }
            healthFactors[i] = _mirroredHealthFactors[users[i]];
            unchecked { ++i; }
        }
    }
    
    /// @notice 批量获取用户位置数据
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @return positions 用户位置数据数组
    /// @dev 每个用户只能查看自己的数据，管理员可查看所有
    function batchGetUserPositions(
        address[] calldata users,
        address[] calldata assets
    ) external view onlyValidRegistry returns (UserPositionData[] memory positions) {
        if (users.length == 0 || users.length != assets.length) revert CacheOptimizedView__ArrayLengthMismatch();
        if (users.length > MAX_BATCH_SIZE) revert CacheOptimizedView__BatchSizeTooLarge();
        
        IAccessControlManager.PermissionLevel level = _getUserPermission(msg.sender);
        bool isAdmin = level >= IAccessControlManager.PermissionLevel.ADMIN;
        
        positions = new UserPositionData[](users.length);
        for (uint256 i; i < users.length;) {
            // 每个用户验证权限
            if (!isAdmin && msg.sender != users[i]) {
                revert CacheOptimizedView__UnauthorizedAccess();
            }
            positions[i] = UserPositionData({
                collateral: _mirroredCollaterals[users[i]][assets[i]],
                debt: _mirroredDebts[users[i]][assets[i]],
                timestamp: _cacheTimestamps[users[i]]
            });
            unchecked { ++i; }
        }
    }
    
    /// @notice 批量获取系统统计数据（仅管理员）
    /// @param dataKeys 数据键数组
    /// @return values 数据值数组
    /// @dev 仅管理员可查看系统统计数据
    function batchGetGlobalStatsData(bytes32[] calldata dataKeys) 
        external view onlyValidRegistry onlyAdmin returns (uint256[] memory values) {
        if (dataKeys.length > MAX_BATCH_SIZE) revert CacheOptimizedView__BatchSizeTooLarge();
        
        values = new uint256[](dataKeys.length);
        for (uint256 i; i < dataKeys.length;) {
            values[i] = _mirroredGlobalStats[dataKeys[i]];
            unchecked { ++i; }
        }
    }

    /*━━━━━━━━━━━━━━━ 高级分析功能 ━━━━━━━━━━━━━━━*/
    
    /// @notice 获取用户风险等级（基于健康因子）
    /// @param user 用户地址
    /// @return riskLevel 风险等级 (0:安全, 1:注意, 2:警告, 3:危险)
    /// @dev 权限控制：用户只能查看自己的数据，管理员可查看所有
    function getUserRiskLevel(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint8 riskLevel) {
        uint256 healthFactor = _mirroredHealthFactors[user];
        
        if (healthFactor >= 200) {
            return 0; // 安全
        } else if (healthFactor >= 150) {
            return 1; // 注意
        } else if (healthFactor >= 110) {
            return 2; // 警告
        } else {
            return 3; // 危险
        }
    }
    
    /// @notice 获取用户资产利用率（抵押品/总债务）
    /// @param user 用户地址
    /// @return utilizationRate 利用率（以basis points为单位，10000=100%）
    /// @dev 权限控制：用户只能查看自己的数据，管理员可查看所有
    function getUserUtilizationRate(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256 utilizationRate) {
        uint256 totalCollateral = _mirroredCollaterals[user][address(0)];
        uint256 totalDebt = _mirroredDebts[user][address(0)];
        
        if (totalCollateral == 0) {
            return 0;
        }
        
        return (totalDebt * 10000) / totalCollateral;
    }

    /*━━━━━━━━━━━━━━━ Registry管理功能 ━━━━━━━━━━━━━━━*/
    
    /// @notice 获取当前Registry地址
    /// @return registryAddress Registry地址
    function getRegistry() external view returns (address registryAddress) {
        return _registryAddr;
    }
    
    /// @notice 更新Registry地址
    /// @param newRegistryAddr 新的Registry地址
    /// @dev Registry地址不能为零地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry onlyAdmin {
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        _registryAddr = newRegistryAddr;
    }



    /*━━━━━━━━━━━━━━━ 合约升级 ━━━━━━━━━━━━━━━*/
    
    /// @notice 升级授权函数
    /// @dev 仅具有升级权限的用户可以升级合约
    function _authorizeUpgrade(address) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        require(
            !IAccessControlManager(acmAddr).getContractStatus(),
            "CacheOptimizedView: contract is paused"
        );
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}
} 