// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ZeroAddress, EmptyArray, IndexOutOfBounds} from "../errors/StandardErrors.sol";
import {RegistryEvents} from "./RegistryEventsLibrary.sol";

/**
 * @title RegistryDynamicModuleKey
 * @notice Dynamic module key registry for registering new module keys on-chain.
 * @dev Reverts if:
 *      - (see individual functions)
 *
 * Security:
 * - UUPS upgrade authorization is owner-gated (onlyOwner)
 * - Module key registration is role-gated (registrationAdmin / systemAdmin) and pause-aware (whenNotPaused)
 * - Names are normalized/validated before deriving keys to prevent ambiguity
 */
contract RegistryDynamicModuleKey is 
    Initializable, 
    OwnableUpgradeable, 
    UUPSUpgradeable,
    PausableUpgradeable
{
    // ============ Custom Errors ============
    /**
     * @notice The derived module key already exists.
     * @param moduleKey The existing module key.
     */
    error RegistryDynamicModuleKey__ModuleKeyAlreadyExists(bytes32 moduleKey);
    /**
     * @notice The module key does not exist.
     * @param moduleKey The missing module key.
     */
    error RegistryDynamicModuleKey__ModuleKeyNotExists(bytes32 moduleKey);
    /**
     * @notice The module name does not exist.
     * @param nameHash The keccak256 hash of the normalized name.
     */
    error RegistryDynamicModuleKey__ModuleNameNotExists(bytes32 nameHash);
    /**
     * @notice The module key name is invalid (e.g., length constraints).
     */
    error RegistryDynamicModuleKey__InvalidModuleKeyName();
    /**
     * @notice The dynamic module key limit would be exceeded.
     * @param current Current number of registered dynamic keys.
     * @param limit Maximum allowed number of dynamic keys.
     */
    error RegistryDynamicModuleKey__ModuleKeyLimitExceeded(uint256 current, uint256 limit);
    /**
     * @notice The batch size limit would be exceeded.
     * @param batchSize Provided batch size.
     * @param limit Maximum allowed batch size.
     */
    error RegistryDynamicModuleKey__BatchSizeLimitExceeded(uint256 batchSize, uint256 limit);
    /**
     * @notice Caller is not the registration admin.
     */
    error RegistryDynamicModuleKey__OnlyRegistrationAdmin();
    /**
     * @notice Caller is not the system admin.
     */
    error RegistryDynamicModuleKey__OnlySystemAdmin();
    /**
     * @notice The name contains an invalid character.
     * @param position The 0-based byte position of the first invalid character.
     */
    error RegistryDynamicModuleKey__InvalidCharacterInName(uint256 position);

    // ============ Constants ============
    uint256 private constant _MAX_DYNAMIC_KEYS = 100; // Max dynamic module keys.
    uint256 private constant _MIN_NAME_LENGTH = 3; // Min module key name length (bytes).
    uint256 private constant _MAX_NAME_LENGTH = 50; // Max module key name length (bytes).
    uint256 private constant _MAX_BATCH_SIZE = 20; // Max batch registration size.
    /// @notice Salt used to derive dynamic module keys.
    // NOTE: Keep this exact string for backwards-compatible key derivation.
    // solhint-disable-next-line gas-small-strings
    bytes32 private constant _MODULE_KEY_SALT = keccak256("rwa.registry.dynamic.module.key.v1");

    // ============ State Variables ============
    /// @notice Registration admin address.
    address private _registrationAdminAddr;
    /// @notice System admin address.
    address private _systemAdminAddr;
    
    /// @notice Dynamic module key membership.
    mapping(bytes32 => bool) private _dynamicModuleKeys;
    /// @notice Module key => normalized name.
    mapping(bytes32 => string) private _moduleKeyNames;
    /// @notice nameHash (keccak256(normalizedName)) => moduleKey.
    mapping(bytes32 => bytes32) private _nameHashToModuleKey;
    
    /// @notice Dynamic module key list.
    bytes32[] private _dynamicModuleKeyList;
    /// @notice Index mapping (index + 1; 0 means not present).
    mapping(bytes32 => uint256) private _keyIndexPlus1;

    // ============ Modifiers ============
    /// @notice Only registration admin can call.
    modifier onlyRegistrationAdmin() {
        if (msg.sender != _registrationAdminAddr) revert RegistryDynamicModuleKey__OnlyRegistrationAdmin();
        _;
    }

    /// @notice Only system admin can call.
    modifier onlySystemAdmin() {
        if (msg.sender != _systemAdminAddr) revert RegistryDynamicModuleKey__OnlySystemAdmin();
        _;
    }

    // ============ Constructor ============
    /**
     * @notice Constructs the implementation contract and disables initializers.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Disables Initializable initializers on the implementation instance
     *
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /**
     * @notice Initializes the dynamic module key registry and configures admin roles.
     * @dev Reverts if:
     *      - initialRegistrationAdmin == address(0)
     *      - initialSystemAdmin == address(0)
     *      - initialOwner == address(0)
     *
     * Security:
     * - Single-use initializer (Initializable)
     * - Sets owner/admin roles explicitly (not msg.sender)
     *
     * @param initialRegistrationAdmin Registration admin address (registerModuleKey/batchRegisterModuleKeys).
     * @param initialSystemAdmin System admin address (unregisterModuleKey).
     * @param initialOwner Contract owner address (UUPS upgrades and admin role updates).
     */
    function initialize(
        address initialRegistrationAdmin,
        address initialSystemAdmin,
        address initialOwner
    ) external initializer {
        if (initialRegistrationAdmin == address(0)) revert ZeroAddress();
        if (initialSystemAdmin == address(0)) revert ZeroAddress();
        if (initialOwner == address(0)) revert ZeroAddress();
        
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __Pausable_init();
        
        _registrationAdminAddr = initialRegistrationAdmin;
        _systemAdminAddr = initialSystemAdmin;
        
        emit RegistryEvents.RegistrationAdminChanged(address(0), initialRegistrationAdmin);
        emit RegistryEvents.SystemAdminChanged(address(0), initialSystemAdmin);
    }

    // ============ UUPS Upgrade Authorization ============
    /**
     * @notice Authorizes a UUPS upgrade to a new implementation.
     * @dev Reverts if:
     *      - msg.sender is not owner
     *      - newImplementation == address(0)
     *
     * Security:
     * - UUPS upgrade gate (UUPSUpgradeable)
     * - onlyOwner
     *
     * @param newImplementation The new implementation address.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ============ Internal Helper Functions ============
    
    /**
     * @notice Normalizes and validates a module key name.
     * @dev Reverts if:
     *      - normalized length is < _MIN_NAME_LENGTH or > _MAX_NAME_LENGTH
     *      - name contains characters outside [a-z0-9_-] after normalization
     *
     * Security:
     * - Pure helper; input validation only
     *
     * @param name Raw input name.
     * @return normalizedName Normalized name (trimmed, lowercased).
     * @return nameHash keccak256 hash of normalizedName.
     */
    function _normalizeAndValidate(string memory name)
        internal
        pure
        returns (string memory normalizedName, bytes32 nameHash)
    {
        bytes memory nameBytes = bytes(name);
        uint256 start = 0;
        uint256 end = nameBytes.length;
        while (start < end && nameBytes[start] == 0x20) { start++; }
        while (end > start && nameBytes[end - 1] == 0x20) { end--; }
        uint256 length = end - start;
        if (length < _MIN_NAME_LENGTH || length > _MAX_NAME_LENGTH) {
            revert RegistryDynamicModuleKey__InvalidModuleKeyName();
        }
        bytes memory normalizedBytes = new bytes(length);
        uint256 invalidPos = type(uint256).max;
        for (uint256 i = 0; i < length; ) {
            uint8 c = uint8(nameBytes[start + i]);
            if (c >= 65 && c <= 90) { c = c + 32; }
            bool ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c == 95) || (c == 45);
            if (!ok && invalidPos == type(uint256).max) { invalidPos = i; }
            normalizedBytes[i] = bytes1(c);
            unchecked { ++i; }
        }
        normalizedName = string(normalizedBytes);
        if (invalidPos != type(uint256).max) {
            revert RegistryDynamicModuleKey__InvalidCharacterInName(invalidPos);
        }
        nameHash = keccak256(abi.encodePacked(normalizedName));
    }

    /**
     * @notice Generates a module key for a normalized name.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Pure helper
     *
     * @param name Normalized module key name.
     * @return moduleKey Derived module key.
     */
    function _generateModuleKey(string memory name) internal pure returns (bytes32 moduleKey) {
        // Use fixed salt + encodePacked to avoid concatenation ambiguity and save gas.
        moduleKey = keccak256(abi.encodePacked(_MODULE_KEY_SALT, name));
    }

    // ============ Module Key Registration ============
    
    /**
     * @notice Registers a new dynamic module key from a human-readable name.
     * @dev Reverts if:
     *      - msg.sender is not registrationAdmin
     *      - RegistryDynamicModuleKey is paused
     *      - name is invalid (length/charset; see _normalizeAndValidate)
     *      - normalized name already exists
     *      - derived moduleKey already exists
     *      - _MAX_DYNAMIC_KEYS would be exceeded
     *
     * Security:
     * - onlyRegistrationAdmin
     * - whenNotPaused
     *
     * @param name Module key name (will be normalized; ASCII [a-z0-9_-] after normalization).
     * @return moduleKey The newly registered module key.
     */
    function registerModuleKey(string calldata name)
        external
        onlyRegistrationAdmin
        whenNotPaused
        returns (bytes32 moduleKey)
    {
        return _registerModuleKeyCalldata(name);
    }

    /**
     * @notice Internal calldata-based registration helper.
     * @dev Reverts if:
     *      - normalized name already exists
     *      - derived moduleKey already exists
     *      - name is invalid (length/charset; see _normalizeAndValidate)
     *      - _MAX_DYNAMIC_KEYS would be exceeded
     *
     * Security:
     * - Must be called from a role-gated external entrypoint
     *
     * @param name Module key name (calldata).
     * @return moduleKey The newly registered module key.
     */
    function _registerModuleKeyCalldata(string calldata name) internal returns (bytes32 moduleKey) {
        // Normalize and validate name (single pass).
        (string memory normalizedName, bytes32 nameHash) = _normalizeAndValidate(name);
        
        // Ensure normalized name isn't already registered.
        bytes32 existingKey = _nameHashToModuleKey[nameHash];
        if (existingKey != bytes32(0)) {
            revert RegistryDynamicModuleKey__ModuleKeyAlreadyExists(existingKey);
        }
        
        // Enforce registry cap.
        if (_dynamicModuleKeyList.length >= _MAX_DYNAMIC_KEYS) {
            revert RegistryDynamicModuleKey__ModuleKeyLimitExceeded(_dynamicModuleKeyList.length, _MAX_DYNAMIC_KEYS);
        }
        
        // Derive module key.
        moduleKey = _generateModuleKey(normalizedName);
        
        // Ensure derived key isn't already registered.
        if (_dynamicModuleKeys[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyAlreadyExists(moduleKey);
        }
        
        // Register.
        _dynamicModuleKeys[moduleKey] = true;
        _moduleKeyNames[moduleKey] = normalizedName;
        _nameHashToModuleKey[nameHash] = moduleKey;
        _dynamicModuleKeyList.push(moduleKey);
        _keyIndexPlus1[moduleKey] = _dynamicModuleKeyList.length; // Record position (index+1).
        
        emit RegistryEvents.ModuleKeyRegistered(moduleKey, nameHash, msg.sender);
    }

    /**
     * @notice Batch registers dynamic module keys.
     * @dev Reverts if:
     *      - msg.sender is not registrationAdmin
     *      - RegistryDynamicModuleKey is paused
     *      - names.length == 0
     *      - names.length > _MAX_BATCH_SIZE
     *      - _MAX_DYNAMIC_KEYS would be exceeded
     *      - any name is invalid or already registered (the entire call reverts)
     *
     * Security:
     * - onlyRegistrationAdmin
     * - whenNotPaused
     *
     * @param names Module key names to register.
     * @return moduleKeys Derived module keys (aligned with names).
     */
    function batchRegisterModuleKeys(string[] calldata names)
        external
        onlyRegistrationAdmin
        whenNotPaused
        returns (bytes32[] memory moduleKeys)
    {
        uint256 len = names.length;
        if (len == 0) revert EmptyArray();
        if (len > _MAX_BATCH_SIZE) {
            revert RegistryDynamicModuleKey__BatchSizeLimitExceeded(len, _MAX_BATCH_SIZE);
        }
        uint256 current = _dynamicModuleKeyList.length;
        if (len + current > _MAX_DYNAMIC_KEYS) {
            revert RegistryDynamicModuleKey__ModuleKeyLimitExceeded(len + current, _MAX_DYNAMIC_KEYS);
        }
        moduleKeys = new bytes32[](len);
        for (uint256 i = 0; i < len; ) {
            moduleKeys[i] = _registerModuleKeyCalldata(names[i]);
            unchecked { ++i; }
        }
    }

    /**
     * @notice Removes a module key from the internal list (swap-and-pop).
     * @dev Reverts if:
     *      - (none) (returns false if key not found)
     *
     * Security:
     * - Private helper; mutates storage
     *
     * @param moduleKey The module key to remove.
     * @return found True if the key was found and removed.
     */
    function _removeFromList(bytes32 moduleKey) private returns (bool found) {
        uint256 idxPlus1 = _keyIndexPlus1[moduleKey];
        if (idxPlus1 == 0) {
            return false;
        }
        uint256 idx = idxPlus1 - 1;
        uint256 last = _dynamicModuleKeyList.length - 1;
        if (idx != last) {
            bytes32 lastKey = _dynamicModuleKeyList[last];
            _dynamicModuleKeyList[idx] = lastKey;
            _keyIndexPlus1[lastKey] = idx + 1;
        }
        _dynamicModuleKeyList.pop();
        delete _keyIndexPlus1[moduleKey];
        return true;
    }

    /**
     * @notice Unregisters an existing dynamic module key.
     * @dev Reverts if:
     *      - msg.sender is not systemAdmin
     *      - RegistryDynamicModuleKey is paused
     *      - moduleKey does not exist
     *
     * Security:
     * - onlySystemAdmin
     * - whenNotPaused
     *
     * @param moduleKey The module key to unregister.
     */
    function unregisterModuleKey(bytes32 moduleKey) external onlySystemAdmin whenNotPaused {
        if (!_dynamicModuleKeys[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        
        string memory name = _moduleKeyNames[moduleKey];
        bytes32 nameHash = keccak256(abi.encodePacked(name));
        
        // Clear mappings.
        delete _dynamicModuleKeys[moduleKey];
        delete _moduleKeyNames[moduleKey];
        delete _nameHashToModuleKey[nameHash];
        
        // Remove from list using swap-and-pop helper.
        if (!_removeFromList(moduleKey)) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        
        emit RegistryEvents.ModuleKeyUnregistered(moduleKey, name, msg.sender);
    }

    // ============ Core Dynamic Module Key Functions ============
    
    /**
     * @notice Returns whether a module key is registered as a dynamic module key.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param moduleKey The module key to check.
     * @return True if the key is a registered dynamic module key.
     */
    function isDynamicModuleKey(bytes32 moduleKey) external view returns (bool) {
        return _dynamicModuleKeys[moduleKey];
    }

    /**
     * @notice Returns whether a module key is valid (static or registered dynamic).
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param moduleKey The module key to check.
     * @return True if the key is a known static key or a registered dynamic key.
     */
    function isValidModuleKey(bytes32 moduleKey) external view returns (bool) {
        return ModuleKeys.isValidModuleKey(moduleKey) || _dynamicModuleKeys[moduleKey];
    }

    /**
     * @notice Returns the module key associated with a given name.
     * @dev Reverts if:
     *      - name is invalid (length/charset; see _normalizeAndValidate)
     *      - name is not registered
     *
     * Security:
     * - Read-only
     *
     * @param name Module key name (will be normalized).
     * @return moduleKey The registered module key.
     */
    function getModuleKeyByName(string calldata name) external view returns (bytes32 moduleKey) {
        (, bytes32 nameHash) = _normalizeAndValidate(name);
        moduleKey = _nameHashToModuleKey[nameHash];
        if (moduleKey == bytes32(0)) {
            // Return the normalized name hash for off-chain correlation.
            revert RegistryDynamicModuleKey__ModuleNameNotExists(nameHash);
        }
    }

    /**
     * @notice Returns the human-readable name for a module key.
     * @dev Reverts if:
     *      - moduleKey is neither a known static key nor a registered dynamic key
     *
     * Security:
     * - Read-only
     *
     * @param moduleKey Module key (static or dynamic).
     * @return name Name string (static key string or normalized dynamic name).
     */
    function getModuleKeyName(bytes32 moduleKey) external view returns (string memory name) {
        if (ModuleKeys.isValidModuleKey(moduleKey)) {
            return ModuleKeys.getModuleKeyString(moduleKey);
        } else if (_dynamicModuleKeys[moduleKey]) {
            return _moduleKeyNames[moduleKey];
        } else {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
    }

    // ============ Dynamic Module Key Management Functions ============
    
    /**
     * @notice Returns all registered dynamic module keys.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return keys Dynamic module keys.
     */
    function getDynamicModuleKeys() external view returns (bytes32[] memory keys) {
        uint256 len = _dynamicModuleKeyList.length;
        keys = new bytes32[](len);
        for (uint256 i = 0; i < len; ) {
            keys[i] = _dynamicModuleKeyList[i];
            unchecked { ++i; }
        }
    }

    /**
     * @notice Returns the total count of registered dynamic module keys.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return The dynamic module key count.
     */
    function getDynamicKeyCount() external view returns (uint256) {
        return _dynamicModuleKeyList.length;
    }

    /**
     * @notice Returns the stored normalized name for a dynamic module key.
     * @dev Reverts if:
     *      - moduleKey is not a registered dynamic module key
     *
     * Security:
     * - Read-only
     *
     * @param moduleKey Dynamic module key.
     * @return name Normalized name.
     */
    function getDynamicModuleKeyName(bytes32 moduleKey) external view returns (string memory name) {
        if (!_dynamicModuleKeys[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        return _moduleKeyNames[moduleKey];
    }

    /**
     * @notice Returns the module key mapped from a normalized name hash.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @param nameHash keccak256 hash of the normalized name.
     * @return moduleKey Registered module key (zero if not registered).
     */
    function getNameHashToModuleKey(bytes32 nameHash) external view returns (bytes32 moduleKey) {
        return _nameHashToModuleKey[nameHash];
    }

    /**
     * @notice Returns the dynamic module key at a given index in the internal list.
     * @dev Reverts if:
     *      - index is out of bounds
     *
     * Security:
     * - Read-only
     *
     * @param index 0-based index.
     * @return moduleKey Dynamic module key at index.
     */
    function getDynamicModuleKeyByIndex(uint256 index) external view returns (bytes32 moduleKey) {
        if (index >= _dynamicModuleKeyList.length) revert IndexOutOfBounds(index, _dynamicModuleKeyList.length);
        return _dynamicModuleKeyList[index];
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Returns the registration admin address.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return Registration admin address.
     */
    function getRegistrationAdmin() external view returns (address) {
        return _registrationAdminAddr;
    }

    /**
     * @notice Returns the system admin address.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Read-only
     *
     * @return System admin address.
     */
    function getSystemAdmin() external view returns (address) {
        return _systemAdminAddr;
    }

    /**
     * @notice Sets a new registration admin.
     * @dev Reverts if:
     *      - msg.sender is not owner
     *      - newRegistrationAdmin == address(0)
     *
     * Security:
     * - onlyOwner
     *
     * @param newRegistrationAdmin New registration admin address.
     */
    function setRegistrationAdmin(address newRegistrationAdmin) external onlyOwner {
        if (newRegistrationAdmin == address(0)) revert ZeroAddress();
        
        address oldAdmin = _registrationAdminAddr;
        _registrationAdminAddr = newRegistrationAdmin;
        
        emit RegistryEvents.RegistrationAdminChanged(oldAdmin, newRegistrationAdmin);
    }

    /**
     * @notice Sets a new system admin.
     * @dev Reverts if:
     *      - msg.sender is not owner
     *      - newSystemAdmin == address(0)
     *
     * Security:
     * - onlyOwner
     *
     * @param newSystemAdmin New system admin address.
     */
    function setSystemAdmin(address newSystemAdmin) external onlyOwner {
        if (newSystemAdmin == address(0)) revert ZeroAddress();
        
        address oldAdmin = _systemAdminAddr;
        _systemAdminAddr = newSystemAdmin;
        
        emit RegistryEvents.SystemAdminChanged(oldAdmin, newSystemAdmin);
    }

    /**
     * @notice Pauses the contract (disables whenNotPaused entrypoints).
     * @dev Reverts if:
     *      - msg.sender is not owner
     *
     * Security:
     * - onlyOwner
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract (re-enables whenNotPaused entrypoints).
     * @dev Reverts if:
     *      - msg.sender is not owner
     *
     * Security:
     * - onlyOwner
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============ Internal Functions ============
    
    /// @dev Storage gap for upgrade safety (prevents storage layout collisions).
    uint256[49] private __gap;
} 