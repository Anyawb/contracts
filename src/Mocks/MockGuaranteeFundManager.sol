// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IGuaranteeFundManager} from "../interfaces/IGuaranteeFundManager.sol";
import {LoanEvents} from "../core/LoanEvents.sol";

/// @title MockGuaranteeFundManager
/// @notice Mock guarantee fund manager used in tests.
contract MockGuaranteeFundManager is IGuaranteeFundManager, LoanEvents {
    // User guarantee balances.
    mapping(address => mapping(address => uint256)) private _userGuarantees;
    mapping(address => uint256) private _totalByAsset;

    // Test control flag.
    bool public mockSuccess = true;

    /// @notice Locks guarantee funds.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Guarantee amount.
    function lockGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external override {
        if (!mockSuccess) revert("MGFM: lock fail");
        _userGuarantees[user][asset] += amount;
        _totalByAsset[asset] += amount;
        emit GuaranteeLocked(user, asset, amount, block.number);
    }

    /// @notice Releases guarantee funds.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Released amount.
    function releaseGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external override {
        if (!mockSuccess) revert("MGFM: release fail");
        require(
            _userGuarantees[user][asset] >= amount,
            "Insufficient guarantee"
        );
        _userGuarantees[user][asset] -= amount;
        _totalByAsset[asset] -= amount;
        emit GuaranteeReleased(user, asset, amount, block.number);
    }

    /// @notice Forfeits a user's guarantee funds.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param feeReceiver Fee receiver address.
    function forfeitGuarantee(
        address user,
        address asset,
        address feeReceiver
    ) external override {
        uint256 amount = _userGuarantees[user][asset];
        if (amount > 0) {
            _userGuarantees[user][asset] = 0;
            _totalByAsset[asset] -= amount;
            emit GuaranteeForfeited(
                user,
                asset,
                amount,
                feeReceiver,
                block.number
            );
        }
    }

    /// @notice Early repayment settlement (mock).
    function settleEarlyRepayment(
        address user,
        address asset,
        address lender,
        uint256 refundToBorrower,
        uint256 penaltyToLender,
        uint256 platformFee
    ) external override {
        if (!mockSuccess) revert("MGFM: settle early fail");
        uint256 total = _userGuarantees[user][asset];
        uint256 sum = refundToBorrower + penaltyToLender + platformFee;
        require(sum == total, "Sum mismatch");

        _userGuarantees[user][asset] = 0;
        _totalByAsset[asset] -= total;

        if (refundToBorrower > 0)
            emit GuaranteeReleased(user, asset, refundToBorrower, block.number);
        if (penaltyToLender > 0)
            emit GuaranteeForfeited(
                user,
                asset,
                penaltyToLender,
                lender,
                block.number
            );
        if (platformFee > 0)
            emit GuaranteeForfeited(
                user,
                asset,
                platformFee,
                address(0),
                block.number
            );
    }

    /// @notice Partial forfeiture (mock).
    function forfeitPartial(
        address user,
        address asset,
        address receiver,
        uint256 amount
    ) external override {
        if (!mockSuccess) revert("MGFM: forfeit part fail");
        require(
            _userGuarantees[user][asset] >= amount,
            "Insufficient guarantee"
        );
        _userGuarantees[user][asset] -= amount;
        _totalByAsset[asset] -= amount;
        emit GuaranteeForfeited(user, asset, amount, receiver, block.number);
    }

    function forfeitPartialWithRewardPenalty(
        address user,
        address asset,
        address receiver,
        uint256 amount
    ) external override {
        if (!mockSuccess) revert("MGFM: forfeit reward fail");
        require(
            _userGuarantees[user][asset] >= amount,
            "Insufficient guarantee"
        );
        _userGuarantees[user][asset] -= amount;
        _totalByAsset[asset] -= amount;
        emit GuaranteeForfeited(user, asset, amount, receiver, block.number);
    }

    /// @notice Multi-receiver default settlement (mock).
    function settleDefault(
        address user,
        address asset,
        address[] calldata receivers,
        uint256[] calldata amounts
    ) external override {
        if (!mockSuccess) revert("MGFM: settle default fail");
        require(receivers.length == amounts.length, "Array length mismatch");
        uint256 total = _userGuarantees[user][asset];
        uint256 sum;
        for (uint256 i = 0; i < amounts.length; i++) {
            sum += amounts[i];
        }
        require(sum == total, "Sum mismatch");

        _userGuarantees[user][asset] = 0;
        _totalByAsset[asset] -= total;
        for (uint256 i = 0; i < receivers.length; i++) {
            if (amounts[i] == 0) continue;
            emit GuaranteeForfeited(
                user,
                asset,
                amounts[i],
                receivers[i],
                block.number
            );
        }
    }

    /// @notice Returns the locked guarantee amount for a user and asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Locked guarantee amount.
    function getLockedGuarantee(
        address user,
        address asset
    ) external view override returns (uint256) {
        return _userGuarantees[user][asset];
    }

    /// @notice Returns the total guarantee amount tracked for an asset.
    /// @param asset Asset address.
    /// @return Total guarantee amount.
    function getTotalGuaranteeByAsset(
        address asset
    ) external view override returns (uint256) {
        return _totalByAsset[asset];
    }

    /// @notice Returns the list of assets with tracked guarantees for a user.
    /// @return Asset address array.
    function getUserGuaranteeAssets(
        address
    ) external pure override returns (address[] memory) {
        // Mock implementation returns an empty list while preserving the interface.
        return new address[](0);
    }

    /// @notice Returns whether a user has any guarantee balance for an asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return True when a positive guarantee balance exists.
    function isGuaranteePaid(
        address user,
        address asset
    ) external view override returns (bool) {
        return _userGuarantees[user][asset] > 0;
    }

    /// @notice Locks guarantee funds for multiple assets.
    /// @param user User address.
    /// @param assets Asset address array.
    /// @param amounts Amount array.
    function batchLockGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external override {
        require(assets.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < assets.length; i++) {
            _userGuarantees[user][assets[i]] += amounts[i];
            _totalByAsset[assets[i]] += amounts[i];
            emit GuaranteeLocked(user, assets[i], amounts[i], block.number);
        }
    }

    /// @notice Releases guarantee funds for multiple assets.
    /// @param user User address.
    /// @param assets Asset address array.
    /// @param amounts Amount array.
    function batchReleaseGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external override {
        require(assets.length == amounts.length, "Array length mismatch");
        for (uint256 i = 0; i < assets.length; i++) {
            require(
                _userGuarantees[user][assets[i]] >= amounts[i],
                "Insufficient guarantee"
            );
            _userGuarantees[user][assets[i]] -= amounts[i];
            _totalByAsset[assets[i]] -= amounts[i];
            emit GuaranteeReleased(user, assets[i], amounts[i], block.number);
        }
    }

    /// @notice Compatibility helper that returns a user's guarantee amount.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Guarantee amount.
    function getUserGuarantee(
        address user,
        address asset
    ) external view returns (uint256) {
        return _userGuarantees[user][asset];
    }

    /// @notice Returns whether a user has at least the requested guarantee amount.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Required amount.
    /// @return True when the user has sufficient guarantee balance.
    function hasSufficientGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external view returns (bool) {
        return _userGuarantees[user][asset] >= amount;
    }

    /// @notice Sets whether mock operations succeed.
    /// @param success True when operations should succeed.
    function setMockSuccess(bool success) external {
        mockSuccess = success;
    }
}
