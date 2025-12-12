// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../../../registry/Registry.sol";

library LiquidationRegistryOpsLib {
    function scheduleModuleUpgrade(address registry, bytes32 moduleKey, address newAddress) internal {
        Registry(registry).scheduleModuleUpgrade(moduleKey, newAddress);
    }

    function executeModuleUpgrade(address registry, bytes32 moduleKey) internal {
        Registry(registry).executeModuleUpgrade(moduleKey);
    }

    function cancelModuleUpgrade(address registry, bytes32 moduleKey) internal {
        Registry(registry).cancelModuleUpgrade(moduleKey);
    }

    function getPendingUpgrade(address registry, bytes32 moduleKey) internal view returns (address, uint256, bool) {
        return Registry(registry).getPendingUpgrade(moduleKey);
    }

    function isUpgradeReady(address registry, bytes32 moduleKey) internal view returns (bool) {
        (, uint256 executeAfter, bool hasPending) = Registry(registry).getPendingUpgrade(moduleKey);
        return hasPending && block.timestamp >= executeAfter;
    }

    function setModule(address registry, bytes32 moduleKey, address moduleAddress, bool allowReplace) internal {
        Registry(registry).setModuleWithReplaceFlag(moduleKey, moduleAddress, allowReplace);
    }
}


