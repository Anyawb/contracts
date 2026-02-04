// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ViewConstants } from "../Vault/view/ViewConstants.sol";

/// @title MockStatisticsViewUserSnapshot
/// @notice Minimal StatisticsView-like mock for UserView unit tests.
contract MockStatisticsViewUserSnapshot {
    struct UserSnapshot {
        uint256 collateral;
        uint256 debt;
        uint256 ltv;
        uint256 healthFactor;
        uint256 blockNumber;
        bool isActive;
    }

    mapping(address => UserSnapshot) private _snap;
    mapping(address => uint64) private _version;

    function setUserSnapshot(
        address user,
        uint256 collateral,
        uint256 debt,
        uint256 ltv,
        uint256 healthFactor,
        uint256 blockNumber,
        bool isActive,
        uint64 version_
    ) external {
        _snap[user] = UserSnapshot({
            collateral: collateral,
            debt: debt,
            ltv: ltv,
            healthFactor: healthFactor,
            blockNumber: blockNumber,
            isActive: isActive
        });
        _version[user] = version_;
    }

    function getUserSnapshotWithMeta(address user)
        external
        view
        returns (UserSnapshot memory s, uint64 version, uint64 seq, bytes32 lastAppliedRequestId, bool isValid, uint256 blockNumber)
    {
        s = _snap[user];
        version = _version[user];
        seq = 0;
        lastAppliedRequestId = bytes32(0);
        blockNumber = s.blockNumber;
        // Align with ViewConstants.CACHE_DURATION_BLOCKS.
        if (blockNumber == 0 || blockNumber > block.number) {
            isValid = false;
        } else {
            isValid = block.number - blockNumber <= ViewConstants.CACHE_DURATION_BLOCKS;
        }
    }
}

