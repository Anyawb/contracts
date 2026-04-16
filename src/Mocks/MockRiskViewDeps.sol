// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockHealthViewLite {
    struct HF {
        uint256 value;
        bool valid;
    }
    mapping(address => HF) public hfs;

    function setHealth(address user, uint256 hf, bool valid) external {
        hfs[user] = HF({ value: hf, valid: valid });
    }

    function getUserHealthFactorWithMeta(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber)
    {
        HF memory h = hfs[user];
        return (h.value, h.valid, 0);
    }
}

/// @notice Minimal debt totals mock (implements getUserTotalDebtValue only).
contract MockDebtTotals {
    mapping(address => uint256) public totals;
    function setTotal(address user, uint256 v) external { totals[user] = v; }
    function getUserTotalDebtValue(address user) external view returns (uint256) { return totals[user]; }
    function getUserTotalDebtValueBestEffort(address user) external view returns (uint256) { return totals[user]; }
    function getUserTotalDebtValueStrict(address user) external view returns (uint256) { return totals[user]; }
}

/// @notice Minimal PositionView valuation mock (implements getUserTotalCollateralValue / getAssetValue / getTotalCollateralValue).
contract MockPositionViewValuation {
    mapping(address => uint256) public totals;
    uint256 public totalSystemValue;
    mapping(address => uint256) public assetValues;
    mapping(address => bool) public hasAssetValueOverride;
    mapping(address => bool) public revertAssetValue;

    function setTotal(address user, uint256 v) external { totals[user] = v; }
    function setTotalSystemValue(uint256 v) external { totalSystemValue = v; }
    function setAssetValue(address asset, uint256 v) external {
        assetValues[asset] = v;
        hasAssetValueOverride[asset] = true;
    }
    function setAssetValueRevert(address asset, bool shouldRevert) external {
        revertAssetValue[asset] = shouldRevert;
    }

    function getUserTotalCollateralValue(address user) external view returns (uint256) { return totals[user]; }
    function getTotalCollateralValue() external view returns (uint256) { return totalSystemValue; }
    function getAssetValue(address asset, uint256 amount) external view returns (uint256) {
        if (revertAssetValue[asset]) revert("mock-asset-value-revert");
        if (hasAssetValueOverride[asset]) return assetValues[asset];
        return amount;
    }
}

contract MockGuaranteeFund {
    mapping(address => mapping(address => uint256)) public locked;
    function setLocked(address user, address asset, uint256 amount) external { locked[user][asset] = amount; }
    function getLockedGuarantee(address user, address asset) external view returns (uint256) { return locked[user][asset]; }
}

