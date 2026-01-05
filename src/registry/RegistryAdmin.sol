// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { 
    ZeroAddress, 
    InvalidCaller
} from "../errors/StandardErrors.sol";
import { RegistryStorage } from "./RegistryStorageLibrary.sol";
import { RegistryEvents } from "./RegistryEventsLibrary.sol";

/// @title RegistryAdmin
/// @notice Registry 管理功能
/// @dev 专门处理管理相关的功能，如延时设置、暂停/恢复、所有权转移等
contract RegistryAdmin is 
    Initializable, 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using RegistryStorage for RegistryStorage.Layout;

    // ============ Constants ============
    uint256 private constant MAX_DELAY = 7 days;

    // （方案A）权限与升级管理员状态统一由 Registry 维护；本模块不再持有副本

    // ============ Constructor ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /// @notice 初始化合约
    function initialize() external initializer {
        __Ownable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
    }

    // ============ Admin Functions ============
    // （方案A）升级/紧急管理员的设置与读取由 Registry 统一管理，这里移除重复入口

    /// @notice 设置主治理地址
    /// @param newAdmin 新的治理地址
    function setAdmin(address newAdmin) external onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newAdmin == address(0)) revert ZeroAddress();
        address oldAdmin = owner();
        _transferOwnership(newAdmin);
        
        // 同步到 storage
        RegistryStorage.layout().admin = newAdmin;
        
        emit RegistryEvents.AdminChanged(oldAdmin, newAdmin);
    }

    /// @notice 设置待接管地址
    /// @param newPendingAdmin 新的待接管地址
    function setPendingAdmin(address newPendingAdmin) external onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        address oldPending = l.pendingAdmin;
        l.pendingAdmin = newPendingAdmin;
        
        emit RegistryEvents.PendingAdminChanged(oldPending, newPendingAdmin);
    }

    /// @notice 接受治理权转移
    function acceptAdmin() external {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        if (msg.sender != l.pendingAdmin) revert("Not pending admin");
        if (l.pendingAdmin == address(0)) revert("Invalid pending admin");
        
        address oldAdmin = owner();
        _transferOwnership(msg.sender);
        
        // 同步到 storage
        l.admin = msg.sender;
        l.pendingAdmin = address(0);
        
        emit RegistryEvents.AdminChanged(oldAdmin, msg.sender);
    }

    /// @notice 暂停合约
    function pause() external onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _pause();
        
        // 同步到 storage
        RegistryStorage.layout().paused = 1;
        
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.PAUSE),
            msg.sender
        );
    }

    /// @notice 恢复合约
    function unpause() external onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _unpause();
        
        // 同步到 storage
        RegistryStorage.layout().paused = 0;
        
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.UNPAUSE),
            msg.sender
        );
    }

    // 这个函数已经在上面定义过了，这里移除重复定义

    /// @notice 紧急更新延时窗口（允许减少）
    /// @param newDelay 新延时秒数
    /// @dev 仅在紧急情况下使用，允许减少延时窗口
    function emergencySetMinDelay(uint256 newDelay) external onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        if (newDelay > MAX_DELAY) revert InvalidCaller();
        emit RegistryEvents.MinDelayChanged(l.minDelay, newDelay);
        l.minDelay = uint64(newDelay);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_EMERGENCY_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_EMERGENCY_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // 这些函数已经在上面定义过了，这里移除重复定义

    /// @notice 转移 Registry 所有权
    /// @param newOwner 新 owner 地址
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        super.transferOwnership(newOwner);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 放弃所有权
    /// @dev 紧急情况下放弃所有权限
    function renounceOwnership() public override onlyOwner {
        super.renounceOwnership();
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ============ View Functions ============
    /// @notice 获取当前延时窗口
    function minDelay() external view returns (uint256) {
        return RegistryStorage.layout().minDelay;
    }

    /// @notice 获取最大延时窗口
    function getMaxDelay() external pure returns (uint256) {
        return MAX_DELAY;
    }

    /// @notice 检查是否已暂停
    function isPaused() external view returns (bool) {
        return paused();
    }

    // （方案A）本模块不承载 UUPS 授权逻辑，移除无效 _authorizeUpgrade

    // ============ Upgrade Admin Management ============
    // 这些函数已经在上面定义过了，这里移除重复定义

    // ============ Storage Gap ============
    uint256[50] private __gap;
} 