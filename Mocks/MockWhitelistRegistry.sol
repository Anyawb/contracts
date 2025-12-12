// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockWhitelistRegistry {
    mapping(address => bool) private _list;
    function set(address addr, bool allowed) external {
        _list[addr] = allowed;
    }
    function check(address addr) external view returns (bool) {
        return _list[addr];
    }
} 