// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IRegistryDynamicModuleKey} from "../interfaces/IRegistryDynamicModuleKey.sol";
import {IndexOutOfBounds, ZeroAddress} from "../errors/StandardErrors.sol";
import {RegistryEvents} from "../registry/RegistryEventsLibrary.sol";

/// @title MockRegistryDynamicModuleKey
/// @notice Mock dynamic module-key registry used in tests.
/// @dev This mock omits full access control and validation logic.
contract MockRegistryDynamicModuleKey is IRegistryDynamicModuleKey {
    // NOTE:
    // - `IRegistryDynamicModuleKey` intentionally declares only functions (no events/errors).
    // - Events are emitted via the canonical RegistryEvents library (Architecture-Guide.md unified event library rule).

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    error RegistryDynamicModuleKey__ModuleKeyAlreadyExists(bytes32 moduleKey);
    error RegistryDynamicModuleKey__ModuleKeyNotExists(bytes32 moduleKey);
    error RegistryDynamicModuleKey__ModuleNameNotExists(string name);

    bytes32[] private _dynamicKeys;
    mapping(bytes32 => bool) private _keyExists;
    mapping(bytes32 => string) private _keyNames;

    address private _registrationAdmin;
    address private _systemAdmin;
    bool private _paused;

    /// @notice Registers a dynamic module key without access control.
    function registerModuleKey(
        string calldata name
    ) external returns (bytes32 moduleKey) {
        moduleKey = keccak256(abi.encodePacked("DYNAMIC_", name));
        if (_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyAlreadyExists(moduleKey);
        }
        _dynamicKeys.push(moduleKey);
        _keyExists[moduleKey] = true;
        _keyNames[moduleKey] = name;
        bytes32 nameHash = keccak256(abi.encodePacked(name));
        emit RegistryEvents.ModuleKeyRegistered(
            moduleKey,
            nameHash,
            msg.sender
        );
        return moduleKey;
    }

    /// @notice Registers multiple dynamic module keys.
    function batchRegisterModuleKeys(
        string[] calldata names
    ) external returns (bytes32[] memory moduleKeys) {
        moduleKeys = new bytes32[](names.length);
        for (uint256 i = 0; i < names.length; ) {
            moduleKeys[i] = this.registerModuleKey(names[i]);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Unregisters a dynamic module key.
    function unregisterModuleKey(bytes32 moduleKey) external {
        if (!_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        string memory keyName = _keyNames[moduleKey];
        _keyExists[moduleKey] = false;
        // Keep array contents unchanged and only mark the key as absent.
        emit RegistryEvents.ModuleKeyUnregistered(
            moduleKey,
            keyName,
            msg.sender
        );
    }

    /// @notice Returns whether a module key is dynamic.
    function isDynamicModuleKey(
        bytes32 moduleKey
    ) external view returns (bool) {
        return _keyExists[moduleKey];
    }

    /// @notice Returns whether a module key is valid in this mock.
    function isValidModuleKey(
        bytes32 /* moduleKey */
    ) external pure returns (bool) {
        // Mock implementation always returns true.
        return true;
    }

    /// @notice Returns the module key derived from a dynamic name.
    function getModuleKeyByName(
        string calldata name
    ) external view returns (bytes32 moduleKey) {
        moduleKey = keccak256(abi.encodePacked("DYNAMIC_", name));
        if (!_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleNameNotExists(name);
        }
        return moduleKey;
    }

    /// @notice Returns the registered name for a module key.
    function getModuleKeyName(
        bytes32 moduleKey
    ) external view returns (string memory name) {
        if (!_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        return _keyNames[moduleKey];
    }

    /// @notice Returns all currently active dynamic module keys.
    function getDynamicModuleKeys()
        external
        view
        returns (bytes32[] memory keys)
    {
        // Return only keys still marked as present.
        uint256 count;
        for (uint256 i = 0; i < _dynamicKeys.length; ) {
            if (_keyExists[_dynamicKeys[i]]) count++;
            unchecked {
                ++i;
            }
        }
        keys = new bytes32[](count);
        uint256 idx;
        for (uint256 i = 0; i < _dynamicKeys.length; ) {
            if (_keyExists[_dynamicKeys[i]]) {
                keys[idx++] = _dynamicKeys[i];
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Returns the number of currently active dynamic module keys.
    function getDynamicKeyCount() external view returns (uint256) {
        uint256 count;
        for (uint256 i = 0; i < _dynamicKeys.length; ) {
            if (_keyExists[_dynamicKeys[i]]) count++;
            unchecked {
                ++i;
            }
        }
        return count;
    }

    /// @notice Returns the registered name for a dynamic module key.
    function getDynamicModuleKeyName(
        bytes32 moduleKey
    ) external view returns (string memory name) {
        if (!_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        return _keyNames[moduleKey];
    }

    /// @notice Returns the module key mapped from a name hash in this simplified mock.
    function getNameHashToModuleKey(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    /// @notice Returns a stored dynamic module key by index.
    function getDynamicModuleKeyByIndex(
        uint256 index
    ) external view returns (bytes32 moduleKey) {
        if (index >= _dynamicKeys.length)
            revert IndexOutOfBounds(index, _dynamicKeys.length);
        return _dynamicKeys[index];
    }

    /// @notice Returns the stored registration admin address.
    function getRegistrationAdmin() external view returns (address) {
        return _registrationAdmin;
    }

    /// @notice Returns the stored system admin address.
    function getSystemAdmin() external view returns (address) {
        return _systemAdmin;
    }

    /// @notice Sets the registration admin in the mock state.
    function setRegistrationAdmin(address newRegistrationAdmin) external {
        if (newRegistrationAdmin == address(0)) revert ZeroAddress();
        _registrationAdmin = newRegistrationAdmin;
    }

    /// @notice Sets the system admin in the mock state.
    function setSystemAdmin(address newSystemAdmin) external {
        if (newSystemAdmin == address(0)) revert ZeroAddress();
        _systemAdmin = newSystemAdmin;
    }

    /// @notice Pauses the mock registry.
    function pause() external {
        _paused = true;
    }

    /// @notice Unpauses the mock registry.
    function unpause() external {
        _paused = false;
    }
}
