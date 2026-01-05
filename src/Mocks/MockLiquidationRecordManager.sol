// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILiquidationRecordManager } from "../interfaces/ILiquidationRecordManager.sol";
import { LiquidationTypes } from "../Vault/liquidation/types/LiquidationTypes.sol";

/// @notice Mock for ILiquidationRecordManager for view-layer tests
contract MockLiquidationRecordManager is ILiquidationRecordManager {
    mapping(address => uint256[]) private _timestamps;
    bool private _enabled = true;

    // ===== Setters for tests =====
    function setUserRecord(address user, uint256 count, uint256 lastTimestamp) external {
        uint256[] storage arr = _timestamps[user];
        delete _timestamps[user];
        for (uint256 i; i < count; ++i) {
            if (i + 1 == count) {
                arr.push(lastTimestamp);
            } else {
                arr.push(lastTimestamp > i ? lastTimestamp - i : 0);
            }
        }
    }

    // ===== Interface minimal implementation =====
    function recordLiquidation(address user) external {
        _timestamps[user].push(block.timestamp);
    }

    function emitLiquidationEvents(
        address /*user*/,
        address /*collateralAsset*/,
        address /*debtAsset*/,
        LiquidationTypes.LiquidationResult calldata /*result*/,
        address /*liquidator*/
    ) external {}

    function getUserLiquidationCount(address user) external view returns (uint256 count) {
        return _timestamps[user].length;
    }

    function getUserLiquidationTimestamps(address user) external view returns (uint256[] memory timestamps) {
        return _timestamps[user];
    }

    function getUserLiquidationTimestampAtIndex(address user, uint256 index) external view returns (uint256 timestamp) {
        if (index < _timestamps[user].length) {
            return _timestamps[user][index];
        }
        return 0;
    }

    function isRecordEnabled() external view returns (bool enabled) {
        return _enabled;
    }

    function updateLiquidationRecordEnabled(bool newEnabled) external {
        _enabled = newEnabled;
    }

    function clearUserLiquidationRecords(address user) external {
        delete _timestamps[user];
    }

    function clearAllLiquidationRecords() external {}

    function getModule(bytes32) external pure returns (address moduleAddress) {
        return address(0);
    }
}

