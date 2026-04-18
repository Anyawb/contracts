// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEarlyRepaymentGuaranteeManager} from "../interfaces/IEarlyRepaymentGuaranteeManager.sol";

/// @title MockEarlyRepaymentGuaranteeManager
/// @notice Mock early-repayment guarantee manager used in tests.
contract MockEarlyRepaymentGuaranteeManager {
    uint256 private constant _BLOCKS_PER_DAY = 7200;

    // User guarantee record storage.
    mapping(address => mapping(address => mapping(address => uint256)))
        private _userGuarantees;
    mapping(address => mapping(address => bool)) private _activeGuarantees;
    mapping(address => mapping(address => uint256)) private _guaranteeIds;
    mapping(uint256 => IEarlyRepaymentGuaranteeManager.GuaranteeRecord)
        private _records;
    uint256 private _nextGuaranteeId = 1;

    // Events.
    event GuaranteeRecordLocked(
        address indexed user,
        address indexed lender,
        address indexed asset,
        uint256 amount,
        uint256 interest,
        uint256 termDays
    );
    event GuaranteeRecordReleased(
        address indexed user,
        address indexed lender,
        address indexed asset,
        uint256 amount
    );
    event EarlyRepaymentSettled(
        address indexed user,
        address indexed asset,
        uint256 amount
    );
    event GuaranteeEnabledUpdated(address indexed asset, bool enabled);
    event GuaranteeMaturityOverridden(
        address indexed user,
        address indexed asset,
        uint256 maturityBlock
    );

    mapping(address => bool) private _enabledByAsset;
    mapping(address => mapping(address => uint256))
        private _defaultRecoveryByUserAsset;

    event DefaultRecoveryConfigured(
        address indexed user,
        address indexed asset,
        uint256 amount,
        bool active
    );
    event DefaultProcessed(
        address indexed user,
        address indexed asset,
        uint256 amount
    );

    /// @notice Locks a mock guarantee record.
    /// @param user User address.
    /// @param lender Lender address.
    /// @param asset Asset address.
    /// @param amount Principal amount.
    /// @param interest Interest amount.
    /// @param termDays Loan term in days.
    function lockGuaranteeRecord(
        address user,
        address lender,
        address asset,
        uint256 amount,
        uint256 interest,
        uint256 termDays
    ) external {
        _userGuarantees[user][lender][asset] += interest;
        _activeGuarantees[user][asset] = true;
        uint256 guaranteeId = _nextGuaranteeId;
        unchecked {
            _nextGuaranteeId = guaranteeId + 1;
        }
        _guaranteeIds[user][asset] = guaranteeId;
        _records[guaranteeId] = IEarlyRepaymentGuaranteeManager
            .GuaranteeRecord({
                principal: amount,
                promisedInterest: interest,
                startTime: block.number,
                maturityTime: block.number + (termDays * _BLOCKS_PER_DAY),
                earlyRepayPenaltyDays: termDays,
                isActive: true,
                lender: lender,
                asset: asset
            });
        emit GuaranteeRecordLocked(
            user,
            lender,
            asset,
            amount,
            interest,
            termDays
        );
    }

    function setGuaranteeMaturity(
        address user,
        address asset,
        uint256 maturityBlock
    ) external {
        uint256 guaranteeId = _guaranteeIds[user][asset];
        require(guaranteeId != 0, "GuaranteeRecordNotFound");
        _records[guaranteeId].maturityTime = maturityBlock;
        emit GuaranteeMaturityOverridden(user, asset, maturityBlock);
    }

    /// @notice Releases a mock guarantee record.
    /// @param user User address.
    /// @param lender Lender address.
    /// @param asset Asset address.
    /// @param amount Released amount.
    function releaseGuaranteeRecord(
        address user,
        address lender,
        address asset,
        uint256 amount
    ) external {
        require(
            _userGuarantees[user][lender][asset] >= amount,
            "Insufficient guarantee record"
        );
        _userGuarantees[user][lender][asset] -= amount;
        emit GuaranteeRecordReleased(user, lender, asset, amount);
    }

    /// @notice Settles a mock early repayment.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Repayment amount.
    function settleEarlyRepayment(
        address user,
        address asset,
        uint256 amount
    )
        external
        returns (
            IEarlyRepaymentGuaranteeManager.EarlyRepaymentResult memory result
        )
    {
        // Mock implementation only records the event and clears state.
        _activeGuarantees[user][asset] = false;
        uint256 guaranteeId = _guaranteeIds[user][asset];
        if (guaranteeId != 0) {
            _records[guaranteeId].isActive = false;
            delete _guaranteeIds[user][asset];
        }
        emit EarlyRepaymentSettled(user, asset, amount);
        result = IEarlyRepaymentGuaranteeManager.EarlyRepaymentResult({
            actualInterestPaid: 0,
            penaltyToLender: 0,
            refundToBorrower: 0,
            platformFee: 0
        });
    }

    function getUserGuaranteeId(
        address user,
        address asset
    ) external view returns (uint256 guaranteeId) {
        return _guaranteeIds[user][asset];
    }

    function getGuaranteeRecord(
        uint256 guaranteeId
    )
        external
        view
        returns (IEarlyRepaymentGuaranteeManager.GuaranteeRecord memory record)
    {
        return _records[guaranteeId];
    }

    function hasActiveGuarantee(
        address user,
        address asset
    ) external view returns (bool active) {
        return _activeGuarantees[user][asset];
    }

    /// @notice Returns whether guarantee support is enabled for an asset.
    function isGuaranteeEnabled(
        address asset
    ) external view returns (bool enabled) {
        return _enabledByAsset[asset];
    }

    /// @notice Sets the guarantee-enabled flag without access control.
    function setGuaranteeEnabled(address asset, bool enabled) external {
        _enabledByAsset[asset] = enabled;
        emit GuaranteeEnabledUpdated(asset, enabled);
    }

    function setDefaultRecovery(
        address user,
        address asset,
        uint256 amount,
        bool active
    ) external {
        _defaultRecoveryByUserAsset[user][asset] = amount;
        _activeGuarantees[user][asset] = active;
        if (active && _guaranteeIds[user][asset] == 0) {
            uint256 guaranteeId = _nextGuaranteeId;
            unchecked {
                _nextGuaranteeId = guaranteeId + 1;
            }
            _guaranteeIds[user][asset] = guaranteeId;
            _records[guaranteeId].isActive = true;
            _records[guaranteeId].asset = asset;
        }
        emit DefaultRecoveryConfigured(user, asset, amount, active);
    }

    function processDefault(
        address borrower,
        address asset
    ) external returns (uint256 forfeitedAmount) {
        forfeitedAmount = _defaultRecoveryByUserAsset[borrower][asset];
        _activeGuarantees[borrower][asset] = false;
        uint256 guaranteeId = _guaranteeIds[borrower][asset];
        if (guaranteeId != 0) {
            _records[guaranteeId].isActive = false;
            delete _guaranteeIds[borrower][asset];
        }
        emit DefaultProcessed(borrower, asset, forfeitedAmount);
    }

    /// @notice Returns the stored mock guarantee amount for a user-lender-asset tuple.
    /// @param user User address.
    /// @param lender Lender address.
    /// @param asset Asset address.
    /// @return Stored guarantee amount.
    function getUserGuaranteeRecord(
        address user,
        address lender,
        address asset
    ) external view returns (uint256) {
        return _userGuarantees[user][lender][asset];
    }
}
