// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { RewardTypes } from "./RewardTypes.sol";
import { IServiceConfig } from "./interfaces/IServiceConfig.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";

/// @title BaseServiceConfig - 服务配置基础抽象合约
/// @notice 提供服务配置模块的基础功能和通用逻辑
/// @dev 所有服务配置子模块都应继承此合约
abstract contract BaseServiceConfig is 
    Initializable, 
    UUPSUpgradeable,
    IServiceConfig,
    RewardTypes,
    RewardModuleBase,
    IRegistryUpgradeEvents
{
    
    /// @notice Registry 合约地址（内部存储，供子模块使用）
    address internal registryAddr;

    // ============ 缓存优化 ============
    /// @notice 缓存的AccessControlManager地址
    address private cachedAcmAddr;
    /// @notice 缓存时间戳
    uint256 private cacheTimestamp;
    /// @notice 缓存有效期（5分钟）
    uint256 private constant CACHE_DURATION = 300;

    /* ============ Modifiers ============ */
    // onlyValidRegistry 由基类提供
    
    /// @notice 服务配置映射
    mapping(ServiceLevel => ServiceConfig) internal configs;
    
    /// @notice 服务冷却期 (秒)
    uint256 internal cooldown;

    event ConfigUpdated(uint8 level, uint256 price, uint256 duration, bool isActive);
    event CooldownUpdated(uint256 cooldown);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external virtual initializer {
        _initialize(initialRegistryAddr);
    }
    
    /// @dev 内部初始化函数
    /// @param initialRegistryAddr Registry 合约地址
    function _initialize(address initialRegistryAddr) internal virtual {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        registryAddr = initialRegistryAddr;
        
        _initializeConfigs();
        _initializeCooldown();
    }

    // ========== 接口实现 ==========

    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view virtual returns (address) {
        return registryAddr;
    }

    /// @inheritdoc IServiceConfig
    function getConfig(ServiceLevel level) external view override onlyValidRegistry returns (ServiceConfig memory config) {
        return configs[level];
    }

    /// @inheritdoc IServiceConfig
    function updateConfig(
        ServiceLevel level,
        uint256 price,
        uint256 duration,
        bool isActive
    ) external virtual override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        configs[level] = ServiceConfig({
            price: price,
            duration: duration,
            isActive: isActive,
            level: level,
            description: configs[level].description
        });
        
        emit ConfigUpdated(uint8(level), price, duration, isActive);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @inheritdoc IServiceConfig
    function getCooldown() external view override onlyValidRegistry returns (uint256) {
        return cooldown;
    }

    /// @dev 内部权限验证函数（优化版本，使用缓存）已由基类 _requireRole 提供

    /// @dev 批量权限验证函数（优化版本，减少重复调用）
    /// @param actionKey 权限键
    /// @param user 用户地址
    /// @dev 在同一个交易中多次调用时，使用此函数可以节省Gas
    function _requireRoleOnce(bytes32 actionKey, address user) internal view {
        // 如果缓存有效，直接使用缓存
        if (cachedAcmAddr != address(0) && 
            block.timestamp - cacheTimestamp < CACHE_DURATION) {
            IAccessControlManager(cachedAcmAddr).requireRole(actionKey, user);
            return;
        }
        
        // 缓存无效，获取并缓存
        address acmAddr = IRegistry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        // 注意：在view函数中不能修改状态，所以这里只是获取地址
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @dev 获取缓存的AccessControlManager地址
    /// @return AccessControlManager地址
    function _getCachedAcmAddr() internal view returns (address) {
        // 检查缓存是否有效
        if (cachedAcmAddr != address(0) && 
            block.timestamp - cacheTimestamp < CACHE_DURATION) {
            return cachedAcmAddr;
        }
        
        // 缓存无效，从Registry获取
        return IRegistry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    /// @dev 更新AccessControlManager缓存
    /// @param newAcmAddr 新的AccessControlManager地址
    function _updateAcmCache(address newAcmAddr) internal {
        cachedAcmAddr = newAcmAddr;
        cacheTimestamp = block.timestamp;
    }

    /// @inheritdoc IServiceConfig
    function setCooldown(uint256 newCooldown) external virtual override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        cooldown = newCooldown;
        emit CooldownUpdated(newCooldown);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 抽象函数 ==========

    /// @dev 初始化服务配置 - 子合约必须实现
    function _initializeConfigs() internal virtual;
    
    /// @dev 初始化冷却期 - 子合约必须实现
    function _initializeCooldown() internal virtual;

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 记录升级动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    // ============ 基类抽象实现 ============
    function _getRegistryAddr() internal view override returns (address) {
        return registryAddr;
    }

    /// @notice 更新Registry地址
    /// @param newRegistryAddr 新的Registry地址
    /// @dev Registry地址不能为零地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = registryAddr;
        registryAddr = newRegistryAddr;
        
        // 清除缓存，因为Registry地址变更了
        cachedAcmAddr = address(0);
        cacheTimestamp = 0;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
        
        // 发出模块地址更新事件
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );
    }
} 