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

    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid) {
        HF memory h = hfs[user];
        return (h.value, h.valid);
    }
}

contract MockTotals {
    mapping(address => uint256) public totals;
    function setTotal(address user, uint256 v) external { totals[user] = v; }
    function getUserTotalDebtValue(address user) external view returns (uint256) { return totals[user]; }
    function getUserTotalCollateralValue(address user) external view returns (uint256) { return totals[user]; }
}

contract MockGuaranteeFund {
    mapping(address => mapping(address => uint256)) public locked;
    function setLocked(address user, address asset, uint256 amount) external { locked[user][asset] = amount; }
    function getLockedGuarantee(address user, address asset) external view returns (uint256) { return locked[user][asset]; }
}

