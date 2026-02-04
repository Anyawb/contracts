// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

/// @title ViewAccessLib
/// @notice Shared access-control helpers for view-layer modules.
/// @dev Reduces duplication of _requireRole/_hasRole logic across view contracts.
library ViewAccessLib {
    /**
     * @notice Require a role via Registry-resolved AccessControlManager.
     * @dev Reverts if:
     *      - registryAddr is zero or not a contract (Registry.getModuleOrRevert)
     *      - KEY_ACCESS_CONTROL is missing in Registry (Registry.getModuleOrRevert)
     *      - user lacks the role (via ACM.requireRole)
     *
     * Security:
     * - View-only helper; does not mutate state.
     *
     * @param registryAddr Registry address.
     * @param actionKey Action key (see ActionKeys).
     * @param user Address to check.
     */
    function requireRole(address registryAddr, bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice Check whether a user has a role via Registry-resolved AccessControlManager.
     * @dev Reverts if:
     *      - registryAddr is zero or not a contract (Registry.getModuleOrRevert)
     *      - KEY_ACCESS_CONTROL is missing in Registry (Registry.getModuleOrRevert)
     *
     * Security:
     * - View-only helper; does not mutate state.
     *
     * @param registryAddr Registry address.
     * @param actionKey Action key (see ActionKeys).
     * @param user Address to check.
     * @return True if user has role, otherwise false.
     */
    function hasRole(address registryAddr, bytes32 actionKey, address user) internal view returns (bool) {
        address acmAddr = Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(actionKey, user);
    }
}


