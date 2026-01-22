// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockStatisticsViewUserSnapshot
/// @notice Minimal StatisticsView-like mock for UserView unit tests.
contract MockStatisticsViewUserSnapshot {
    struct UserSnapshot {
        uint256 collateral;
        uint256 debt;
        uint256 ltv;
        uint256 healthFactor;
        uint256 timestamp;
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
        uint256 timestamp,
        bool isActive,
        uint64 version_
    ) external {
        _snap[user] = UserSnapshot({
            collateral: collateral,
            debt: debt,
            ltv: ltv,
            healthFactor: healthFactor,
            timestamp: timestamp,
            isActive: isActive
        });
        _version[user] = version_;
    }

    function getUserSnapshot(address user) external view returns (UserSnapshot memory s) {
        return _snap[user];
    }

    function getUserSnapshotWithMeta(address user)
        external
        view
        returns (UserSnapshot memory s, uint64 version, uint64 seq, bytes32 lastAppliedRequestId, bool isValid, uint256 timestamp)
    {
        s = _snap[user];
        version = _version[user];
        seq = 0;
        lastAppliedRequestId = bytes32(0);
        timestamp = s.timestamp;
        // Align with ViewConstants.CACHE_DURATION (5 minutes)
        isValid = timestamp > 0 && block.timestamp - timestamp <= 5 minutes;
    }
}

