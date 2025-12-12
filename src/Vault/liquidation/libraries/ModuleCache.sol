// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * 模块缓存库 - 提供高效的模块地址缓存管理
 * Module Cache Library - Provides efficient module address cache management
 * @dev 支持模块地址的缓存、过期检查、批量操作、可枚举性和版本控制
 * @dev Supports module address caching, expiration checking, batch operations, enumerability and version control
 * @dev 包含完整的访问控制和安全性检查
 * @dev Includes complete access control and security checks
 */
library ModuleCache {
    /* ============ Custom Errors ============ */
    
    /**
     * 模块未找到错误 - 当请求的模块不存在时触发
     * Module not found error - Triggered when requested module doesn't exist
     * @param moduleKey 模块键值 Module key
     */
    error ModuleCache__ModuleNotFound(bytes32 moduleKey);
    
    /**
     * 无效模块地址错误 - 当模块地址为零地址时触发
     * Invalid module address error - Triggered when module address is zero
     * @param moduleKey 模块键值 Module key
     * @param moduleAddr 无效地址 Invalid address
     */
    error ModuleCache__InvalidModuleAddress(bytes32 moduleKey, address moduleAddr);
    
    /**
     * 无效模块键值错误 - 当模块键值为零时触发
     * Invalid module key error - Triggered when module key is zero
     * @param moduleKey 模块键值 Module key
     */
    error ModuleCache__InvalidModuleKey(bytes32 moduleKey);
    
    /**
     * 缓存过期错误 - 当缓存超过最大有效期时触发
     * Cache expired error - Triggered when cache exceeds maximum validity period
     * @param moduleKey 模块键值 Module key
     * @param cacheAge 缓存年龄 Cache age
     * @param maxAge 最大有效期 Maximum validity period
     */
    error ModuleCache__CacheExpired(bytes32 moduleKey, uint256 cacheAge, uint256 maxAge);
    
    /**
     * 重复设置错误 - 当尝试设置相同地址时触发
     * Duplicate set error - Triggered when trying to set same address
     * @param moduleKey 模块键值 Module key
     * @param existingAddr 现有地址 Existing address
     * @param newAddr 新地址 New address
     */
    error ModuleCache__DuplicateModuleAddress(bytes32 moduleKey, address existingAddr, address newAddr);
    
    /**
     * 数组长度不匹配错误 - 当批量操作数组长度不匹配时触发
     * Array length mismatch error - Triggered when batch operation array lengths don't match
     * @param keysLength 键值数组长度 Keys array length
     * @param addressesLength 地址数组长度 Addresses array length
     */
    error ModuleCache__ArrayLengthMismatch(uint256 keysLength, uint256 addressesLength);
    
    /**
     * 未授权操作错误 - 当调用者未授权时触发
     * Unauthorized operation error - Triggered when caller is not authorized
     * @param operation 操作类型 Operation type
     * @param caller 调用者地址 Caller address
     */
    error ModuleCache__UnauthorizedOperation(string operation, address caller);
    
    /**
     * 时间回退错误 - 当检测到时间回退时触发
     * Time rollback error - Triggered when time rollback is detected
     * @param currentTime 当前时间 Current time
     * @param cachedTime 缓存时间 Cached time
     */
    error ModuleCache__TimeRollbackDetected(uint256 currentTime, uint256 cachedTime);
    
    /**
     * 批量操作失败错误 - 当批量操作部分失败时触发
     * Batch operation failed error - Triggered when batch operation partially fails
     * @param failedKeys 失败的键值数组 Array of failed keys
     * @param failureReasons 失败原因数组 Array of failure reasons
     */
    error ModuleCache__BatchOperationFailed(bytes32[] failedKeys, string[] failureReasons);

    /* ============ Events ============ */
    
    /**
     * 模块缓存事件 - 当模块被缓存时触发
     * Module cached event - Triggered when module is cached
     * @param moduleKey 模块键值 Module key
     * @param moduleAddr 模块地址 Module address
     * @param version 版本号 Version number
     * @param timestamp 时间戳 Timestamp
     * @param callerAddr 调用者地址 Caller address
     */
    event ModuleCached(
        bytes32 indexed moduleKey, 
        address indexed moduleAddr, 
        uint256 version, 
        uint256 timestamp,
        address indexed callerAddr
    );
    
    /**
     * 模块移除事件 - 当模块从缓存中移除时触发
     * Module removed event - Triggered when module is removed from cache
     * @param moduleKey 模块键值 Module key
     * @param moduleAddr 模块地址 Module address
     * @param version 版本号 Version number
     * @param callerAddr 调用者地址 Caller address
     */
    event ModuleRemoved(
        bytes32 indexed moduleKey, 
        address indexed moduleAddr, 
        uint256 version,
        address indexed callerAddr
    );
    
    /**
     * 批量模块缓存事件 - 当多个模块同时被缓存时触发
     * Batch modules cached event - Triggered when multiple modules are cached simultaneously
     * @param moduleKeys 模块键值数组 Array of module keys
     * @param moduleAddresses 模块地址数组 Array of module addresses
     * @param version 版本号 Version number
     * @param callerAddr 调用者地址 Caller address
     * @param successCount 成功数量 Success count
     */
    event BatchModulesCached(
        bytes32[] moduleKeys, 
        address[] moduleAddresses, 
        uint256 version,
        address indexed callerAddr,
        uint256 successCount
    );
    
    /**
     * 缓存清理事件 - 当缓存被清理时触发
     * Cache cleared event - Triggered when cache is cleared
     * @param clearedCount 清理数量 Cleared count
     * @param caller 调用者地址 Caller address
     */
    event CacheCleared(uint256 clearedCount, address indexed caller);
    
    /**
     * 重复操作事件 - 当尝试重复操作时触发
     * Duplicate operation event - Triggered when attempting duplicate operation
     * @param moduleKey 模块键值 Module key
     * @param existingAddr 现有地址 Existing address
     * @param attemptedAddr 尝试设置的地址 Attempted address
     * @param callerAddr 调用者地址 Caller address
     */
    event DuplicateOperationAttempted(
        bytes32 indexed moduleKey,
        address indexed existingAddr,
        address indexed attemptedAddr,
        address callerAddr
    );

    /* ============ Structs ============ */
    
    /**
     * 模块缓存存储结构 - 存储模块地址、时间戳、版本和键值集合
     * Module cache storage structure - Stores module addresses, timestamps, versions and key collection
     * @dev 使用具体化的命名提高代码可读性
     * @dev Uses specific naming to improve code readability
     */
    struct ModuleCacheStorage {
        mapping(bytes32 => address) moduleAddresses;      // 模块地址映射 Module address mapping
        mapping(bytes32 => uint256) cacheTimestamps;      // 缓存时间戳映射 Cache timestamp mapping
        mapping(bytes32 => uint256) moduleVersions;       // 模块版本映射 Module version mapping
        bytes32[] moduleKeys;                             // 模块键值集合 Module keys collection
        mapping(bytes32 => uint256) keyIndexes;           // 键值索引映射 Key index mapping
        uint256 totalModules;                             // 总模块数量 Total module count
        uint256 globalVersion;                            // 全局版本号 Global version number
        bool allowTimeRollback;                           // 是否允许时间回退 Whether to allow time rollback
        address accessController;                         // 访问控制器地址 Access controller address
        bool initialized;                                 // 是否已初始化 Whether initialized
    }

    /* ============ Constants ============ */
    
    /// @dev 默认批量清理大小 Default batch clear size
    uint256 private constant DEFAULT_BATCH_SIZE = 50;
    
    /// @dev 最大批量操作大小 Maximum batch operation size
    uint256 private constant MAX_BATCH_SIZE = 100;

    /* ============ Core Functions ============ */
    
    /**
     * 初始化模块缓存 - 设置初始配置
     * Initialize module cache - Set initial configuration
     * @param self 缓存存储结构 Cache storage structure
     * @param allowRollback 是否允许时间回退 Whether to allow time rollback
     * @param controllerAddr 访问控制器地址 Access controller address
     */
    function initialize(
        ModuleCacheStorage storage self,
        bool allowRollback,
        address controllerAddr
    ) internal {
        require(!self.initialized, "ModuleCache: Already initialized");
        
        self.allowTimeRollback = allowRollback;
        self.accessController = controllerAddr;
        self.initialized = true;
    }
    
    /**
     * 设置模块缓存 - 将模块地址存储到缓存中，包含重复检查和版本控制
     * Set module cache - Store module address in cache with duplicate check and version control
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @param moduleAddr 模块地址 Module address
     * @param callerAddr 调用者地址 Caller address
     * @dev 防止重复设置相同地址，支持版本控制和访问控制
     * @dev Prevents duplicate setting of same address, supports version control and access control
     */
    function set(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        address moduleAddr,
        address callerAddr
    ) internal {
        // 参数验证
        // Parameter validation
        if (moduleKey == bytes32(0)) {
            revert ModuleCache__InvalidModuleKey(moduleKey);
        }
        
        // 访问控制检查
        // Access control check
        _checkAccessControl(self, "set", callerAddr);
        
        // 验证模块地址
        // Validate module address
        if (moduleAddr == address(0)) {
            revert ModuleCache__InvalidModuleAddress(moduleKey, moduleAddr);
        }
        
        // 检查是否重复设置相同地址
        // Check if duplicate setting same address
        address existingAddr = self.moduleAddresses[moduleKey];
        if (existingAddr == moduleAddr) {
            emit DuplicateOperationAttempted(moduleKey, existingAddr, moduleAddr, callerAddr);
            revert ModuleCache__DuplicateModuleAddress(moduleKey, existingAddr, moduleAddr);
        }
        
        // 更新全局版本号
        // Update global version number
        self.globalVersion++;
        
        // 如果是新模块，添加到键值集合
        // If it's a new module, add to key collection
        if (existingAddr == address(0)) {
            self.moduleKeys.push(moduleKey);
            self.keyIndexes[moduleKey] = self.moduleKeys.length - 1;
            self.totalModules++;
        }
        
        // 设置模块信息
        // Set module information
        self.moduleAddresses[moduleKey] = moduleAddr;
        self.cacheTimestamps[moduleKey] = block.timestamp;
        self.moduleVersions[moduleKey] = self.globalVersion;
        
        emit ModuleCached(moduleKey, moduleAddr, self.globalVersion, block.timestamp, callerAddr);
    }

    /**
     * 获取模块地址 - 从缓存中获取模块地址并检查是否过期
     * Get module address - Get module address from cache and check if expired
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @param maxAge 最大缓存时间 Maximum cache age
     * @return 模块地址 Module address
     * @dev 包含时间回退检测和过期检查
     * @dev Includes time rollback detection and expiration check
     */
    function get(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        uint256 maxAge
    ) internal view returns (address) {
        // 参数验证
        // Parameter validation
        if (moduleKey == bytes32(0)) {
            revert ModuleCache__InvalidModuleKey(moduleKey);
        }
        
        address moduleAddr = self.moduleAddresses[moduleKey];
        if (moduleAddr == address(0)) {
            revert ModuleCache__ModuleNotFound(moduleKey);
        }
        
        // 检查缓存是否过期
        // Check if cache is expired
        uint256 timestamp = self.cacheTimestamps[moduleKey];
        if (timestamp == 0) {
            revert ModuleCache__ModuleNotFound(moduleKey);
        }
        
        // 时间回退检测
        // Time rollback detection
        if (block.timestamp < timestamp) {
            if (!self.allowTimeRollback) {
                revert ModuleCache__TimeRollbackDetected(block.timestamp, timestamp);
            }
            return moduleAddr; // 允许时间回退时直接返回
        }
        
        uint256 cacheAge = block.timestamp - timestamp;
        if (cacheAge > maxAge) {
            revert ModuleCache__CacheExpired(moduleKey, cacheAge, maxAge);
        }
        
        return moduleAddr;
    }

    /**
     * 获取模块地址 - get函数的别名，保持向后兼容性
     * Get module address - Alias for get function, maintains backward compatibility
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @param maxAge 最大缓存时间 Maximum cache age
     * @return 模块地址 Module address
     */
    function getModule(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        uint256 maxAge
    ) internal view returns (address) {
        return get(self, moduleKey, maxAge);
    }

    /**
     * 更新模块地址 - set函数的别名，保持向后兼容性
     * Update module address - Alias for set function, maintains backward compatibility
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @param moduleAddr 模块地址 Module address
     * @param callerAddr 调用者地址 Caller address
     */
    function updateModule(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        address moduleAddr,
        address callerAddr
    ) internal {
        set(self, moduleKey, moduleAddr, callerAddr);
    }

    /**
     * 批量更新模块地址 - batchSet函数的别名，保持向后兼容性
     * Batch update module addresses - Alias for batchSet function, maintains backward compatibility
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKeys 模块键值数组 Array of module keys
     * @param moduleAddresses 模块地址数组 Array of module addresses
     * @param callerAddr 调用者地址 Caller address
     */
    function batchUpdateModules(
        ModuleCacheStorage storage self,
        bytes32[] memory moduleKeys,
        address[] memory moduleAddresses,
        address callerAddr
    ) internal {
        batchSet(self, moduleKeys, moduleAddresses, callerAddr);
    }

    /**
     * 移除模块地址 - remove函数的别名，保持向后兼容性
     * Remove module address - Alias for remove function, maintains backward compatibility
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @param callerAddr 调用者地址 Caller address
     */
    function removeModule(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        address callerAddr
    ) internal {
        remove(self, moduleKey, callerAddr);
    }

    /**
     * 移除模块缓存 - 从缓存中删除指定模块，包含键值集合更新
     * Remove module cache - Remove specified module from cache with key collection update
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @param callerAddr 调用者地址 Caller address
     * @dev 支持从键值集合中移除模块
     * @dev Supports removing module from key collection
     */
    function remove(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        address callerAddr
    ) internal {
        // 参数验证
        // Parameter validation
        if (moduleKey == bytes32(0)) {
            revert ModuleCache__InvalidModuleKey(moduleKey);
        }
        
        // 访问控制检查
        // Access control check
        _checkAccessControl(self, "remove", callerAddr);
        
        address moduleAddr = self.moduleAddresses[moduleKey];
        if (moduleAddr == address(0)) {
            revert ModuleCache__ModuleNotFound(moduleKey);
        }
        
        uint256 version = self.moduleVersions[moduleKey];
        
        // 从键值集合中移除
        // Remove from key collection
        uint256 keyIndex = self.keyIndexes[moduleKey];
        if (keyIndex < self.moduleKeys.length) {
            // 将最后一个元素移到当前位置
            // Move last element to current position
            bytes32 lastKey = self.moduleKeys[self.moduleKeys.length - 1];
            self.moduleKeys[keyIndex] = lastKey;
            self.keyIndexes[lastKey] = keyIndex;
            self.moduleKeys.pop();
        }
        
        // 清理存储
        // Clean up storage
        delete self.moduleAddresses[moduleKey];
        delete self.cacheTimestamps[moduleKey];
        delete self.moduleVersions[moduleKey];
        delete self.keyIndexes[moduleKey];
        
        self.totalModules--;
        
        emit ModuleRemoved(moduleKey, moduleAddr, version, callerAddr);
    }

    /* ============ Batch Operations ============ */
    
    /**
     * 批量设置模块缓存 - 一次性缓存多个模块地址（全部事务一致性）
     * Batch set module cache - Cache multiple module addresses at once (full transaction consistency)
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKeys 模块键值数组 Array of module keys
     * @param moduleAddresses 模块地址数组 Array of module addresses
     * @param callerAddr 调用者地址 Caller address
     * @dev 如果任何操作失败，整个批量操作将回滚
     * @dev If any operation fails, the entire batch operation will rollback
     */
    function batchSet(
        ModuleCacheStorage storage self,
        bytes32[] memory moduleKeys,
        address[] memory moduleAddresses,
        address callerAddr
    ) internal {
        if (moduleKeys.length != moduleAddresses.length) {
            revert ModuleCache__ArrayLengthMismatch(moduleKeys.length, moduleAddresses.length);
        }
        
        if (moduleKeys.length > MAX_BATCH_SIZE) {
            revert ModuleCache__ArrayLengthMismatch(moduleKeys.length, MAX_BATCH_SIZE);
        }
        
        // 访问控制检查
        // Access control check
        _checkAccessControl(self, "batchSet", callerAddr);
        
        // 预验证所有参数
        // Pre-validate all parameters
        for (uint256 i = 0; i < moduleKeys.length; i++) {
            if (moduleKeys[i] == bytes32(0)) {
                revert ModuleCache__InvalidModuleKey(moduleKeys[i]);
            }
            if (moduleAddresses[i] == address(0)) {
                revert ModuleCache__InvalidModuleAddress(moduleKeys[i], moduleAddresses[i]);
            }
        }
        
        // 执行批量设置
        // Execute batch set
        for (uint256 i = 0; i < moduleKeys.length; i++) {
            set(self, moduleKeys[i], moduleAddresses[i], callerAddr);
        }
        
        emit BatchModulesCached(moduleKeys, moduleAddresses, self.globalVersion, callerAddr, moduleKeys.length);
    }

    /**
     * 批量移除模块缓存 - 一次性移除多个模块缓存（全部事务一致性）
     * Batch remove module cache - Remove multiple module caches at once (full transaction consistency)
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKeys 模块键值数组 Array of module keys
     * @param callerAddr 调用者地址 Caller address
     * @dev 如果任何操作失败，整个批量操作将回滚
     * @dev If any operation fails, the entire batch operation will rollback
     */
    function batchRemove(
        ModuleCacheStorage storage self,
        bytes32[] memory moduleKeys,
        address callerAddr
    ) internal {
        if (moduleKeys.length > MAX_BATCH_SIZE) {
            revert ModuleCache__ArrayLengthMismatch(moduleKeys.length, MAX_BATCH_SIZE);
        }
        
        // 访问控制检查
        // Access control check
        _checkAccessControl(self, "batchRemove", callerAddr);
        
        // 预验证所有参数
        // Pre-validate all parameters
        for (uint256 i = 0; i < moduleKeys.length; i++) {
            if (moduleKeys[i] == bytes32(0)) {
                revert ModuleCache__InvalidModuleKey(moduleKeys[i]);
            }
        }
        
        // 执行批量移除
        // Execute batch remove
        for (uint256 i = 0; i < moduleKeys.length; i++) {
            remove(self, moduleKeys[i], callerAddr);
        }
    }

    /* ============ Utility Functions ============ */
    
    /**
     * 检查模块是否存在 - 检查指定模块是否在缓存中
     * Check if module exists - Check if specified module exists in cache
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @return 是否存在 Whether exists
     */
    function exists(ModuleCacheStorage storage self, bytes32 moduleKey) internal view returns (bool) {
        if (moduleKey == bytes32(0)) return false;
        return self.moduleAddresses[moduleKey] != address(0);
    }

    /**
     * 检查缓存是否有效 - 检查指定模块的缓存是否在有效期内
     * Check if cache is valid - Check if specified module cache is within validity period
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @param maxAge 最大缓存时间 Maximum cache age
     * @return 是否有效 Whether valid
     */
    function isValid(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        uint256 maxAge
    ) internal view returns (bool) {
        if (moduleKey == bytes32(0)) return false;
        if (!exists(self, moduleKey)) return false;
        
        uint256 timestamp = self.cacheTimestamps[moduleKey];
        if (timestamp == 0) return false;
        
        // 时间回退处理
        // Time rollback handling
        if (block.timestamp < timestamp) {
            return self.allowTimeRollback;
        }
        
        return (block.timestamp - timestamp) <= maxAge;
    }

    /**
     * 获取缓存时间戳 - 获取指定模块的缓存时间戳
     * Get cache timestamp - Get cache timestamp for specified module
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @return 缓存时间戳 Cache timestamp
     */
    function getTimestamp(ModuleCacheStorage storage self, bytes32 moduleKey) internal view returns (uint256) {
        if (moduleKey == bytes32(0)) return 0;
        return self.cacheTimestamps[moduleKey];
    }

    /**
     * 获取剩余有效期 - 计算指定模块缓存的剩余有效期
     * Get remaining validity period - Calculate remaining validity period for specified module cache
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @param maxAge 最大缓存时间 Maximum cache age
     * @return 剩余有效期 Remaining validity period
     */
    function getRemainingValidity(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        uint256 maxAge
    ) internal view returns (uint256) {
        if (moduleKey == bytes32(0)) return 0;
        if (!exists(self, moduleKey)) return 0;
        
        uint256 timestamp = self.cacheTimestamps[moduleKey];
        if (timestamp == 0) return 0;
        
        // 时间回退处理
        // Time rollback handling
        if (block.timestamp < timestamp) {
            return self.allowTimeRollback ? maxAge : 0;
        }
        
        uint256 elapsed = block.timestamp - timestamp;
        return elapsed >= maxAge ? 0 : maxAge - elapsed;
    }

    /* ============ Enumerable Functions ============ */
    
    /**
     * 获取所有模块键值 - 返回所有缓存的模块键值
     * Get all module keys - Return all cached module keys
     * @param self 缓存存储结构 Cache storage structure
     * @return 模块键值数组 Array of module keys
     */
    function getAllModuleKeys(ModuleCacheStorage storage self) internal view returns (bytes32[] memory) {
        return self.moduleKeys;
    }

    /**
     * 获取模块键值数量 - 返回缓存的模块数量
     * Get module key count - Return number of cached modules
     * @param self 缓存存储结构 Cache storage structure
     * @return 模块数量 Module count
     */
    function getModuleKeyCount(ModuleCacheStorage storage self) internal view returns (uint256) {
        return self.moduleKeys.length;
    }

    /**
     * 获取模块键值索引 - 返回指定模块键值的索引位置
     * Get module key index - Return index position of specified module key
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @return 索引位置 Index position
     */
    function getModuleKeyIndex(ModuleCacheStorage storage self, bytes32 moduleKey) internal view returns (uint256) {
        if (moduleKey == bytes32(0)) return type(uint256).max;
        return self.keyIndexes[moduleKey];
    }

    /* ============ Version Control Functions ============ */
    
    /**
     * 获取模块版本 - 获取指定模块的版本号
     * Get module version - Get version number of specified module
     * @param self 缓存存储结构 Cache storage structure
     * @param moduleKey 模块键值 Module key
     * @return 版本号 Version number
     */
    function getModuleVersion(ModuleCacheStorage storage self, bytes32 moduleKey) internal view returns (uint256) {
        if (moduleKey == bytes32(0)) return 0;
        return self.moduleVersions[moduleKey];
    }

    /**
     * 获取全局版本 - 获取全局版本号
     * Get global version - Get global version number
     * @param self 缓存存储结构 Cache storage structure
     * @return 全局版本号 Global version number
     */
    function getGlobalVersion(ModuleCacheStorage storage self) internal view returns (uint256) {
        return self.globalVersion;
    }

    /* ============ Configuration Functions ============ */
    
    /**
     * 设置时间回退容忍性 - 设置是否允许时间回退
     * Set time rollback tolerance - Set whether to allow time rollback
     * @param self 缓存存储结构 Cache storage structure
     * @param allowRollback 是否允许回退 Whether to allow rollback
     * @param callerAddr 调用者地址 Caller address
     */
    function setTimeRollbackTolerance(
        ModuleCacheStorage storage self, 
        bool allowRollback,
        address callerAddr
    ) internal {
        _checkAccessControl(self, "setTimeRollbackTolerance", callerAddr);
        self.allowTimeRollback = allowRollback;
    }

    /**
     * 设置访问控制器 - 设置访问控制器地址
     * Set access controller - Set access controller address
     * @param self 缓存存储结构 Cache storage structure
     * @param controllerAddr 控制器地址 Controller address
     * @param callerAddr 调用者地址 Caller address
     */
    function setAccessController(
        ModuleCacheStorage storage self, 
        address controllerAddr,
        address callerAddr
    ) internal {
        _checkAccessControl(self, "setAccessController", callerAddr);
        self.accessController = controllerAddr;
    }

    /**
     * 清理缓存 - 清理所有模块缓存
     * Clear cache - Clear all module caches
     * @param self 缓存存储结构 Cache storage structure
     * @param callerAddr 调用者地址 Caller address
     */
    function clearCache(ModuleCacheStorage storage self, address callerAddr) internal {
        // 访问控制检查
        // Access control check
        _checkAccessControl(self, "clearCache", callerAddr);
        
        uint256 clearedCount = self.moduleKeys.length;
        
        // 清理所有模块
        // Clear all modules
        for (uint256 i = 0; i < self.moduleKeys.length; i++) {
            bytes32 moduleKey = self.moduleKeys[i];
            delete self.moduleAddresses[moduleKey];
            delete self.cacheTimestamps[moduleKey];
            delete self.moduleVersions[moduleKey];
            delete self.keyIndexes[moduleKey];
        }
        
        // 重置状态
        // Reset state
        delete self.moduleKeys;
        self.totalModules = 0;
        self.globalVersion = 0;
        
        emit CacheCleared(clearedCount, callerAddr);
    }
    
    /**
     * 分批清理缓存 - 分批清理模块缓存以避免Gas限制
     * Batch clear cache - Clear module caches in batches to avoid gas limits
     * @param self 缓存存储结构 Cache storage structure
     * @param batchSize 批次大小 Batch size
     * @param callerAddr 调用者地址 Caller address
     * @return 已清理数量 Number of cleared items
     */
    function clearCacheBatch(
        ModuleCacheStorage storage self,
        uint256 batchSize,
        address callerAddr
    ) internal returns (uint256) {
        // 访问控制检查
        // Access control check
        _checkAccessControl(self, "clearCacheBatch", callerAddr);
        
        if (batchSize == 0) {
            batchSize = DEFAULT_BATCH_SIZE;
        }
        
        uint256 totalModules = self.moduleKeys.length;
        uint256 clearedCount = 0;
        
        // 分批清理
        // Clear in batches
        for (uint256 i = 0; i < batchSize && i < totalModules; i++) {
            bytes32 moduleKey = self.moduleKeys[self.moduleKeys.length - 1];
            self.moduleKeys.pop();
            
            delete self.moduleAddresses[moduleKey];
            delete self.cacheTimestamps[moduleKey];
            delete self.moduleVersions[moduleKey];
            delete self.keyIndexes[moduleKey];
            
            clearedCount++;
        }
        
        self.totalModules -= clearedCount;
        
        emit CacheCleared(clearedCount, callerAddr);
        
        return clearedCount;
    }
    
    /**
     * 获取剩余待清理数量 - 获取还需要清理的模块数量
     * Get remaining items to clear - Get number of modules that still need to be cleared
     * @param self 缓存存储结构 Cache storage structure
     * @return 剩余数量 Remaining count
     */
    function getRemainingClearCount(ModuleCacheStorage storage self) internal view returns (uint256) {
        return self.moduleKeys.length;
    }

    /* ============ Internal Helper Functions ============ */
    
    /**
     * 访问控制检查 - 检查调用者是否有权限执行操作
     * Access control check - Check if caller has permission to perform operation
     * @param self 缓存存储结构 Cache storage structure
     * @param operation 操作类型 Operation type
     * @param callerAddr 调用者地址 Caller address
     */
    function _checkAccessControl(
        ModuleCacheStorage storage self,
        string memory operation,
        address callerAddr
    ) private view {
        if (self.accessController != address(0)) {
            // 这里实现具体的权限检查逻辑
            // Here implement specific permission check logic
            // 例如：检查调用者是否具有管理员权限
            // Example: Check if caller has admin permission
            // IRoleAccessControl(self.accessController).requireRole(ADMIN_ROLE, callerAddr);
            
            // 暂时使用简单的地址检查作为示例
            // Temporarily use simple address check as example
            if (callerAddr == address(0)) {
                revert ModuleCache__UnauthorizedOperation(operation, callerAddr);
            }
        }
    }
    
    /**
     * 验证索引一致性 - 验证totalModules与keyIndexes的一致性
     * Validate index consistency - Validate consistency between totalModules and keyIndexes
     * @param self 缓存存储结构 Cache storage structure
     * @return 是否一致 Whether consistent
     */
    function _validateIndexConsistency(ModuleCacheStorage storage self) internal view returns (bool) {
        uint256 actualCount = 0;
        for (uint256 i = 0; i < self.moduleKeys.length; i++) {
            if (self.moduleAddresses[self.moduleKeys[i]] != address(0)) {
                actualCount++;
            }
        }
        return actualCount == self.totalModules;
    }
} 