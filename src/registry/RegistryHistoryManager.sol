// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import { RegistryStorage } from "./RegistryStorageLibrary.sol";
import { RegistryEvents } from "./RegistryEventsLibrary.sol";

/// @title RegistryHistoryManager
/// @notice 历史记录管理模块
/// @dev 负责处理Registry的升级历史记录功能
contract RegistryHistoryManager is 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    // ============ Constants ============
    uint256 private constant MAX_UPGRADE_HISTORY = 100; // 升级历史记录上限

    // ============ Constructor ============
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /// @notice 初始化历史记录管理模块
    function initialize() external initializer {
        __Ownable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
    }

    // ============ 历史记录功能 ============
    /// @notice 记录模块升级历史（使用环形缓冲，限制历史数量）
    /// @param key 模块键
    /// @param oldAddr 旧地址
    /// @param newAddr 新地址
    /// @param executor 执行者地址
    function recordUpgradeHistory(bytes32 key, address oldAddr, address newAddr, address executor) external {
        // 只允许Registry合约调用
        require(msg.sender == address(this) || msg.sender == owner(), "Unauthorized");
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        RegistryStorage.UpgradeHistory memory history = RegistryStorage.UpgradeHistory({
            oldAddress: oldAddr,
            newAddress: newAddr,
            timestamp: block.timestamp,
            executor: executor
        });
        
        // ✅ 优化：使用环形缓冲实现，限制历史记录数量，防止存储膨胀
        uint256 currentIndex = l.historyIndex[key];
        uint256 ringIndex = currentIndex % MAX_UPGRADE_HISTORY;
        
        if (l.upgradeHistory[key].length < MAX_UPGRADE_HISTORY) {
            // 数组未满，直接 push
            l.upgradeHistory[key].push(history);
        } else {
            // 数组已满，覆盖最旧的记录（FIFO 环形缓冲）
            l.upgradeHistory[key][ringIndex] = history;
        }
        
        // 更新索引（用于环形缓冲计算）
        l.historyIndex[key] = currentIndex + 1;
        
        emit RegistryEvents.UpgradeHistoryRecorded(key, oldAddr, newAddr, block.timestamp, executor, bytes32(0));
    }

    /// @notice 批量记录模块升级历史（使用环形缓冲，限制历史数量）
    /// @param keys 模块键数组
    /// @param oldAddresses 旧地址数组
    /// @param newAddresses 新地址数组
    /// @param executor 执行者地址
    function recordBatchUpgradeHistory(bytes32[] memory keys, address[] memory oldAddresses, address[] memory newAddresses, address executor) external {
        // 只允许Registry合约调用
        require(msg.sender == address(this) || msg.sender == owner(), "Unauthorized");
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();

        for (uint256 i = 0; i < keys.length; i++) {
            bytes32 key = keys[i];
            address oldAddr = oldAddresses[i];
            address newAddr = newAddresses[i];

            RegistryStorage.UpgradeHistory memory history = RegistryStorage.UpgradeHistory({
                oldAddress: oldAddr,
                newAddress: newAddr,
                timestamp: block.timestamp,
                executor: executor
            });

            // ✅ 优化：使用环形缓冲策略，限制历史记录数量，防止存储膨胀
            uint256 currentIndex = l.historyIndex[key];
            uint256 ringIndex = currentIndex % MAX_UPGRADE_HISTORY;
            
            if (l.upgradeHistory[key].length < MAX_UPGRADE_HISTORY) {
                l.upgradeHistory[key].push(history);
            } else {
                // 数组已满，覆盖最旧的记录（FIFO 环形缓冲）
                l.upgradeHistory[key][ringIndex] = history;
            }
            
            l.historyIndex[key] = currentIndex + 1;
        }
        
        // 触发批量历史记录事件
        emit RegistryEvents.BatchModuleChanged(keys, oldAddresses, newAddresses, executor);
    }

    /// @notice 获取模块的升级历史数量
    /// @param key 模块键
    /// @return 升级历史记录数量
    function getUpgradeHistoryCount(bytes32 key) external view returns (uint256) {
        return RegistryStorage.layout().upgradeHistory[key].length;
    }

    /// @notice 获取模块的升级历史记录
    /// @param key 模块键
    /// @param index 历史记录索引
    /// @return oldAddress 旧地址
    /// @return newAddress 新地址
    /// @return timestamp 升级时间戳
    /// @return executor 执行者地址
    function getUpgradeHistory(bytes32 key, uint256 index) external view returns (
        address oldAddress,
        address newAddress,
        uint256 timestamp,
        address executor
    ) {
        RegistryStorage.UpgradeHistory[] memory history = RegistryStorage.layout().upgradeHistory[key];
        require(index < history.length, "Index out of bounds");
        
        RegistryStorage.UpgradeHistory memory record = history[index];
        return (record.oldAddress, record.newAddress, record.timestamp, record.executor);
    }

    /// @notice 获取模块的所有升级历史记录
    /// @param key 模块键
    /// @return 升级历史记录数组
    function getAllUpgradeHistory(bytes32 key) external view returns (RegistryStorage.UpgradeHistory[] memory) {
        return RegistryStorage.layout().upgradeHistory[key];
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
}
