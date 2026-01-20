// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRegistryDynamicModuleKey
 * @notice External interface for the dynamic module-key registry.
 * @dev Reverts if:
 *      - (see the implementation for exact revert conditions)
 *
 * Security:
 * - Consumers must treat the configured address as a privileged module (admin-gated, pausable, upgradeable).
 * - This interface intentionally declares only functions (no events/errors) to avoid ABI drift and
 *   to support the "unified event library" rule in Architecture-Guide.md.
 */
interface IRegistryDynamicModuleKey {
    // ============ Module key registration ============

    /**
     * @notice Register a new dynamic module key.
     * @param name Human-readable module key name (implementation-defined normalization rules).
     * @return moduleKey Derived module key (bytes32).
     */
    function registerModuleKey(string calldata name) external returns (bytes32 moduleKey);

    /**
     * @notice Register multiple dynamic module keys in a single transaction.
     * @param names Human-readable module key names.
     * @return moduleKeys Derived module keys (same length as `names`).
     */
    function batchRegisterModuleKeys(string[] calldata names) external returns (bytes32[] memory moduleKeys);

    /**
     * @notice Unregister a dynamic module key.
     * @param moduleKey Module key to unregister.
     */
    function unregisterModuleKey(bytes32 moduleKey) external;

    // ============ Core dynamic module key functions ============

    /**
     * @notice Returns true if `moduleKey` is a registered dynamic module key.
     * @param moduleKey Module key to check.
     */
    function isDynamicModuleKey(bytes32 moduleKey) external view returns (bool);

    /**
     * @notice Returns true if `moduleKey` is valid (static or dynamic).
     * @param moduleKey Module key to check.
     */
    function isValidModuleKey(bytes32 moduleKey) external view returns (bool);

    /**
     * @notice Resolve a module key from a human-readable name.
     * @param name Human-readable module key name.
     * @return moduleKey Derived module key (bytes32).
     */
    function getModuleKeyByName(string calldata name) external view returns (bytes32 moduleKey);

    /**
     * @notice Resolve a human-readable name for a module key.
     * @param moduleKey Module key.
     * @return name Normalized name.
     */
    function getModuleKeyName(bytes32 moduleKey) external view returns (string memory name);

    // ============ Dynamic module key management ============

    /**
     * @notice Get all registered dynamic module keys.
     * @return keys Dynamic module keys array.
     */
    function getDynamicModuleKeys() external view returns (bytes32[] memory keys);
    
    /**
     * @notice Get total number of registered dynamic module keys.
     */
    function getDynamicKeyCount() external view returns (uint256);
    
    /**
     * @notice Get the stored (normalized) name for a dynamic module key.
     * @param moduleKey Module key.
     * @return name Name string.
     */
    function getDynamicModuleKeyName(bytes32 moduleKey) external view returns (string memory name);
    
    /**
     * @notice Resolve a module key from a normalized name hash.
     * @param nameHash keccak256 hash of the normalized name.
     * @return moduleKey Module key.
     */
    function getNameHashToModuleKey(bytes32 nameHash) external view returns (bytes32 moduleKey);
    
    /**
     * @notice Get the dynamic module key at a given index.
     * @param index 0-based index.
     * @return moduleKey Module key at index.
     */
    function getDynamicModuleKeyByIndex(uint256 index) external view returns (bytes32 moduleKey);

    // ============ Admin functions ============

    /**
     * @notice Get the current registration admin address.
     */
    function getRegistrationAdmin() external view returns (address);
    
    /**
     * @notice Get the current system admin address.
     */
    function getSystemAdmin() external view returns (address);
    
    /**
     * @notice Set the registration admin address.
     * @param newRegistrationAdmin New registration admin.
     */
    function setRegistrationAdmin(address newRegistrationAdmin) external;

    /**
     * @notice Set the system admin address.
     * @param newSystemAdmin New system admin.
     */
    function setSystemAdmin(address newSystemAdmin) external;

    /**
     * @notice Pause the module (admin-only in the implementation).
     */
    function pause() external;

    /**
     * @notice Unpause the module (admin-only in the implementation).
     */
    function unpause() external;
} 