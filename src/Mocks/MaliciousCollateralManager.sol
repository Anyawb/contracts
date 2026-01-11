// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralManager } from "../interfaces/ICollateralManager.sol";

/// @title MaliciousCollateralManager
/// @notice Simplified attacker contract used in security tests to attempt reentrancy
/// @dev This contract does not implement the collateral manager interface itself. Instead,
///      it stores a target collateral manager address and provides helper methods that try
///      to invoke the target methods twice within the same transaction. The second call
///      emulates the reentrant behaviour that the test-suite expects to be rejected by
///      `ReentrancyGuard`.
contract MaliciousCollateralManager {
    ICollateralManager public target;

    error TargetNotSet();

    bool private _reentering;
    bytes private _lastPayload;

    /// @notice Sets the collateral manager that will be attacked.
    function setTarget(address target_) external {
        target = ICollateralManager(target_);
    }

    /// @notice Attempts to trigger a reentrant `depositCollateral`.
    function attackDeposit(address user, address asset, uint256 amount) external {
        _attempt(abi.encodeWithSignature("depositCollateral(address,address,uint256)", user, asset, amount));
    }

    /// @notice Attempts to trigger a reentrant `withdrawCollateral`.
    function attackWithdraw(address user, address asset, uint256 amount) external {
        _attempt(abi.encodeWithSignature("withdrawCollateral(address,address,uint256)", user, asset, amount));
    }

    /// @notice Attempts to trigger a reentrant `batchDepositCollateral`.
    function attackBatchDeposit(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external {
        _attempt(abi.encodeWithSignature("batchDepositCollateral(address,address[],uint256[])", user, assets, amounts));
    }

    /// @notice Attempts to trigger a reentrant `batchWithdrawCollateral`.
    function attackBatchWithdraw(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external {
        _attempt(abi.encodeWithSignature("batchWithdrawCollateral(address,address[],uint256[])", user, assets, amounts));
    }

    function _attempt(bytes memory payload) private {
        if (address(target) == address(0)) revert TargetNotSet();

        if (_reentering) {
            // Nested call (second entry)
            (bool success,) = address(target).call(payload);
            require(success, "reentrant call failed");
            return;
        }

        _reentering = true;
        _lastPayload = payload;

        // First call – expected to succeed (or revert with guard)
        (bool ok,) = address(target).call(payload);
        _reentering = false;
        delete _lastPayload;

        require(ok, "primary call failed");
    }
}
