// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ReentrancyGuardSlim
/// @notice Simple reentrancy guard (non-upgradeable) without viaIR unreachable-code warning.
abstract contract ReentrancyGuardSlim {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    error ReentrancyGuardReentrantCall();

    uint256 private _status;

    constructor() {
        _status = NOT_ENTERED;
    }

    function _reentrancyGuardEnter() internal {
        if (_status == ENTERED) revert ReentrancyGuardReentrantCall();
        _status = ENTERED;
    }

    function _reentrancyGuardExit() internal {
        _status = NOT_ENTERED;
    }

    function _reentrancyGuardEntered() internal view returns (bool) {
        return _status == ENTERED;
    }
}

