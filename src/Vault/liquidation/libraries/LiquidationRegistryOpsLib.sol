// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../../../registry/Registry.sol";

library LiquidationRegistryOpsLib {
    function getPendingUpgrade(address registry, bytes32 moduleKey) internal view returns (address, uint256, bool) {
        return Registry(registry).getPendingUpgrade(moduleKey);
    }

    function isUpgradeReady(address registry, bytes32 moduleKey) internal view returns (bool) {
        (, uint256 executeAfter, bool hasPending) = Registry(registry).getPendingUpgrade(moduleKey);
        return hasPending && block.timestamp >= executeAfter;
    }
}


