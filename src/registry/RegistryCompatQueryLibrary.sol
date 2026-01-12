// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {RegistryStorage} from "./RegistryStorageLibrary.sol";

/// @title RegistryCompatQuery
/// @notice Compat/test-only query helpers for Registry.
/// @dev IMPORTANT:
///      - These helpers iterate over `ModuleKeys.getAllKeys()` and are not intended as a long-term stable
///        public API for production frontends/indexers.
///      - In "Scheme A" (single Proxy holding the canonical RegistryStorage), prefer dedicated view modules
///        for heavy enumeration/pagination if needed.
library RegistryCompatQuery {
    /// @notice Enumerate all registered module keys (O(N) over ModuleKeys.getAllKeys()).
    function getAllRegisteredModuleKeys() internal view returns (bytes32[] memory) {
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        uint256 count = 0;
        for (uint256 i = 0; i < allKeys.length; i++) {
            if (layout.modules[allKeys[i]] != address(0)) count++;
        }
        bytes32[] memory keys = new bytes32[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < allKeys.length; i++) {
            if (layout.modules[allKeys[i]] != address(0)) {
                keys[j++] = allKeys[i];
            }
        }
        return keys;
    }

    /// @notice Paginate registered module keys.
    /// @dev This is a thin helper on top of getAllRegisteredModuleKeys(); still O(N) overall.
    function getRegisteredModuleKeysPaginated(uint256 offset, uint256 limit)
        internal
        view
        returns (bytes32[] memory keys, uint256 totalCount)
    {
        bytes32[] memory all = getAllRegisteredModuleKeys();
        totalCount = all.length;
        if (offset >= totalCount) {
            return (new bytes32[](0), totalCount);
        }
        uint256 end = offset + limit;
        if (end > totalCount) end = totalCount;
        uint256 len = end - offset;
        keys = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            keys[i] = all[offset + i];
        }
        return (keys, totalCount);
    }
}

