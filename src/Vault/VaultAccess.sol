// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { VaultTypes } from "./VaultTypes.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IKeeperRegistry } from "../interfaces/IKeeperRegistry.sol";
import { IWhitelistRegistry } from "../interfaces/IWhitelistRegistry.sol";
import { Registry } from "../registry/Registry.sol";
import { RegistryDynamicModuleKey } from "../registry/RegistryDynamicModuleKey.sol";
import {
    NotGovernance,
    NotKeeper,
    NotWhitelisted,
    ZeroAddress,
    InvalidCaller,
    ExternalModuleRevertedRaw,
    ModuleNotRegistered
} from "../errors/StandardErrors.sol";

/// @title AccessControlled
/// @notice 提供统一的角色权限修饰符，继承 GovernanceRole 确保权限一致性
/// @dev 所有权限修饰符都包含事件记录，便于审计和监控。
/// @dev 这是一个抽象合约，供其他模块继承使用
/// @dev 使用 Registry 进行模块化管理，支持动态模块升级
/// @dev 使用 ActionKeys 和 ModuleKeys 进行标准化管理
/// @dev 与 VaultTypes 集成，提供标准化的事件记录
/// @dev 支持动态模块键管理和升级管理功能
/// @custom:security-contact security@example.com
abstract contract AccessControlled {
    /* ---------- Events ---------- */
    event AccessDenied(address indexed caller, string requiredRole, uint256 timestamp);
    event AccessControlUpdated(string indexed role, address indexed account, address indexed sender);
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event DynamicModuleKeyValidated(bytes32 indexed moduleKey, string moduleName, bool isValid);
    event ModuleKeyUpgradeChecked(bytes32 indexed moduleKey, address indexed oldAddress, address indexed newAddress);

    /* ---------- Storage ---------- */
    /// @notice Registry 合约地址（内部变量）
    address internal _registryAddr;
    
    /// @notice Registry contract address (compat getter via `registryAddrVar()`).
    /// @dev Stored privately; exposed via explicit getter (no public state variable).
    address private _registryAddrVar;

    /// @notice Get Registry address.
    function registryAddrVar() external view returns (address) {
        return _registryAddrVar;
    }
    
    /// @notice 动态模块键管理器地址
    address public dynamicModuleKeyManager;
    
    /// @notice 存储版本，用于兼容性检查
    uint256 private constant STORAGE_VERSION = 1;

    /* ---------- Modifiers ---------- */

    modifier onlyVault() {
        if (msg.sender != address(this)) {
            emit AccessDenied(msg.sender, "VAULT", block.timestamp);
            revert InvalidCaller();
        }
        _;
    }

    modifier onlyKeeper() {
        if (_registryAddr == address(0)) {
            emit AccessDenied(msg.sender, "KEEPER", block.timestamp);
            revert ZeroAddress();
        }
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_KEEPER_REGISTRY) returns (address keeperRegistry) {
            if (keeperRegistry == address(0)) {
                emit AccessDenied(msg.sender, "KEEPER", block.timestamp);
                revert ZeroAddress();
            }
            
            if (!IKeeperRegistry(keeperRegistry).isKeeper(msg.sender)) {
                emit AccessDenied(msg.sender, "KEEPER", block.timestamp);
                revert NotKeeper();
            }
        } catch (bytes memory lowLevelData) {
            emit AccessDenied(msg.sender, "KEEPER", block.timestamp);
            revert ExternalModuleRevertedRaw("KeeperRegistry", lowLevelData);
        }
        _;
    }

    modifier onlyWhitelisted() {
        if (_registryAddr == address(0)) {
            emit AccessDenied(msg.sender, "WHITELISTED", block.timestamp);
            revert ZeroAddress();
        }
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_WHITELIST_REGISTRY) returns (address whitelistRegistry) {
            if (whitelistRegistry == address(0)) {
                emit AccessDenied(msg.sender, "WHITELISTED", block.timestamp);
                revert ZeroAddress();
            }
            
            if (!IWhitelistRegistry(whitelistRegistry).isWhitelisted(msg.sender)) {
                emit AccessDenied(msg.sender, "WHITELISTED", block.timestamp);
                revert NotWhitelisted();
            }
        } catch (bytes memory lowLevelData) {
            emit AccessDenied(msg.sender, "WHITELISTED", block.timestamp);
            revert ExternalModuleRevertedRaw("WhitelistRegistry", lowLevelData);
        }
        _;
    }

    modifier onlyValidAddress(address addr) {
        if (addr == address(0)) {
            emit AccessDenied(msg.sender, "VALID_ADDRESS", block.timestamp);
            revert ZeroAddress();
        }
        _;
    }

    /// @notice 角色验证修饰符
    /// @param role 角色键
    modifier onlyRole(bytes32 role) virtual {
        _requireRole(role, msg.sender);
        _;
    }

    /* ---------- Internal Functions ---------- */
    /// @notice 权限验证内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view virtual {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    /// @notice 角色检查内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    /// @return 是否具有角色
    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(actionKey, user);
    }

    /// @notice 验证模块键是否有效（包括静态和动态模块键）
    /// @param moduleKey 模块键
    /// @return 是否有效
    function _isValidModuleKey(bytes32 moduleKey) internal view returns (bool) {
        // 首先检查静态模块键
        if (ModuleKeys.isValidModuleKey(moduleKey)) {
            return true;
        }
        
        // 然后检查动态模块键
        if (dynamicModuleKeyManager != address(0)) {
            try RegistryDynamicModuleKey(dynamicModuleKeyManager).isValidModuleKey(moduleKey) returns (bool isValid) {
                return isValid;
            } catch {
                // 如果动态模块键管理器调用失败，返回 false
                return false;
            }
        }
        
        return false;
    }

    /// @notice 获取模块地址，支持动态模块键验证
    /// @param moduleKey 模块键
    /// @return 模块地址
    function _getModuleAddress(bytes32 moduleKey) internal view returns (address) {
        if (!_isValidModuleKey(moduleKey)) {
            revert ModuleNotRegistered(moduleKey);
        }
        
        try IRegistry(_registryAddr).getModuleOrRevert(moduleKey) returns (address moduleAddr) {
            return moduleAddr;
        } catch (bytes memory lowLevelData) {
            revert ExternalModuleRevertedRaw("ModuleRegistry", lowLevelData);
        }
    }

    /// @notice 检查模块升级状态
    /// @param moduleKey 模块键
    /// @return hasPendingUpgrade 是否有待升级
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    function _checkModuleUpgradeStatus(bytes32 moduleKey) internal view returns (
        bool hasPendingUpgrade,
        address newAddress,
        uint256 executeAfter
    ) {
        address currentAddress = address(0);
        try IRegistry(_registryAddr).getModule(moduleKey) returns (address addr) {
            currentAddress = addr;
        } catch {
            // 忽略错误，保持 currentAddress 为 address(0)
        }
        
        try IRegistry(_registryAddr).getPendingUpgrade(moduleKey) returns (
            address pendingNewAddr,
            uint256 pendingExecuteAfter,
            bool pending
        ) {
            hasPendingUpgrade = pending;
            newAddress = pendingNewAddr;
            executeAfter = pendingExecuteAfter;
        } catch {
            hasPendingUpgrade = false;
            newAddress = address(0);
            executeAfter = 0;
        }
    }

    /* ---------- Admin Functions ---------- */
    /// @notice 设置Registry地址
    /// @param _registry Registry合约地址
    /// @dev 使用 ActionKeys.ACTION_SET_PARAMETER 进行标准化事件记录
    /// @dev 与 VaultTypes.ActionExecuted 事件集成，提供统一的操作记录
    function setRegistry(address _registry) external virtual onlyValidAddress(_registry) {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address oldRegistry = _registryAddr;
        _registryAddr = _registry;
        _registryAddrVar = _registry;
        emit RegistryUpdated(oldRegistry, _registry);
        emit AccessControlUpdated("REGISTRY", _registry, msg.sender);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置动态模块键管理器地址
    /// @param _dynamicModuleKeyManager 动态模块键管理器地址
    function setDynamicModuleKeyManager(address _dynamicModuleKeyManager) external virtual onlyValidAddress(_dynamicModuleKeyManager) {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address oldManager = dynamicModuleKeyManager;
        dynamicModuleKeyManager = _dynamicModuleKeyManager;
        emit AccessControlUpdated("DYNAMIC_MODULE_KEY_MANAGER", _dynamicModuleKeyManager, msg.sender);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
        
        // 记录管理器地址变更事件
        emit RegistryUpdated(oldManager, _dynamicModuleKeyManager);
    }

    /// @notice 获取 Registry 地址
    /// @return Registry 合约地址
    function getRegistry() external view virtual returns (address) {
        return _registryAddr;
    }

    /// @notice 获取 Registry 地址（getter 函数）
    /// @return Registry 合约地址
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 获取动态模块键管理器地址
    /// @return 动态模块键管理器地址
    function getDynamicModuleKeyManager() external view returns (address) {
        return dynamicModuleKeyManager;
    }

    /* ---------- View Functions ---------- */
    /// @notice 检查地址是否为Keeper
    /// @param account 待检查的地址
    /// @return 是否为Keeper
    /// @dev 使用 ModuleKeys.KEY_KEEPER_REGISTRY 进行模块引用
    function isKeeper(address account) external view returns (bool) {
        if (_registryAddr == address(0)) return false;
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_KEEPER_REGISTRY) returns (address keeperRegistry) {
            if (keeperRegistry == address(0)) return false;
            return IKeeperRegistry(keeperRegistry).isKeeper(account);
        } catch {
            return false;
        }
    }

    /// @notice 检查地址是否在白名单中
    /// @param account 待检查的地址
    /// @return 是否在白名单中
    /// @dev 使用 ModuleKeys.KEY_WHITELIST_REGISTRY 进行模块引用
    function isWhitelisted(address account) external view returns (bool) {
        if (_registryAddr == address(0)) return false;
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_WHITELIST_REGISTRY) returns (address whitelistRegistry) {
            if (whitelistRegistry == address(0)) return false;
            return IWhitelistRegistry(whitelistRegistry).isWhitelisted(account);
        } catch {
            return false;
        }
    }

    /// @notice 获取Keeper注册表地址
    /// @return Keeper注册表地址
    /// @dev 使用 ModuleKeys.KEY_KEEPER_REGISTRY 进行模块引用
    function getKeeperRegistry() external view returns (address) {
        if (_registryAddr == address(0)) return address(0);
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_KEEPER_REGISTRY) returns (address keeperRegistry) {
            return keeperRegistry;
        } catch {
            return address(0);
        }
    }

    /// @notice 获取白名单注册表地址
    /// @return 白名单注册表地址
    /// @dev 使用 ModuleKeys.KEY_WHITELIST_REGISTRY 进行模块引用
    function getWhitelistRegistry() external view returns (address) {
        if (_registryAddr == address(0)) return address(0);
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_WHITELIST_REGISTRY) returns (address whitelistRegistry) {
            return whitelistRegistry;
        } catch {
            return address(0);
        }
    }

    /// @notice 检查模块键是否有效（包括静态和动态模块键）
    /// @param moduleKey 模块键
    /// @return 是否有效
    function isValidModuleKey(bytes32 moduleKey) external view returns (bool) {
        return _isValidModuleKey(moduleKey);
    }

    /// @notice 检查模块键是否有效并记录事件
    /// @param moduleKey 模块键
    /// @return 是否有效
    function isValidModuleKeyWithEvent(bytes32 moduleKey) external returns (bool) {
        bool isValid = _isValidModuleKey(moduleKey);
        
        if (isValid && dynamicModuleKeyManager != address(0)) {
            try RegistryDynamicModuleKey(dynamicModuleKeyManager).isValidModuleKey(moduleKey) returns (bool dynamicValid) {
                if (dynamicValid) {
                    string memory moduleName = RegistryDynamicModuleKey(dynamicModuleKeyManager).getModuleKeyName(moduleKey);
                    emit DynamicModuleKeyValidated(moduleKey, moduleName, true);
                }
            } catch {
                // 忽略错误
            }
        }
        
        return isValid;
    }

    /// @notice 获取模块地址，支持动态模块键验证
    /// @param moduleKey 模块键
    /// @return 模块地址
    function getModuleAddress(bytes32 moduleKey) external view virtual returns (address) {
        return _getModuleAddress(moduleKey);
    }

    /// @notice 检查模块升级状态
    /// @param moduleKey 模块键
    /// @return hasPendingUpgrade 是否有待升级
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    function checkModuleUpgradeStatus(bytes32 moduleKey) external view returns (
        bool hasPendingUpgrade,
        address newAddress,
        uint256 executeAfter
    ) {
        return _checkModuleUpgradeStatus(moduleKey);
    }

    /// @notice 检查模块升级状态并记录事件
    /// @param moduleKey 模块键
    /// @return hasPendingUpgrade 是否有待升级
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    function checkModuleUpgradeStatusWithEvent(bytes32 moduleKey) external returns (
        bool hasPendingUpgrade,
        address newAddress,
        uint256 executeAfter
    ) {
        (hasPendingUpgrade, newAddress, executeAfter) = _checkModuleUpgradeStatus(moduleKey);
        
        if (hasPendingUpgrade) {
            address currentAddress = address(0);
            try IRegistry(_registryAddr).getModule(moduleKey) returns (address addr) {
                currentAddress = addr;
            } catch {
                // 忽略错误，保持 currentAddress 为 address(0)
            }
            
            emit ModuleKeyUpgradeChecked(moduleKey, currentAddress, newAddress);
        }
        
        return (hasPendingUpgrade, newAddress, executeAfter);
    }

    /// @notice 获取模块键名称（支持动态模块键）
    /// @param moduleKey 模块键
    /// @return 模块键名称
    function getModuleKeyName(bytes32 moduleKey) external view returns (string memory) {
        // 首先检查静态模块键
        if (ModuleKeys.isValidModuleKey(moduleKey)) {
            return ModuleKeys.getModuleKeyString(moduleKey);
        }
        
        // 然后检查动态模块键
        if (dynamicModuleKeyManager != address(0)) {
            try RegistryDynamicModuleKey(dynamicModuleKeyManager).getModuleKeyName(moduleKey) returns (string memory name) {
                return name;
            } catch {
                revert ModuleNotRegistered(moduleKey);
            }
        }
        
        revert ModuleNotRegistered(moduleKey);
    }

    /// @notice 获取存储版本
    /// @return 存储版本号
    function getStorageVersion() external pure returns (uint256) {
        return STORAGE_VERSION;
    }
} 