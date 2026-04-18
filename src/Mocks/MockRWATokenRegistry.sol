// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IRWATokenRegistry} from "../interfaces/IRWATokenRegistry.sol";

/// @title MockRWATokenRegistry
/// @notice Simplified whitelist registry used in local tests.
contract MockRWATokenRegistry is IRWATokenRegistry {
    mapping(address => bool) private _allowed;

    function setAllowed(address token, bool allowed) external {
        _allowed[token] = allowed;
    }

    function isAllowed(address token) external view override returns (bool) {
        return _allowed[token];
    }
}
