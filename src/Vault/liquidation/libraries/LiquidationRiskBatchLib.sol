// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ModuleCache.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { LiquidationRiskLib } from "./LiquidationRiskLib.sol";
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";

interface IUserHF {
    function getUserHealthFactor(address user) external view returns (uint256);
}

library LiquidationRiskBatchLib {
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    function batchIsLiquidatable(
        address manager,
        address[] calldata users,
        uint256 threshold
    ) internal view returns (bool[] memory liquidatable) {
        uint256 length = users.length;
        liquidatable = new bool[](length);
        for (uint256 i = 0; i < length;) {
            address user = users[i];
            if (user != address(0)) {
                uint256 hf = IUserHF(manager).getUserHealthFactor(user);
                liquidatable[i] = hf < threshold;
            }
            unchecked { ++i; }
        }
    }

    function batchGetUserHealthFactors(
        address manager,
        address[] calldata users
    ) internal view returns (uint256[] memory healthFactors) {
        uint256 length = users.length;
        healthFactors = new uint256[](length);
        for (uint256 i = 0; i < length;) {
            address user = users[i];
            healthFactors[i] = user == address(0) ? 0 : IUserHF(manager).getUserHealthFactor(user);
            unchecked { ++i; }
        }
    }
}


