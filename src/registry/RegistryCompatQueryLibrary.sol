// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {RegistryStorage} from "./RegistryStorageLibrary.sol";

/**
 * @title RegistryCompatQuery
 * @notice Compatibility query helpers for enumerating registered module keys.
 * @dev Reverts if:
 *      - (see individual functions)
 *
 * Security:
 * - Read-only helpers operating on RegistryStorage.
 * - Enumeration is O(N) over ModuleKeys.getAllKeys() and is not intended as a high-throughput production API.
 * - Prefer dedicated view modules for heavy enumeration or pagination workloads.
 */
library RegistryCompatQuery {
    /**
     * @notice Enumerates all registered module keys.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     * - O(N) over ModuleKeys.getAllKeys()
     *
     * @return keys Registered module keys filtered from ModuleKeys.getAllKeys().
     */
    function getAllRegisteredModuleKeys()
        internal
        view
        returns (bytes32[] memory)
    {
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        RegistryStorage.Layout storage layout = RegistryStorage.layout();
        uint256 count = 0;
        for (uint256 i = 0; i < allKeys.length; ) {
            if (layout.modules[allKeys[i]] != address(0)) count++;
            unchecked {
                ++i;
            }
        }
        bytes32[] memory keys = new bytes32[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < allKeys.length; ) {
            if (layout.modules[allKeys[i]] != address(0)) {
                keys[j++] = allKeys[i];
            }
            unchecked {
                ++i;
            }
        }
        return keys;
    }

    /**
     * @notice Returns a paginated slice of registered module keys.
     * @dev Reverts if:
     *      - (none; out-of-range offset returns an empty page)
     *
     * Security:
     * - Read-only
     * - Still O(N) overall because it builds the full list via getAllRegisteredModuleKeys()
     *
     * @param offset 0-based offset into the registered module keys list.
     * @param limit Maximum number of keys to return.
     * @return keys Paginated slice of registered module keys.
     * @return totalCount Total number of registered module keys.
     */
    function getRegisteredModuleKeysPaginated(
        uint256 offset,
        uint256 limit
    ) internal view returns (bytes32[] memory keys, uint256 totalCount) {
        bytes32[] memory all = getAllRegisteredModuleKeys();
        totalCount = all.length;
        if (offset >= totalCount) {
            return (new bytes32[](0), totalCount);
        }
        uint256 end = offset + limit;
        if (end > totalCount) end = totalCount;
        uint256 len = end - offset;
        keys = new bytes32[](len);
        for (uint256 i = 0; i < len; ) {
            keys[i] = all[offset + i];
            unchecked {
                ++i;
            }
        }
        return (keys, totalCount);
    }
}
