// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { 
    ZeroAddress, 
    InvalidCaller,
    MismatchedArrayLengths,
    ModuleAlreadyRegistered,
    NotAContract
} from "../errors/StandardErrors.sol";
import { RegistryStorage } from "./RegistryStorageLibrary.sol";
import { RegistryEvents } from "./RegistryEventsLibrary.sol";
import { RegistryHistoryManager } from "./RegistryHistoryManager.sol";

/// @title RegistryBatchManager
/// @notice 批量操作管理模块
/// @dev 负责处理Registry的批量操作功能
contract RegistryBatchManager is 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    // ============ Constants ============
    uint256 private constant MAX_BATCH_SIZE = 50; // 批量操作上限

    // ============ Dependencies ============
    /// @notice 历史记录管理模块
    RegistryHistoryManager public historyManager;

    // ============ Constructor ============
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /// @notice 初始化批量操作管理模块
    /// @param _historyManager 历史记录管理模块地址
    /// @param initialOwner 最终治理 owner（Timelock/Multisig 或 Registry 入口）
    function initialize(address _historyManager, address initialOwner) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        
        historyManager = RegistryHistoryManager(_historyManager);
    }

    /* ============ UUPS ============ */
    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    // ============ 模块设置函数 ============
    /// @notice 设置历史记录管理模块地址
    /// @param _historyManager 历史记录管理模块地址
    function setHistoryManager(address _historyManager) external onlyOwner {
        historyManager = RegistryHistoryManager(_historyManager);
    }

    // ============ 批量操作功能 ============
    /// @notice 批量设置模块地址（返回变更状态）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @return changedCount 实际发生变更的模块数量
    /// @return changedKeys 发生变更的模块键名数组
    function setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses) external onlyOwner whenNotPaused 
        returns (uint256 changedCount, bytes32[] memory changedKeys) {
        return _setModulesWithStatus(keys, addresses, true);
    }

    /// @notice 批量设置模块地址（控制事件触发）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param emitIndividualEvents 是否同时触发单个模块变更事件
    function setModulesWithEvents(bytes32[] calldata keys, address[] calldata addresses, bool emitIndividualEvents) external onlyOwner whenNotPaused {
        _setModulesWithStatus(keys, addresses, true);
        
        if (emitIndividualEvents) {
            // 触发单个事件
            for (uint256 i = 0; i < keys.length; i++) {
                emit RegistryEvents.ModuleChanged(keys[i], address(0), addresses[i]);
            }
        }
    }

    /// @notice 批量设置多个模块地址（一次性操作，无延时）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param allowReplace 是否允许替换现有模块
    function batchSetModules(bytes32[] calldata keys, address[] calldata addresses, bool allowReplace) external onlyOwner whenNotPaused {
        _setModulesWithStatus(keys, addresses, allowReplace);
    }

    // ============ 内部函数 ============
    /// @notice 内部批量设置模块地址函数（原子性操作）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param allowReplace 是否允许替换现有模块
    /// @return changedCount 实际发生变更的模块数量
    /// @return changedKeys 发生变更的模块键名数组
    function _setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses, bool allowReplace) internal 
        returns (uint256 changedCount, bytes32[] memory changedKeys) {
        // 检查存储版本兼容性
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        if (keys.length != addresses.length) revert MismatchedArrayLengths(keys.length, addresses.length);
        
        // 批量操作上限检查
        if (keys.length > MAX_BATCH_SIZE) revert("Batch size too large");
        
        // ✅ 优化：将存储布局引用放在循环外，避免多次 SLOAD
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 准备批量事件和历史记录数据
        bytes32[] memory tempChangedKeys = new bytes32[](keys.length);
        address[] memory oldAddresses = new address[](keys.length);
        address[] memory newAddresses = new address[](keys.length);
        uint256 tempChangedCount = 0;
        
        for (uint256 i = 0; i < keys.length; i++) {
            // 验证地址不为零
            if (addresses[i] == address(0)) revert ZeroAddress();
            
            if (!allowReplace && l.modules[keys[i]] != address(0)) revert ModuleAlreadyRegistered(keys[i]);
            
            address oldAddr = l.modules[keys[i]];
            // 防止重复升级到相同地址
            if (oldAddr == addresses[i]) {
                if (RegistryEvents.EMIT_MODULE_NOOP) {
                    emit RegistryEvents.ModuleNoOp(keys[i], oldAddr, msg.sender);
                }
                continue;
            }
            
            l.modules[keys[i]] = addresses[i];
            
            // 收集变更数据用于批量事件和历史记录
            tempChangedKeys[tempChangedCount] = keys[i];
            oldAddresses[tempChangedCount] = oldAddr;
            newAddresses[tempChangedCount] = addresses[i];
            tempChangedCount++;
        }
        
        // ✅ 优化：批量记录历史（如果有变更）
        if (tempChangedCount > 0 && address(historyManager) != address(0)) {
            historyManager.recordBatchUpgradeHistory(tempChangedKeys, oldAddresses, newAddresses, msg.sender);
            
            // ✅ 优化：批量事件触发，替代多个单独事件
            emit RegistryEvents.BatchModuleChanged(
                tempChangedKeys,
                oldAddresses,
                newAddresses,
                msg.sender
            );
        }
        
        // 返回变更状态
        changedCount = tempChangedCount;
        changedKeys = new bytes32[](tempChangedCount);
        for (uint256 i = 0; i < tempChangedCount; i++) {
            changedKeys[i] = tempChangedKeys[i];
        }
    }

    /// @notice 内部批量设置模块地址函数（非原子性操作，尽可能成功）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param allowReplace 是否允许替换现有模块
    /// @return changedCount 实际发生变更的模块数量
    /// @return changedKeys 发生变更的模块键名数组
    /// @return failedKeys 失败的模块键名数组
    /// @return failureReasons 失败原因数组
    function _setModulesWithStatusNonAtomic(bytes32[] calldata keys, address[] calldata addresses, bool allowReplace) internal 
        returns (
            uint256 changedCount, 
            bytes32[] memory changedKeys,
            bytes32[] memory failedKeys,
            string[] memory failureReasons
        ) {
        // 检查存储版本兼容性
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        if (keys.length != addresses.length) revert MismatchedArrayLengths(keys.length, addresses.length);
        
        // 批量操作上限检查
        if (keys.length > MAX_BATCH_SIZE) revert("Batch size too large");
        
        // ✅ 优化：将存储布局引用放在循环外，避免多次 SLOAD
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 准备批量事件和历史记录数据
        bytes32[] memory tempChangedKeys = new bytes32[](keys.length);
        address[] memory oldAddresses = new address[](keys.length);
        address[] memory newAddresses = new address[](keys.length);
        bytes32[] memory tempFailedKeys = new bytes32[](keys.length);
        string[] memory tempFailureReasons = new string[](keys.length);
        uint256 tempChangedCount = 0;
        uint256 tempFailedCount = 0;
        
        for (uint256 i = 0; i < keys.length; i++) {
            try this._trySetModule(keys[i], addresses[i], allowReplace) {
                // 成功的情况
                address oldAddr = l.modules[keys[i]];
                if (oldAddr == addresses[i]) {
                    if (RegistryEvents.EMIT_MODULE_NOOP) {
                        // 无操作，跳过（可选事件）
                        emit RegistryEvents.ModuleNoOp(keys[i], oldAddr, msg.sender);
                    }
                    continue;
                }
                
                // 收集变更数据
                tempChangedKeys[tempChangedCount] = keys[i];
                oldAddresses[tempChangedCount] = oldAddr;
                newAddresses[tempChangedCount] = addresses[i];
                tempChangedCount++;
                
            } catch Error(string memory reason) {
                // 失败的情况，记录失败信息
                tempFailedKeys[tempFailedCount] = keys[i];
                tempFailureReasons[tempFailedCount] = reason;
                tempFailedCount++;
                
                // 发出失败事件（使用现有事件）
                emit RegistryEvents.ModuleUpgraded(keys[i], address(0), addresses[i], msg.sender);
            } catch {
                // 未知错误
                tempFailedKeys[tempFailedCount] = keys[i];
                tempFailureReasons[tempFailedCount] = "Unknown error";
                tempFailedCount++;
                
                // 发出失败事件（使用现有事件）
                emit RegistryEvents.ModuleUpgraded(keys[i], address(0), addresses[i], msg.sender);
            }
        }
        
        // ✅ 优化：批量记录历史（如果有变更）
        if (tempChangedCount > 0 && address(historyManager) != address(0)) {
            historyManager.recordBatchUpgradeHistory(tempChangedKeys, oldAddresses, newAddresses, msg.sender);
            
            // ✅ 优化：批量事件触发，替代多个单独事件
            emit RegistryEvents.BatchModuleChanged(
                tempChangedKeys,
                oldAddresses,
                newAddresses,
                msg.sender
            );
        }
        
        // 返回变更状态
        changedCount = tempChangedCount;
        changedKeys = new bytes32[](tempChangedCount);
        for (uint256 i = 0; i < tempChangedCount; i++) {
            changedKeys[i] = tempChangedKeys[i];
        }
        
        // 返回失败状态
        failedKeys = new bytes32[](tempFailedCount);
        failureReasons = new string[](tempFailedCount);
        for (uint256 i = 0; i < tempFailedCount; i++) {
            failedKeys[i] = tempFailedKeys[i];
            failureReasons[i] = tempFailureReasons[i];
        }
    }

    /// @notice 尝试设置单个模块（用于 try/catch）
    /// @param key 模块键
    /// @param newAddr 新地址
    /// @param allowReplace 是否允许替换
    function _trySetModule(bytes32 key, address newAddr, bool allowReplace) external {
        // 只能由合约内部调用
        if (msg.sender != address(this)) revert InvalidCaller();
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 验证地址不为零
        if (newAddr == address(0)) revert ZeroAddress();
        
        // 验证是否为合约
        if (newAddr.code.length == 0) revert NotAContract(newAddr);
        
        // 检查是否允许替换
        if (!allowReplace && l.modules[key] != address(0)) revert ModuleAlreadyRegistered(key);
        
        // 执行升级
        address oldAddr = l.modules[key];
        l.modules[key] = newAddr;
        
        // 记录历史
        if (address(historyManager) != address(0)) {
            historyManager.recordUpgradeHistory(key, oldAddr, newAddr, msg.sender);
        }
        
        // 发出事件
        emit RegistryEvents.ModuleUpgraded(key, oldAddr, newAddr, msg.sender);
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
}
