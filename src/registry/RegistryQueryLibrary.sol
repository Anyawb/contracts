// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RegistryStorage} from "./RegistryStorageLibrary.sol";
import {ModuleNotRegistered} from "../errors/StandardErrors.sol";

/**
 * @title RegistryQuery
 * @notice Minimal read-only helpers for Registry module queries.
 * @dev Reverts if:
 *      - (see individual functions)
 *
 * Security:
 * - Read-only helpers over RegistryStorage.
 */
library RegistryQuery {
    /**
     * @notice Returns the module address for a given key (zero if unset).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @param key Module key (bytes32).
     * @return moduleAddr Module address, or address(0) if unset.
     */
    function getModule(bytes32 key) internal view returns (address) {
        return RegistryStorage.layout().modules[key];
    }

    /**
     * @notice Returns the module address for a key, reverting if unset.
     * @dev Reverts if:
     *      - module is not registered for key (ModuleNotRegistered)
     *
     * Security:
     * - Read-only
     *
     * @param key Module key (bytes32).
     * @return moduleAddr Registered module address.
     */
    function getModuleOrRevert(bytes32 key) internal view returns (address) {
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        address addr = layout.modules[key];
        if (addr == address(0)) revert ModuleNotRegistered(key);
        return addr;
    }

    /**
     * @notice Returns whether a module is registered for the given key.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @param key Module key (bytes32).
     * @return isRegistered True if the module address is non-zero.
     */
    function isModuleRegistered(bytes32 key) internal view returns (bool) {
        return RegistryStorage.layout().modules[key] != address(0);
    }
}
