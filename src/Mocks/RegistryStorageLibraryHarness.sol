// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RegistryStorage} from "../registry/RegistryStorageLibrary.sol";

/// @notice Harness to allow tests to write/read RegistryStorage directly in delegatecall context.
contract RegistryStorageLibraryHarness {
    function setModuleDirect(bytes32 key, address moduleAddress) external {
        RegistryStorage.layout().modules[key] = moduleAddress;
    }

    function setPendingUpgradeDirect(
        bytes32 key,
        address newAddr,
        uint256 executeAfterBlock,
        address proposer,
        uint256 minDelaySnapshot
    ) external {
        RegistryStorage.layout().pendingUpgrades[key] = RegistryStorage
            .PendingUpgrade({
                newAddr: newAddr,
                executeAfter: executeAfterBlock,
                proposer: proposer,
                minDelaySnapshot: minDelaySnapshot
            });
    }

    function pushUpgradeHistoryDirect(
        bytes32 key,
        address oldAddress,
        address newAddress,
        uint256 blockNumber,
        address executor
    ) external {
        RegistryStorage.layout().upgradeHistory[key].push(
            RegistryStorage.UpgradeHistory({
                oldAddress: oldAddress,
                newAddress: newAddress,
                blockNumber: blockNumber,
                executor: executor
            })
        );
    }

    function setNonceDirect(address signer, uint256 nonce) external {
        RegistryStorage.layout().nonces[signer] = nonce;
    }

    function getNonceDirect(address signer) external view returns (uint256) {
        return RegistryStorage.layout().nonces[signer];
    }
}
