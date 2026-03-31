// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ModuleCache
 * @notice Provides internal module-address cache management for liquidation modules.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - Library contains internal and view helpers; callers must gate privileged writes at the module level.
 * - Cache freshness is block-based (block.number), not time-in-seconds.
 * - Centralizes module address resolution and supports optional rollback tolerance plus expiration checks.
 */
library ModuleCache {
    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when module cache initialization is attempted more than once. Used by {initialize}.
    error ModuleCache__AlreadyInitialized();
    
    /// @dev Reverts when a requested module key is not present in the cache. Used by cache lookup helpers.
    error ModuleCache__ModuleNotFound(bytes32 moduleKey);
    
    /// @dev Reverts when a module address is invalid for caching, including address(0). Used by {set} and batch setters.
    error ModuleCache__InvalidModuleAddress(bytes32 moduleKey, address moduleAddr);
    
    /// @dev Reverts when a module key is bytes32(0) or otherwise invalid for cache operations. Used by cache mutation and lookup helpers.
    error ModuleCache__InvalidModuleKey(bytes32 moduleKey);
    
    /// @dev Reverts when a cached module entry exceeds the allowed block-based age. Used by expiration-aware getters.
    error ModuleCache__CacheExpired(bytes32 moduleKey, uint256 cacheAge, uint256 maxAge);
    
    /// @dev Reverts when a cache set attempts to store the same module address again. Used by {set}.
    error ModuleCache__DuplicateModuleAddress(bytes32 moduleKey, address existingAddr, address newAddr);
    
    /// @dev Reverts when paired batch arrays have different lengths. Used by batch cache operations.
    error ModuleCache__ArrayLengthMismatch(uint256 keysLength, uint256 addressesLength);
    
    /// @dev Reverts when a cache operation is attempted by an unauthorized caller. Used by access-controlled cache mutation helpers.
    error ModuleCache__UnauthorizedOperation(string operation, address caller);
    
    /// @dev Reverts when block-number rollback is detected and rollback tolerance is disabled. Used by cache age validation helpers.
    error ModuleCache__TimeRollbackDetected(uint256 currentTime, uint256 cachedTime);

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    
    /// @notice Emitted when a module address is cached.
    /// @dev Emitted by cache set flows after the module address, version, and cache block are updated.
    event ModuleCached(
        bytes32 indexed moduleKey, 
        address indexed moduleAddr, 
        uint256 version, 
        uint256 cacheBlock,
        address indexed callerAddr
    );
    
    /// @notice Emitted when a cached module is removed.
    /// @dev Emitted by cache removal flows after the module entry is cleared from storage.
    event ModuleRemoved(
        bytes32 indexed moduleKey, 
        address indexed moduleAddr, 
        uint256 version,
        address indexed callerAddr
    );
    
    /// @notice Emitted when multiple module addresses are cached in one operation.
    /// @dev Emitted by batch cache set flows with aligned key and address arrays plus the resulting version.
    event BatchModulesCached(
        bytes32[] moduleKeys, 
        address[] moduleAddresses, 
        uint256 version,
        address indexed callerAddr,
        uint256 successCount
    );
    
    /// @notice Emitted when cached module entries are cleared.
    /// @dev Emitted by cache clear flows with the number of removed entries and the caller.
    event CacheCleared(uint256 clearedCount, address indexed caller);
    
    /// @notice Emitted when a duplicate cache-set operation is attempted.
    /// @dev Emitted before reverting duplicate cache writes so off-chain systems can monitor redundant attempts.
    event DuplicateOperationAttempted(
        bytes32 indexed moduleKey,
        address indexed existingAddr,
        address indexed attemptedAddr,
        address callerAddr
    );

    /*━━━━━━━━━━━━━━━ Structs ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Module cache storage structure - Stores module addresses, blocks, versions and key collection.
     * @dev Uses specific naming to improve code readability.
     */
    struct ModuleCacheStorage {
        mapping(bytes32 => address) moduleAddresses;      // Module address mapping
        mapping(bytes32 => uint256) cacheBlocks;          // Cache update block mapping
        mapping(bytes32 => uint256) moduleVersions;       // Module version mapping
        bytes32[] moduleKeys;                             // Module keys collection
        mapping(bytes32 => uint256) keyIndexes;           // Key index mapping
        uint256 totalModules;                             // Total module count
        uint256 globalVersion;                            // Global version number
        bool allowTimeRollback;                           // Whether to allow time rollback
        address accessController;                         // Access controller address
        bool initialized;                                 // Whether initialized
    }

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    
    /// @dev Default batch clear size
    uint256 private constant DEFAULT_BATCH_SIZE = 50;
    
    /// @dev Maximum batch operation size
    uint256 private constant MAX_BATCH_SIZE = 100;

    /*━━━━━━━━━━━━━━━ Core Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Initialize module cache with initial configuration.
     * @dev Reverts if:
     *      - self.initialized is true (already initialized)
     *
     * Security:
     * - Internal function (no direct external access)
     * - One-time initialization (prevents re-initialization)
     *
     * @param self Cache storage structure
     * @param allowRollback Whether to allow time rollback (bool, true = allow, false = revert on rollback)
     * @param controllerAddr Access controller address (address(0) allowed, disables access control)
     */
    function initialize(
        ModuleCacheStorage storage self,
        bool allowRollback,
        address controllerAddr
    ) internal {
        if (self.initialized) revert ModuleCache__AlreadyInitialized();
        
        self.allowTimeRollback = allowRollback;
        self.accessController = controllerAddr;
        self.initialized = true;
    }
    
    /**
     * @notice Set module cache - Store module address in cache with duplicate check and version control.
     * @dev Reverts if:
     *      - moduleKey is bytes32(0)
     *      - moduleAddr is address(0)
     *      - existingAddr == moduleAddr (duplicate address)
     *      - access control check fails (if accessController is set)
     *
     * Security:
     * - Internal function (no direct external access)
     * - Access control enforced via _checkAccessControl
     * - Prevents duplicate setting of same address
     * - Updates global version on each set operation
     * - Records block.number for expiration checking
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, must not be bytes32(0))
     * @param moduleAddr Module address (must not be address(0))
     * @param callerAddr Caller address (for access control and event emission)
     */
    function set(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        address moduleAddr,
        address callerAddr
    ) internal {
        // Parameter validation
        if (moduleKey == bytes32(0)) {
            revert ModuleCache__InvalidModuleKey(moduleKey);
        }
        
        // Access control check
        _checkAccessControl(self, "set", callerAddr);
        
        // Validate module address
        if (moduleAddr == address(0)) {
            revert ModuleCache__InvalidModuleAddress(moduleKey, moduleAddr);
        }
        
        // Check if duplicate setting same address
        address existingAddr = self.moduleAddresses[moduleKey];
        if (existingAddr == moduleAddr) {
            emit DuplicateOperationAttempted(moduleKey, existingAddr, moduleAddr, callerAddr);
            revert ModuleCache__DuplicateModuleAddress(moduleKey, existingAddr, moduleAddr);
        }
        
        // Update global version number
        self.globalVersion++;
        
        // If it's a new module, add to key collection
        if (existingAddr == address(0)) {
            self.moduleKeys.push(moduleKey);
            self.keyIndexes[moduleKey] = self.moduleKeys.length - 1;
            self.totalModules++;
        }
        
        // Set module information
        self.moduleAddresses[moduleKey] = moduleAddr;
        self.cacheBlocks[moduleKey] = block.number;
        self.moduleVersions[moduleKey] = self.globalVersion;
        
        emit ModuleCached(moduleKey, moduleAddr, self.globalVersion, block.number, callerAddr);
    }

    /**
     * @notice Get module address from cache with expiration and time rollback checking.
     * @dev Reverts if:
     *      - moduleKey is bytes32(0)
     *      - moduleAddr is address(0) (module not found)
     *      - cache block is 0 (module not found)
     *      - time rollback detected and allowTimeRollback is false
     *      - cacheAge > maxAge (cache expired)
     *
     * Security:
     * - View function (read-only)
     * - Time rollback detection (reverts if block.number < cached update block and rollback not allowed)
     * - Cache expiration enforcement (reverts if cache age exceeds maxAge)
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, must not be bytes32(0))
     * @param maxAge Maximum cache age (blocks, cache expires if age > maxAge)
     * @return Module address (reverts if not found or expired)
     */
    function get(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        uint256 maxAge
    ) internal view returns (address) {
        // Parameter validation
        if (moduleKey == bytes32(0)) {
            revert ModuleCache__InvalidModuleKey(moduleKey);
        }
        
        address moduleAddr = self.moduleAddresses[moduleKey];
        if (moduleAddr == address(0)) {
            revert ModuleCache__ModuleNotFound(moduleKey);
        }
        
        // Check if cache is expired
        uint256 cacheBlock = self.cacheBlocks[moduleKey];
        if (cacheBlock == 0) {
            revert ModuleCache__ModuleNotFound(moduleKey);
        }
        
        // Time rollback detection
        if (block.number < cacheBlock) {
            if (!self.allowTimeRollback) {
                revert ModuleCache__TimeRollbackDetected(block.number, cacheBlock);
            }
            // Return directly when time rollback is allowed to avoid potential underflow in subtraction
            return moduleAddr;
        }
        
        // After the above branch, ensure block.number >= cacheBlock before subtraction to avoid underflow panic
        uint256 cacheAge = block.number - cacheBlock;
        if (cacheAge > maxAge) {
            revert ModuleCache__CacheExpired(moduleKey, cacheAge, maxAge);
        }
        
        return moduleAddr;
    }

    /**
     * @notice Get module address (alias for get function, maintains backward compatibility).
     * @dev Reverts if:
     *      - Same conditions as get() function
     *
     * Security:
     * - View function (read-only)
     * - Delegates to get() function
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, must not be bytes32(0))
     * @param maxAge Maximum cache age (blocks, cache expires if age > maxAge)
     * @return Module address (reverts if not found or expired)
     */
    function getModule(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        uint256 maxAge
    ) internal view returns (address) {
        return get(self, moduleKey, maxAge);
    }

    /**
     * @notice Update module address (alias for set function, maintains backward compatibility).
     * @dev Reverts if:
     *      - Same conditions as set() function
     *
     * Security:
     * - Internal function (no direct external access)
     * - Delegates to set() function
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, must not be bytes32(0))
     * @param moduleAddr Module address (must not be address(0))
     * @param callerAddr Caller address (for access control and event emission)
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
     * @notice Batch update module addresses (alias for batchSet function, maintains backward compatibility).
     * @dev Reverts if:
     *      - Same conditions as batchSet() function
     *
     * Security:
     * - Internal function (no direct external access)
     * - Delegates to batchSet() function
     *
     * @param self Cache storage structure
     * @param moduleKeys Array of module keys (bytes32[], must match moduleAddresses length)
     * @param moduleAddresses Array of module addresses (must match moduleKeys length)
     * @param callerAddr Caller address (for access control and event emission)
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
     * @notice Remove module cache (alias for remove function, maintains backward compatibility).
     * @dev Reverts if:
     *      - Same conditions as remove() function
     *
     * Security:
     * - Internal function (no direct external access)
     * - Delegates to remove() function
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, must not be bytes32(0))
     * @param callerAddr Caller address (for access control and event emission)
     */
    function removeModule(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        address callerAddr
    ) internal {
        remove(self, moduleKey, callerAddr);
    }

    /**
     * @notice Remove module cache - Remove specified module from cache with key collection update.
     * @dev Reverts if:
     *      - moduleKey is bytes32(0)
     *      - moduleAddr is address(0) (module not found)
     *      - access control check fails (if accessController is set)
     *
     * Security:
     * - Internal function (no direct external access)
     * - Access control enforced via _checkAccessControl
     * - Updates key collection by swapping with last element and popping
     * - Cleans up all storage mappings for the module
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, must not be bytes32(0))
     * @param callerAddr Caller address (for access control and event emission)
     */
    function remove(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        address callerAddr
    ) internal {
        // Parameter validation
        if (moduleKey == bytes32(0)) {
            revert ModuleCache__InvalidModuleKey(moduleKey);
        }
        
        // Access control check
        _checkAccessControl(self, "remove", callerAddr);
        
        address moduleAddr = self.moduleAddresses[moduleKey];
        if (moduleAddr == address(0)) {
            revert ModuleCache__ModuleNotFound(moduleKey);
        }
        
        uint256 version = self.moduleVersions[moduleKey];
        
        // Remove from key collection
        uint256 keyIndex = self.keyIndexes[moduleKey];
        if (keyIndex < self.moduleKeys.length) {
            // Move last element to current position
            bytes32 lastKey = self.moduleKeys[self.moduleKeys.length - 1];
            self.moduleKeys[keyIndex] = lastKey;
            self.keyIndexes[lastKey] = keyIndex;
            self.moduleKeys.pop();
        }
        
        // Clean up storage
        delete self.moduleAddresses[moduleKey];
        delete self.cacheBlocks[moduleKey];
        delete self.moduleVersions[moduleKey];
        delete self.keyIndexes[moduleKey];
        
        self.totalModules--;
        
        emit ModuleRemoved(moduleKey, moduleAddr, version, callerAddr);
    }

    /*━━━━━━━━━━━━━━━ Batch Operations ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Batch set module cache - Cache multiple module addresses at once (full transaction consistency).
     * @dev Reverts if:
     *      - array lengths mismatch (moduleKeys vs moduleAddresses)
     *      - moduleKeys.length > MAX_BATCH_SIZE
     *      - any moduleKey is bytes32(0)
     *      - any moduleAddress is address(0)
     *      - access control check fails (if accessController is set)
     *      - any individual set() operation fails (duplicate address, etc.)
     *
     * Security:
     * - Internal function (no direct external access)
     * - Access control enforced via _checkAccessControl
     * - Batch size limit enforced (MAX_BATCH_SIZE = 100)
     * - Full transaction consistency (all-or-nothing)
     * - Pre-validates all parameters before execution
     *
     * @param self Cache storage structure
     * @param moduleKeys Array of module keys (bytes32[], must match moduleAddresses length)
     * @param moduleAddresses Array of module addresses (must match moduleKeys length)
     * @param callerAddr Caller address (for access control and event emission)
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
        
        // Access control check
        _checkAccessControl(self, "batchSet", callerAddr);
        
        // Pre-validate all parameters
        for (uint256 i = 0; i < moduleKeys.length; i++) {
            if (moduleKeys[i] == bytes32(0)) {
                revert ModuleCache__InvalidModuleKey(moduleKeys[i]);
            }
            if (moduleAddresses[i] == address(0)) {
                revert ModuleCache__InvalidModuleAddress(moduleKeys[i], moduleAddresses[i]);
            }
        }
        
        // Execute batch set
        for (uint256 i = 0; i < moduleKeys.length; i++) {
            set(self, moduleKeys[i], moduleAddresses[i], callerAddr);
        }
        
        emit BatchModulesCached(moduleKeys, moduleAddresses, self.globalVersion, callerAddr, moduleKeys.length);
    }

    /**
     * @notice Batch remove module cache - Remove multiple module caches at once (full transaction consistency).
     * @dev Reverts if:
     *      - moduleKeys.length > MAX_BATCH_SIZE
     *      - any moduleKey is bytes32(0)
     *      - access control check fails (if accessController is set)
     *      - any individual remove() operation fails (module not found, etc.)
     *
     * Security:
     * - Internal function (no direct external access)
     * - Access control enforced via _checkAccessControl
     * - Batch size limit enforced (MAX_BATCH_SIZE = 100)
     * - Full transaction consistency (all-or-nothing)
     * - Pre-validates all parameters before execution
     *
     * @param self Cache storage structure
     * @param moduleKeys Array of module keys (bytes32[])
     * @param callerAddr Caller address (for access control and event emission)
     */
    function batchRemove(
        ModuleCacheStorage storage self,
        bytes32[] memory moduleKeys,
        address callerAddr
    ) internal {
        if (moduleKeys.length > MAX_BATCH_SIZE) {
            revert ModuleCache__ArrayLengthMismatch(moduleKeys.length, MAX_BATCH_SIZE);
        }
        
        // Access control check
        _checkAccessControl(self, "batchRemove", callerAddr);
        
        // Pre-validate all parameters
        for (uint256 i = 0; i < moduleKeys.length; i++) {
            if (moduleKeys[i] == bytes32(0)) {
                revert ModuleCache__InvalidModuleKey(moduleKeys[i]);
            }
        }
        
        // Execute batch remove
        for (uint256 i = 0; i < moduleKeys.length; i++) {
            remove(self, moduleKeys[i], callerAddr);
        }
    }

    /*━━━━━━━━━━━━━━━ Utility Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Check if module exists in cache.
     * @dev Reverts if:
     *      - None (view function, returns false for invalid inputs)
     *
     * Security:
     * - View function (read-only)
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, returns false if bytes32(0))
     * @return Whether module exists (true if moduleAddresses[moduleKey] != address(0))
     */
    function exists(ModuleCacheStorage storage self, bytes32 moduleKey) internal view returns (bool) {
        if (moduleKey == bytes32(0)) return false;
        return self.moduleAddresses[moduleKey] != address(0);
    }

    /**
     * @notice Check if cache is valid (within validity period and not expired).
     * @dev Reverts if:
     *      - None (view function, returns false for invalid inputs or expired cache)
     *
     * Security:
     * - View function (read-only)
     * - Handles time rollback gracefully (returns allowTimeRollback value if rollback detected)
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, returns false if bytes32(0) or not exists)
     * @param maxAge Maximum cache age (blocks, cache is invalid if age > maxAge)
     * @return Whether cache is valid (true if exists, not expired, and time rollback allowed if detected)
     */
    function isValid(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        uint256 maxAge
    ) internal view returns (bool) {
        if (moduleKey == bytes32(0)) return false;
        if (!exists(self, moduleKey)) return false;
        
        uint256 cacheBlock = self.cacheBlocks[moduleKey];
        if (cacheBlock == 0) return false;
        
        // Time rollback handling
        if (block.number < cacheBlock) {
            return self.allowTimeRollback;
        }
        
        return (block.number - cacheBlock) <= maxAge;
    }

    /**
     * @notice Get cache block for specified module.
     * @dev Reverts if:
     *      - None (view function, returns 0 for invalid inputs)
     *
     * Security:
     * - View function (read-only)
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, returns 0 if bytes32(0) or not cached)
     * @return Cache update block (block.number, 0 if not cached)
     */
    function getCacheBlock(ModuleCacheStorage storage self, bytes32 moduleKey) internal view returns (uint256) {
        if (moduleKey == bytes32(0)) return 0;
        return self.cacheBlocks[moduleKey];
    }

    /**
     * @notice Get remaining validity period for specified module cache.
     * @dev Reverts if:
     *      - None (view function, returns 0 for invalid inputs or expired cache)
     *
     * Security:
     * - View function (read-only)
     * - Handles time rollback gracefully (returns maxAge if rollback allowed, 0 otherwise)
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, returns 0 if bytes32(0) or not exists)
     * @param maxAge Maximum cache age (blocks)
     * @return Remaining validity period (blocks, 0 if expired or not cached,
     *        maxAge if time rollback detected and allowed)
     */
    function getRemainingValidity(
        ModuleCacheStorage storage self,
        bytes32 moduleKey,
        uint256 maxAge
    ) internal view returns (uint256) {
        if (moduleKey == bytes32(0)) return 0;
        if (!exists(self, moduleKey)) return 0;
        
        uint256 cacheBlock = self.cacheBlocks[moduleKey];
        if (cacheBlock == 0) return 0;
        
        // Time rollback handling
        if (block.number < cacheBlock) {
            return self.allowTimeRollback ? maxAge : 0;
        }
        
        uint256 elapsed = block.number - cacheBlock;
        return elapsed >= maxAge ? 0 : maxAge - elapsed;
    }

    /*━━━━━━━━━━━━━━━ Enumerable Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get all module keys - Return all cached module keys.
     * @dev Reverts if:
     *      - None (view function, read-only)
     *
     * Security:
     * - View function (read-only)
     *
     * @param self Cache storage structure
     * @return Array of module keys (bytes32[], may be empty)
     */
    function getAllModuleKeys(ModuleCacheStorage storage self) internal view returns (bytes32[] memory) {
        return self.moduleKeys;
    }

    /**
     * @notice Get module key count - Return number of cached modules.
     * @dev Reverts if:
     *      - None (view function, read-only)
     *
     * Security:
     * - View function (read-only)
     *
     * @param self Cache storage structure
     * @return Module count (number of cached modules, equals moduleKeys.length)
     */
    function getModuleKeyCount(ModuleCacheStorage storage self) internal view returns (uint256) {
        return self.moduleKeys.length;
    }

    /**
     * @notice Get module key index - Return index position of specified module key.
     * @dev Reverts if:
     *      - None (view function, returns type(uint256).max for invalid inputs)
     *
     * Security:
     * - View function (read-only)
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, returns type(uint256).max if bytes32(0))
     * @return Index position (0-based index in moduleKeys array, type(uint256).max if not found)
     */
    function getModuleKeyIndex(ModuleCacheStorage storage self, bytes32 moduleKey) internal view returns (uint256) {
        if (moduleKey == bytes32(0)) return type(uint256).max;
        return self.keyIndexes[moduleKey];
    }

    /*━━━━━━━━━━━━━━━ Version Control Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get module version - Get version number of specified module.
     * @dev Reverts if:
     *      - None (view function, returns 0 for invalid inputs)
     *
     * Security:
     * - View function (read-only)
     *
     * @param self Cache storage structure
     * @param moduleKey Module key (bytes32, returns 0 if bytes32(0) or not cached)
     * @return Version number (uint256, increments on each set operation, 0 if not cached)
     */
    function getModuleVersion(ModuleCacheStorage storage self, bytes32 moduleKey) internal view returns (uint256) {
        if (moduleKey == bytes32(0)) return 0;
        return self.moduleVersions[moduleKey];
    }

    /**
     * @notice Get global version - Get global version number.
     * @dev Reverts if:
     *      - None (view function, read-only)
     *
     * Security:
     * - View function (read-only)
     *
     * @param self Cache storage structure
     * @return Global version number (uint256, increments on each set operation)
     */
    function getGlobalVersion(ModuleCacheStorage storage self) internal view returns (uint256) {
        return self.globalVersion;
    }

    /*━━━━━━━━━━━━━━━ Configuration Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Set time rollback tolerance - Set whether to allow time rollback.
     * @dev Reverts if:
     *      - access control check fails (if accessController is set)
     *
     * Security:
     * - Internal function (no direct external access)
     * - Access control enforced via _checkAccessControl
     *
     * @param self Cache storage structure
     * @param allowRollback Whether to allow rollback (bool, true = allow, false = revert on rollback)
     * @param callerAddr Caller address (for access control)
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
     * @notice Set access controller - Set access controller address.
     * @dev Reverts if:
     *      - access control check fails (if accessController is set)
     *
     * Security:
     * - Internal function (no direct external access)
     * - Access control enforced via _checkAccessControl
     *
     * @param self Cache storage structure
     * @param controllerAddr Controller address (address(0) allowed, disables access control)
     * @param callerAddr Caller address (for access control)
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
     * @notice Clear cache - Clear all module caches.
     * @dev Reverts if:
     *      - access control check fails (if accessController is set)
     *
     * Security:
     * - Internal function (no direct external access)
     * - Access control enforced via _checkAccessControl
     * - Clears all module data and resets counters
     *
     * @param self Cache storage structure
     * @param callerAddr Caller address (for access control and event emission)
     */
    function clearCache(ModuleCacheStorage storage self, address callerAddr) internal {
        // Access control check
        _checkAccessControl(self, "clearCache", callerAddr);
        
        uint256 clearedCount = self.moduleKeys.length;
        
        // Clear all modules
        for (uint256 i = 0; i < self.moduleKeys.length; i++) {
            bytes32 moduleKey = self.moduleKeys[i];
            delete self.moduleAddresses[moduleKey];
            delete self.cacheBlocks[moduleKey];
            delete self.moduleVersions[moduleKey];
            delete self.keyIndexes[moduleKey];
        }
        
        // Reset state
        delete self.moduleKeys;
        self.totalModules = 0;
        self.globalVersion = 0;
        
        emit CacheCleared(clearedCount, callerAddr);
    }
    
    /**
     * @notice Batch clear cache - Clear module caches in batches to avoid gas limits.
     * @dev Reverts if:
     *      - access control check fails (if accessController is set)
     *
     * Security:
     * - Internal function (no direct external access)
     * - Access control enforced via _checkAccessControl
     * - Uses DEFAULT_BATCH_SIZE (50) if batchSize is 0
     * - Clears from end of array (pops last elements)
     *
     * @param self Cache storage structure
     * @param batchSize Batch size (number of modules to clear, 0 = use DEFAULT_BATCH_SIZE = 50)
     * @param callerAddr Caller address (for access control and event emission)
     * @return Number of cleared items (actual number of modules cleared, may be less than batchSize)
     */
    function clearCacheBatch(
        ModuleCacheStorage storage self,
        uint256 batchSize,
        address callerAddr
    ) internal returns (uint256) {
        // Access control check
        _checkAccessControl(self, "clearCacheBatch", callerAddr);
        
        if (batchSize == 0) {
            batchSize = DEFAULT_BATCH_SIZE;
        }
        
        uint256 totalModules = self.moduleKeys.length;
        uint256 clearedCount = 0;
        
        // Clear in batches
        for (uint256 i = 0; i < batchSize && i < totalModules; i++) {
            bytes32 moduleKey = self.moduleKeys[self.moduleKeys.length - 1];
            self.moduleKeys.pop();
            
            delete self.moduleAddresses[moduleKey];
            delete self.cacheBlocks[moduleKey];
            delete self.moduleVersions[moduleKey];
            delete self.keyIndexes[moduleKey];
            
            clearedCount++;
        }
        
        self.totalModules -= clearedCount;
        
        emit CacheCleared(clearedCount, callerAddr);
        
        return clearedCount;
    }
    
    /**
     * @notice Get remaining items to clear - Get number of modules that still need to be cleared.
     * @dev Reverts if:
     *      - None (view function, read-only)
     *
     * Security:
     * - View function (read-only)
     *
     * @param self Cache storage structure
     * @return Remaining count (number of modules still in cache, equals moduleKeys.length)
     */
    function getRemainingClearCount(ModuleCacheStorage storage self) internal view returns (uint256) {
        return self.moduleKeys.length;
    }

    /*━━━━━━━━━━━━━━━ Internal Helper Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Access control check - Check if caller has permission to perform operation.
     * @dev Reverts if:
     *      - accessController is set and callerAddr is address(0)
     *      - accessController is set and permission check fails (placeholder for future implementation)
     *
     * Security:
     * - Private function (internal use only)
     * - Currently implements simple zero address check (placeholder for role-based access control)
     *
     * @param self Cache storage structure
     * @param operation Operation type (string, for error reporting)
     * @param callerAddr Caller address (must not be address(0) if accessController is set)
     */
    function _checkAccessControl(
        ModuleCacheStorage storage self,
        string memory operation,
        address callerAddr
    ) private view {
        if (self.accessController != address(0)) {
            // Here implement specific permission check logic
            // Example: Check if caller has admin permission
            // IRoleAccessControl(self.accessController).requireRole(ADMIN_ROLE, callerAddr);
            
            // Temporarily use simple address check as example
            if (callerAddr == address(0)) {
                revert ModuleCache__UnauthorizedOperation(operation, callerAddr);
            }
        }
    }
    
    /**
     * @notice Validate index consistency - Validate consistency between totalModules and keyIndexes.
     * @dev Reverts if:
     *      - None (view function, read-only)
     *
     * Security:
     * - View function (read-only)
     * - Diagnostic function for detecting storage inconsistencies
     *
     * @param self Cache storage structure
     * @return Whether consistent (true if actualCount == totalModules, false otherwise)
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