// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IVaultRouter} from "../interfaces/IVaultRouter.sol";

/// @title MockVaultRouter
/// @notice Mock VaultRouter contract used in tests.
contract MockVaultRouter is IVaultRouter {
    // User position storage.
    mapping(address => mapping(address => uint256)) private _userCollateral;
    mapping(address => mapping(address => uint256)) private _userDebt;

    // Events.
    event UserPositionUpdated(
        address indexed user,
        address indexed asset,
        uint256 collateral,
        uint256 debt
    );
    event UserOperationProcessed(
        address indexed user,
        bytes32 operation,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );
    event CollateralSeized(
        address indexed user,
        address indexed asset,
        uint256 amount,
        address indexed liquidator
    );
    event DebtReduced(
        address indexed user,
        address indexed asset,
        uint256 amount,
        address indexed liquidator
    );

    /// @notice Processes a mocked user operation.
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 blockNumber
    ) external override {
        // Update the in-memory user position according to the operation type.
        if (operationType == keccak256(abi.encodePacked("DEPOSIT"))) {
            _userCollateral[user][asset] += amount;
        } else if (operationType == keccak256(abi.encodePacked("BORROW"))) {
            _userDebt[user][asset] += amount;
        } else if (operationType == keccak256(abi.encodePacked("REPAY"))) {
            if (_userDebt[user][asset] >= amount) {
                _userDebt[user][asset] -= amount;
            }
        } else if (operationType == keccak256(abi.encodePacked("WITHDRAW"))) {
            if (_userCollateral[user][asset] >= amount) {
                _userCollateral[user][asset] -= amount;
            }
        }

        emit UserOperationProcessed(
            user,
            operationType,
            asset,
            amount,
            blockNumber
        );
    }

    /// @notice Pushes a full user-position update with strict-context parameters.
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external override {
        requestId;
        seq;
        nextVersion; // mock: ignore context/version
        require(user != address(0), "MockVaultRouter: user is zero");
        require(asset != address(0), "MockVaultRouter: asset is zero");
        _userCollateral[user][asset] = collateral;
        _userDebt[user][asset] = debt;

        emit UserPositionUpdated(user, asset, collateral, debt);
    }

    /// @notice Pushes a delta user-position update with strict-context parameters.
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external override {
        requestId;
        seq;
        nextVersion; // mock: ignore context/version
        _applyDeltaUpdate(user, asset, collateralDelta, debtDelta);
    }

    function _applyDelta(
        uint256 base,
        int256 delta
    ) internal pure returns (uint256) {
        if (delta >= 0) {
            return base + uint256(delta);
        }
        uint256 absDelta = uint256(-delta);
        require(base >= absDelta, "MockVaultRouter: delta underflow");
        return base - absDelta;
    }

    function _applyDeltaUpdate(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta
    ) internal {
        _userCollateral[user][asset] = _applyDelta(
            _userCollateral[user][asset],
            collateralDelta
        );
        _userDebt[user][asset] = _applyDelta(_userDebt[user][asset], debtDelta);
        emit UserPositionUpdated(
            user,
            asset,
            _userCollateral[user][asset],
            _userDebt[user][asset]
        );
    }

    /// @notice Pushes an asset statistics update with strict-context parameters.
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) external pure override {
        asset;
        totalCollateral;
        totalDebt;
        price;
        requestId;
        seq;
    }

    /// @notice Forwards a collateral seizure operation.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Seizure amount.
    /// @param liquidator Liquidator address.
    function forwardSeizeCollateral(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external {
        if (_userCollateral[user][asset] >= amount) {
            _userCollateral[user][asset] -= amount;
        }

        emit CollateralSeized(user, asset, amount, liquidator);
    }

    /// @notice Forwards a debt reduction operation.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Reduction amount.
    /// @param liquidator Liquidator address.
    function forwardReduceDebt(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external {
        if (_userDebt[user][asset] >= amount) {
            _userDebt[user][asset] -= amount;
        }

        emit DebtReduced(user, asset, amount, liquidator);
    }

    /// @notice Returns collateral tracked for a user and asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Collateral amount.
    function getUserCollateral(
        address user,
        address asset
    ) external view returns (uint256) {
        return _userCollateral[user][asset];
    }

    /// @notice Returns debt tracked for a user and asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Debt amount.
    function getUserDebt(
        address user,
        address asset
    ) external view returns (uint256) {
        return _userDebt[user][asset];
    }
}
