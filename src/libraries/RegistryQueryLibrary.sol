// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RegistryStorage } from "./RegistryStorageLibrary.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ZeroAddress, IndexOutOfBounds } from "../errors/StandardErrors.sol";

/// @title RegistryQuery
/// @notice 优化的 Registry 查询功能库（View 函数版本）
/// @dev 通过参数限制和优化算法，将链下查询改为高效的 view 函数
library RegistryQuery {
    // 常量定义
    uint256 private constant MAX_QUERY_LIMIT = 50;
    uint256 private constant DEFAULT_PAGE_SIZE = 20;
    uint256 private constant MAX_UPGRADE_HISTORY = 100;

    /// @notice 获取最大查询限制
    /// @return 最大查询限制数量（用于控制 Gas 消耗）
    function getMaxQueryLimit() internal pure returns (uint256) {
        return MAX_QUERY_LIMIT;
    }

    /// @notice 获取默认分页大小
    /// @return 默认分页大小（用于分页查询的默认每页数量）
    function getDefaultPageSize() internal pure returns (uint256) {
        return DEFAULT_PAGE_SIZE;
    }

    /// @notice 获取最大升级历史记录数量
    /// @return 最大升级历史记录数量（环形缓冲区的最大容量）
    function getMaxUpgradeHistory() internal pure returns (uint256) {
        return MAX_UPGRADE_HISTORY;
    }

    /// @notice 轻量级批量模块存在性检查（优化版本）
    /// @param keys 模块键数组
    /// @return exists 每个模块键对应的存在性状态数组（与 keys 数组一一对应）
    /// @dev 优化的批量检查，减少 Gas 消耗，使用 unchecked 优化
    function batchModuleExists(bytes32[] memory keys) internal view returns (bool[] memory exists) {
        exists = new bool[](keys.length);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 使用 unchecked 优化循环
        unchecked {
            for (uint256 i = 0; i < keys.length; i++) {
                exists[i] = l.modules[keys[i]] != address(0);
            }
        }
    }

    /// @notice 模块信息结构体
    /// @param key 模块键
    /// @param addr 模块地址
    struct ModuleInfo {
        bytes32 key;
        address addr;
    }

    /// @notice 分页结果结构体
    /// @param infos 模块信息数组
    /// @param totalCount 总数量
    /// @param hasNext 是否有下一页
    /// @param hasPrev 是否有上一页
    struct PaginatedResult {
        ModuleInfo[] infos;
        uint256 totalCount;
        bool hasNext;
        bool hasPrev;
    }

    /// @notice 读取模块地址（若未设置返回 0 地址）
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return 模块合约地址（如果未注册则返回 address(0)）
    function getModule(bytes32 key) internal view returns (address) {
        return RegistryStorage.layout().modules[key];
    }

    /// @notice 读取模块地址，若未注册则回滚
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return 模块合约地址（如果未注册则回滚交易）
    function getModuleOrRevert(bytes32 key) internal view returns (address) {
        address addr = RegistryStorage.layout().modules[key];
        if (addr == address(0)) revert ZeroAddress();
        return addr;
    }

    /// @notice 检查模块是否已注册
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return 是否已注册（true 表示已注册，false 表示未注册）
    function isModuleRegistered(bytes32 key) internal view returns (bool) {
        return RegistryStorage.layout().modules[key] != address(0);
    }

    /// @notice 获取待升级模块信息
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return newAddr 新模块地址（如果无待升级则为 address(0)）
    /// @return executeAfter 执行时间（如果无待升级则为 0）
    /// @return hasPendingUpgrade 是否有待升级（true 表示有待升级，false 表示无待升级）
    function getPendingUpgrade(bytes32 key) internal view returns (
        address newAddr,
        uint256 executeAfter,
        bool hasPendingUpgrade
    ) {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade memory pending = l.pendingUpgrades[key];
        return (pending.newAddr, pending.executeAfter, pending.newAddr != address(0));
    }

    /// @notice 检查升级是否准备就绪
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return 是否准备就绪（true 表示可以执行升级，false 表示还不能执行）
    function isUpgradeReady(bytes32 key) internal view returns (bool) {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade memory pending = l.pendingUpgrades[key];
        return pending.newAddr != address(0) && block.timestamp >= pending.executeAfter;
    }

    /// @notice 获取单个模块信息
    /// @param key 模块键
    /// @return 模块信息（包含模块键和地址，如果未注册则地址为 address(0)）
    function getModuleInfo(bytes32 key) internal view returns (ModuleInfo memory) {
        address addr = RegistryStorage.layout().modules[key];
        return ModuleInfo({
            key: key,
            addr: addr
        });
    }

    /// @notice 获取多个模块信息（轻量级批量查询）
    /// @param keys 模块键数组
    /// @return 模块信息数组（与 keys 数组一一对应，未注册的模块地址为 address(0)）
    /// @dev 适合小批量查询，Gas 消耗可控
    function getMultipleModuleInfo(bytes32[] memory keys) internal view returns (ModuleInfo[] memory) {
        ModuleInfo[] memory infos = new ModuleInfo[](keys.length);
        
        for (uint256 i = 0; i < keys.length; i++) {
            address addr = RegistryStorage.layout().modules[keys[i]];
            infos[i] = ModuleInfo({
                key: keys[i],
                addr: addr
            });
        }
        
        return infos;
    }

    /// @notice 获取已注册模块信息（限制数量）
    /// @param maxCount 最大查询数量限制
    /// @return 模块信息数组（仅包含已注册的模块，按模块键顺序排列）
    /// @dev 通过 maxCount 参数控制 Gas 消耗
    function getAllModuleInfo(uint256 maxCount) internal view returns (ModuleInfo[] memory) {
        // 限制最大查询数量
        uint256 actualMaxCount = maxCount > MAX_QUERY_LIMIT ? MAX_QUERY_LIMIT : maxCount;
        
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        uint256 registeredCount = 0;
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 限制遍历范围
        uint256 actualMaxKeys = allKeys.length > actualMaxCount ? actualMaxCount : allKeys.length;
        
        // 第一次遍历：计算已注册的模块数量
        for (uint256 i = 0; i < actualMaxKeys; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                registeredCount++;
            }
        }
        
        // 创建结果数组
        ModuleInfo[] memory infos = new ModuleInfo[](registeredCount);
        uint256 index = 0;
        
        // 第二次遍历：填充已注册的模块信息
        for (uint256 i = 0; i < actualMaxKeys; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                infos[index] = ModuleInfo({
                    key: allKeys[i],
                    addr: l.modules[allKeys[i]]
                });
                index++;
            }
        }
        
        return infos;
    }

    /// @notice 分页获取模块信息（轻量级版本）
    /// @param startIndex 起始索引
    /// @param count 查询数量
    /// @param maxTotalCount 最大总查询数量限制
    /// @return 分页结果（包含模块信息数组、总数量、是否有下一页、是否有上一页）
    /// @dev 通过参数限制控制 Gas 消耗，适合小范围分页
    function getModuleInfoPaginated(
        uint256 startIndex,
        uint256 count,
        uint256 maxTotalCount
    ) internal view returns (PaginatedResult memory) {
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 限制总查询数量
        uint256 actualMaxCount = allKeys.length > maxTotalCount ? maxTotalCount : allKeys.length;
        
        // 计算已注册模块的总数量
        uint256 totalRegistered = 0;
        for (uint256 i = 0; i < actualMaxCount; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                totalRegistered++;
            }
        }
        
        // 限制查询数量
        uint256 actualCount = count > DEFAULT_PAGE_SIZE ? DEFAULT_PAGE_SIZE : count;
        
        // 计算实际返回数量
        uint256 actualReturnCount = 0;
        uint256 currentIndex = 0;
        
        // 创建结果数组
        ModuleInfo[] memory infos = new ModuleInfo[](actualCount);
        
        // 遍历并填充结果
        for (uint256 i = 0; i < actualMaxCount && actualReturnCount < actualCount; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                if (currentIndex >= startIndex) {
                    infos[actualReturnCount] = ModuleInfo({
                        key: allKeys[i],
                        addr: l.modules[allKeys[i]]
                    });
                    actualReturnCount++;
                }
                currentIndex++;
            }
        }
        
        // 调整数组大小
        assembly {
            mstore(infos, actualReturnCount)
        }
        
        return PaginatedResult({
            infos: infos,
            totalCount: totalRegistered,
            hasNext: startIndex + actualReturnCount < totalRegistered,
            hasPrev: startIndex > 0
        });
    }

    /// @notice 获取模块统计信息
    /// @param maxCount 最大查询数量限制
    /// @return totalModules 总模块数量（在限制范围内的所有模块）
    /// @return registeredModules 已注册模块数量（在限制范围内）
    /// @return unregisteredModules 未注册模块数量（在限制范围内）
    function getModuleStatistics(uint256 maxCount) internal view returns (
        uint256 totalModules,
        uint256 registeredModules,
        uint256 unregisteredModules
    ) {
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 限制查询范围
        uint256 actualMaxCount = allKeys.length > maxCount ? maxCount : allKeys.length;
        
        totalModules = actualMaxCount;
        
        for (uint256 i = 0; i < actualMaxCount; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                registeredModules++;
            } else {
                unregisteredModules++;
            }
        }
        
        return (totalModules, registeredModules, unregisteredModules);
    }

    /// @notice 检查多个模块是否已注册
    /// @param keys 模块键数组
    /// @return 注册状态数组（与 keys 数组一一对应，true 表示已注册，false 表示未注册）
    function batchIsModuleRegistered(bytes32[] memory keys) internal view returns (bool[] memory) {
        bool[] memory results = new bool[](keys.length);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        for (uint256 i = 0; i < keys.length; i++) {
            results[i] = l.modules[keys[i]] != address(0);
        }
        
        return results;
    }

    /// @notice 返回所有模块是否已注册（批量）
    /// @param keys 模块键数组
    /// @return exists 每个模块是否已注册（与 keys 数组一一对应，true 表示已注册，false 表示未注册）
    /// @dev 轻量级批量检查，Gas 消耗可控，适合前端调用，使用 unchecked 优化
    function checkModulesExist(bytes32[] memory keys) internal view returns (bool[] memory exists) {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        exists = new bool[](keys.length);
        
        // 使用 unchecked 优化循环
        unchecked {
            for (uint256 i = 0; i < keys.length; i++) {
                exists[i] = l.modules[keys[i]] != address(0);
            }
        }
    }

    /// @notice 通过模块地址查找对应的模块键
    /// @param moduleAddr 模块地址
    /// @param maxCount 最大查询数量限制
    /// @return key 找到的模块键（如果未找到则为 bytes32(0)）
    /// @return found 是否找到匹配的模块（true 表示找到，false 表示未找到）
    /// @dev 通过暴力查找实现反向映射，Gas 消耗与 maxCount 成正比
    function findModuleKeyByAddress(address moduleAddr, uint256 maxCount) internal view returns (bytes32 key, bool found) {
        if (moduleAddr == address(0)) return (bytes32(0), false);

        RegistryStorage.Layout storage l = RegistryStorage.layout();
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        uint256 actualMaxCount = allKeys.length > maxCount ? maxCount : allKeys.length;

        for (uint256 i = 0; i < actualMaxCount; i++) {
            if (l.modules[allKeys[i]] == moduleAddr) {
                return (allKeys[i], true);
            }
        }

        return (bytes32(0), false);
    }

    /// @notice 通过模块地址查找对应的模块键（使用默认最大查询数量）
    /// @param moduleAddr 模块地址
    /// @return key 找到的模块键（如果未找到则为 bytes32(0)）
    /// @return found 是否找到匹配的模块（true 表示找到，false 表示未找到）
    /// @dev 使用默认的 MAX_QUERY_LIMIT 作为最大查询数量
    function findModuleKeyByAddress(address moduleAddr) internal view returns (bytes32 key, bool found) {
        return findModuleKeyByAddress(moduleAddr, MAX_QUERY_LIMIT);
    }

    /// @notice 批量通过模块地址查找对应的模块键
    /// @param moduleAddrs 模块地址数组
    /// @param maxCount 最大查询数量限制
    /// @return keys 找到的模块键数组（与 moduleAddrs 一一对应，未找到的为 bytes32(0)）
    /// @return founds 是否找到匹配的模块数组（与 moduleAddrs 一一对应，true 表示找到，false 表示未找到）
    /// @dev 通过暴力查找实现批量反向映射，Gas 消耗与 maxCount 成正比，使用 unchecked 优化
    function batchFindModuleKeysByAddresses(address[] memory moduleAddrs, uint256 maxCount) internal view returns (bytes32[] memory keys, bool[] memory founds) {
        keys = new bytes32[](moduleAddrs.length);
        founds = new bool[](moduleAddrs.length);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        uint256 actualMaxCount = allKeys.length > maxCount ? maxCount : allKeys.length;

        // 使用 unchecked 优化外层循环
        unchecked {
            for (uint256 i = 0; i < moduleAddrs.length; i++) {
                address moduleAddr = moduleAddrs[i];
                if (moduleAddr == address(0)) {
                    keys[i] = bytes32(0);
                    founds[i] = false;
                    continue;
                }

                bool found = false;
                // 使用 unchecked 优化内层循环
                for (uint256 j = 0; j < actualMaxCount; j++) {
                    if (l.modules[allKeys[j]] == moduleAddr) {
                        keys[i] = allKeys[j];
                        founds[i] = true;
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    keys[i] = bytes32(0);
                    founds[i] = false;
                }
            }
        }
    }

    /// @notice 获取已注册模块的键列表（轻量级）
    /// @param maxCount 最大查询数量限制
    /// @return 已注册模块键数组（按模块键顺序排列，仅包含已注册的模块）
    function getAllRegisteredModuleKeys(uint256 maxCount) internal view returns (bytes32[] memory) {
        // 限制最大查询数量
        uint256 actualMaxCount = maxCount > MAX_QUERY_LIMIT ? MAX_QUERY_LIMIT : maxCount;
        
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        uint256 registeredCount = 0;
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 限制遍历范围
        uint256 actualMaxKeys = allKeys.length > actualMaxCount ? actualMaxCount : allKeys.length;
        
        // 第一次遍历：计算已注册的模块数量
        for (uint256 i = 0; i < actualMaxKeys; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                registeredCount++;
            }
        }
        
        // 创建结果数组
        bytes32[] memory registeredKeys = new bytes32[](registeredCount);
        uint256 index = 0;
        
        // 第二次遍历：填充已注册的模块键
        for (uint256 i = 0; i < actualMaxKeys; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                registeredKeys[index++] = allKeys[i];
            }
        }
        
        return registeredKeys;
    }

    /// @notice 获取所有已注册的 ActionKey
    /// @return 已注册的 ActionKey 数组（注意：ActionKey 功能已移至 ModuleKeys，这里返回空数组以保持接口兼容性）
    /// @dev 注意：ActionKey 功能已移至 ModuleKeys，这里保留接口兼容性
    function getRegisteredActionKeys() internal pure returns (bytes32[] memory) {
        // 注意：ActionKey 功能已移至 ModuleKeys
        // 这里返回空数组以保持接口兼容性
        return new bytes32[](0);
    }

    /// @notice 获取模块的升级历史数量
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return 升级历史记录数量（由于使用环形缓冲，返回的是实际记录的条数，最大为 MAX_UPGRADE_HISTORY）
    /// @dev 由于使用环形缓冲，返回的是实际记录的条数（≤ MAX_UPGRADE_HISTORY）
    function getUpgradeHistoryCount(bytes32 key) internal view returns (uint256) {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        uint256 historyLength = l.upgradeHistory[key].length;
        
        // 如果数组未满，返回实际长度
        if (historyLength < MAX_UPGRADE_HISTORY) {
            return historyLength;
        }
        
        // 如果数组已满，返回最大长度（环形缓冲覆盖最旧记录）
        return MAX_UPGRADE_HISTORY;
    }

    /// @notice 获取模块的升级历史记录
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @param index 历史记录索引（0 为最新记录）
    /// @return oldAddress 旧地址（升级前的模块地址）
    /// @return newAddress 新地址（升级后的模块地址）
    /// @return timestamp 升级时间戳（升级执行的时间）
    /// @return executor 执行者地址（执行升级操作的地址）
    /// @dev 由于使用环形缓冲，索引 0 是最新的记录
    function getUpgradeHistory(bytes32 key, uint256 index) internal view returns (
        address oldAddress,
        address newAddress,
        uint256 timestamp,
        address executor
    ) {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        uint256 historyLength = l.upgradeHistory[key].length;
        uint256 historyIndex = l.historyIndex[key];
        
        if (index >= historyLength) revert IndexOutOfBounds(index, historyLength);
        
        // 计算环形缓冲中的实际索引
        uint256 actualIndex;
        if (historyLength < MAX_UPGRADE_HISTORY) {
            // 数组未满，直接使用索引
            actualIndex = index;
        } else {
            // 数组已满，使用环形缓冲逻辑
            // 最新记录在 (historyIndex - 1) % MAX_UPGRADE_HISTORY
            // 索引 0 应该是最新记录
            // ✅ 修复：防止 historyIndex 为 0 时的下溢
            uint256 latestIndex = historyIndex == 0 ? MAX_UPGRADE_HISTORY - 1 : (historyIndex - 1) % MAX_UPGRADE_HISTORY;
            actualIndex = (latestIndex - index + MAX_UPGRADE_HISTORY) % MAX_UPGRADE_HISTORY;
        }
        
        RegistryStorage.UpgradeHistory memory history = l.upgradeHistory[key][actualIndex];
        return (history.oldAddress, history.newAddress, history.timestamp, history.executor);
    }

    /// @notice 获取模块的升级历史记录（优化版本）
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @param maxCount 最大查询数量限制
    /// @return 升级历史记录数组（按时间从新到旧排序，最多返回 maxCount 条记录）
    /// @dev 通过 maxCount 参数控制 Gas 消耗
    function getAllUpgradeHistory(bytes32 key, uint256 maxCount) internal view returns (RegistryStorage.UpgradeHistory[] memory) {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        uint256 historyLength = l.upgradeHistory[key].length;
        uint256 historyIndex = l.historyIndex[key];
        
        if (historyLength == 0) {
            return new RegistryStorage.UpgradeHistory[](0);
        }
        
        // 确定实际记录数量
        uint256 actualCount = historyLength < MAX_UPGRADE_HISTORY ? historyLength : MAX_UPGRADE_HISTORY;
        
        // 限制返回数量
        uint256 returnCount = actualCount > maxCount ? maxCount : actualCount;
        
        RegistryStorage.UpgradeHistory[] memory result = new RegistryStorage.UpgradeHistory[](returnCount);
        
        for (uint256 i = 0; i < returnCount; i++) {
            uint256 actualIndex;
            if (historyLength < MAX_UPGRADE_HISTORY) {
                // 数组未满，直接使用索引
                actualIndex = i;
            } else {
                // 数组已满，使用环形缓冲逻辑
                // ✅ 修复：防止 historyIndex 为 0 时的下溢
                uint256 latestIndex = historyIndex == 0 ? MAX_UPGRADE_HISTORY - 1 : (historyIndex - 1) % MAX_UPGRADE_HISTORY;
                actualIndex = (latestIndex - i + MAX_UPGRADE_HISTORY) % MAX_UPGRADE_HISTORY;
            }
            
            result[i] = l.upgradeHistory[key][actualIndex];
        }
        
        return result;
    }

    /// @notice 分页获取已注册模块的键列表（优化版本）
    /// @param offset 偏移量
    /// @param limit 每页数量限制
    /// @param maxTotalCount 最大总查询数量限制
    /// @return keys 已注册模块键数组（按模块键顺序排列，仅包含已注册的模块）
    /// @return totalCount 总数量（在限制范围内的已注册模块总数）
    /// @dev 通过多个参数控制 Gas 消耗
    function getRegisteredModuleKeysPaginated(
        uint256 offset,
        uint256 limit,
        uint256 maxTotalCount
    ) internal view returns (bytes32[] memory keys, uint256 totalCount) {
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 限制总查询数量
        uint256 actualMaxCount = allKeys.length > maxTotalCount ? maxTotalCount : allKeys.length;
        
        // 计算总数量（限制范围内）
        uint256 count = 0;
        for (uint256 i = 0; i < actualMaxCount; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                count++;
            }
        }
        
        totalCount = count;
        
        // 计算实际返回数量
        uint256 actualLimit = limit > DEFAULT_PAGE_SIZE ? DEFAULT_PAGE_SIZE : limit;
        uint256 actualCount = 0;
        uint256 currentIndex = 0;
        
        // 创建结果数组
        keys = new bytes32[](actualLimit);
        
        // 遍历并填充结果
        for (uint256 i = 0; i < actualMaxCount && actualCount < actualLimit; i++) {
            if (l.modules[allKeys[i]] != address(0)) {
                if (currentIndex >= offset) {
                    keys[actualCount] = allKeys[i];
                    actualCount++;
                }
                currentIndex++;
            }
        }
        
        // 调整数组大小
        assembly {
            mstore(keys, actualCount)
        }
        
        return (keys, totalCount);
    }

    /// @notice 检查模块是否存在（新增功能）
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return 模块是否存在（true 表示存在，false 表示不存在）
    /// @dev 轻量级检查，Gas 消耗极低
    function moduleExists(bytes32 key) internal view returns (bool) {
        return isModuleRegistered(key);
    }

    /// @notice 获取模块注册时间（新增功能）
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return 注册时间戳（如果模块未注册，返回 0）
    /// @dev 如果模块未注册，返回 0
    function getModuleRegistrationTime(bytes32 key) internal view returns (uint256) {
        // 检查模块是否存在（使用参数 key）
        if (!isModuleRegistered(key)) {
            return 0; // 模块不存在，返回 0
        }
        
        // 注意：这里需要 RegistryStorage 中添加 registrationTime 字段
        // 如果当前存储结构不支持，可以返回 0
        return 0; // 临时返回 0，需要根据实际存储结构调整
    }

    // 向后兼容的函数
    /// @notice 获取所有模块信息（向后兼容）
    /// @return 模块信息数组（仅包含已注册的模块，按模块键顺序排列，最多返回 MAX_QUERY_LIMIT 个）
    function getAllModuleInfo() internal view returns (ModuleInfo[] memory) {
        return getAllModuleInfo(MAX_QUERY_LIMIT);
    }

    /// @notice 分页获取模块信息（向后兼容）
    /// @param startIndex 起始索引
    /// @param count 查询数量
    /// @return 分页结果（包含模块信息数组、总数量、是否有下一页、是否有上一页）
    function getModuleInfoPaginated(uint256 startIndex, uint256 count) internal view returns (PaginatedResult memory) {
        return getModuleInfoPaginated(startIndex, count, MAX_QUERY_LIMIT);
    }

    /// @notice 获取所有已注册模块的键列表（向后兼容）
    /// @return 已注册模块键数组（按模块键顺序排列，仅包含已注册的模块，最多返回 MAX_QUERY_LIMIT 个）
    function getAllRegisteredModuleKeys() internal view returns (bytes32[] memory) {
        return getAllRegisteredModuleKeys(MAX_QUERY_LIMIT);
    }

    /// @notice 获取所有已注册模块的键和地址（向后兼容）
    /// @return keys 已注册模块键数组（按模块键顺序排列，仅包含已注册的模块）
    /// @return addresses 对应的模块地址数组（与 keys 数组一一对应）
    function getAllRegisteredModules() internal view returns (bytes32[] memory keys, address[] memory addresses) {
        ModuleInfo[] memory infos = getAllModuleInfo(MAX_QUERY_LIMIT);
        keys = new bytes32[](infos.length);
        addresses = new address[](infos.length);
        
        for (uint256 i = 0; i < infos.length; i++) {
            keys[i] = infos[i].key;
            addresses[i] = infos[i].addr;
        }
        
        return (keys, addresses);
    }

    /// @notice 获取模块的所有升级历史记录（向后兼容）
    /// @param key 模块键（使用 ModuleKeys 常量）
    /// @return 升级历史记录数组（按时间从新到旧排序，最多返回 MAX_UPGRADE_HISTORY 条记录）
    function getAllUpgradeHistory(bytes32 key) internal view returns (RegistryStorage.UpgradeHistory[] memory) {
        return getAllUpgradeHistory(key, MAX_UPGRADE_HISTORY);
    }

    /// @notice 分页获取已注册模块的键列表（向后兼容）
    /// @param offset 偏移量
    /// @param limit 每页数量限制
    /// @return keys 已注册模块键数组（按模块键顺序排列，仅包含已注册的模块）
    /// @return totalCount 总数量（已注册模块的总数）
    function getRegisteredModuleKeysPaginated(uint256 offset, uint256 limit) internal view returns (
        bytes32[] memory keys,
        uint256 totalCount
    ) {
        return getRegisteredModuleKeysPaginated(offset, limit, MAX_QUERY_LIMIT);
    }
} 