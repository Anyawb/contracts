// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockAssetWhitelist
/// @notice 简化的资产白名单，用于业务逻辑测试
contract MockAssetWhitelist {
    mapping(address => bool) private _allowed;
    bool public shouldFail = false;

    function setShouldFail(bool flag) external {
        shouldFail = flag;
    }

    function setAssetAllowed(address asset, bool allowed) external {
        if (shouldFail) revert("MockAssetWhitelist: fail");
        _allowed[asset] = allowed;
    }

    function isAssetAllowed(address asset) external view returns (bool) {
        if (shouldFail) revert("MockAssetWhitelist: fail");
        return _allowed[asset];
    }
}


