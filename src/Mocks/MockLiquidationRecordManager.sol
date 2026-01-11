// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockLiquidationRecordManager
/// @notice Mock implementation of LiquidationRecordManager for testing
/// @dev This is a simple mock that stores liquidation records for testing purposes
contract MockLiquidationRecordManager {
    struct UserRecord {
        uint256 totalLiquidations;
        uint256 totalProfit;
    }

    mapping(address => UserRecord) private _userRecords;

    /// @notice Set user liquidation record (for testing)
    /// @param user User address
    /// @param totalLiquidations Total number of liquidations
    /// @param totalProfit Total profit from liquidations
    function setUserRecord(
        address user,
        uint256 totalLiquidations,
        uint256 totalProfit
    ) external {
        _userRecords[user] = UserRecord({
            totalLiquidations: totalLiquidations,
            totalProfit: totalProfit
        });
    }

    /// @notice Get user liquidation record
    /// @param user User address
    /// @return totalLiquidations Total number of liquidations
    /// @return totalProfit Total profit from liquidations
    function getUserRecord(address user)
        external
        view
        returns (uint256 totalLiquidations, uint256 totalProfit)
    {
        UserRecord memory record = _userRecords[user];
        return (record.totalLiquidations, record.totalProfit);
    }
}
