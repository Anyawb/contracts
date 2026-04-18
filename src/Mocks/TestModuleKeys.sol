// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ModuleKeys} from "../constants/ModuleKeys.sol";

/// @title TestModuleKeys
/// @notice Test-only helper contract for scripts/checks/checkKeys.ts
/// @dev Exposes internal ModuleKeys lists for offchain validation.
contract TestModuleKeys {
    function getAllModuleKeys() external pure returns (bytes32[] memory) {
        return ModuleKeys.getAllKeys();
    }

    function getExpectedKeyCount() external pure returns (uint256) {
        return ModuleKeys.getKeyCount();
    }
}
