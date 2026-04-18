// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RegistryEvents} from "../registry/RegistryEventsLibrary.sol";

/// @title MockRegistry
/// @notice Lightweight registry used only in tests.
/// @dev Anyone may set module addresses. Do not use this contract in production.
contract MockRegistry {
    mapping(bytes32 => address) private _modules;

    /// @notice Sets a module address.
    /// @param key Module key.
    /// @param moduleAddr Module address.
    function setModule(bytes32 key, address moduleAddr) external {
        address oldAddr = _modules[key];
        _modules[key] = moduleAddr;
        emit RegistryEvents.ModuleChanged(key, oldAddr, moduleAddr);
    }

    /// @notice Returns a module address.
    /// @param key Module key.
    /// @return Module address.
    function getModule(bytes32 key) external view returns (address) {
        return _modules[key];
    }

    /// @notice Returns a module address and reverts when it is missing.
    /// @param key Module key.
    function getModuleOrRevert(bytes32 key) external view returns (address) {
        address moduleAddr = _modules[key];
        require(moduleAddr != address(0), "MockRegistry: module not found");
        return moduleAddr;
    }

    /// @notice Returns whether a module is registered.
    /// @param key Module key.
    /// @return True when a module address is registered.
    function isModuleRegistered(bytes32 key) external view returns (bool) {
        return _modules[key] != address(0);
    }
}
