// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPositionView} from "../interfaces/IPositionView.sol";

/// @title MockPositionView
/// @notice Minimal PositionView mock for tests; stores values in memory only.
contract MockPositionView is IPositionView {
    mapping(address => mapping(address => uint256)) public collateral;
    mapping(address => mapping(address => uint256)) public debt;
    mapping(address => mapping(address => uint64)) public version;
    mapping(address => mapping(address => uint256)) public updateBlock;

    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 c,
        uint256 d
    ) external {
        _write(user, asset, c, d, 0);
    }

    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 c,
        uint256 d,
        bytes32 requestId,
        uint64 seq
    ) external {
        requestId;
        seq;
        _write(user, asset, c, d, 0);
    }

    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 c,
        uint256 d,
        uint64 nextVersion
    ) external {
        _write(user, asset, c, d, nextVersion);
    }

    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 c,
        uint256 d,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external {
        requestId;
        seq;
        _write(user, asset, c, d, nextVersion);
    }

    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 cDelta,
        int256 dDelta
    ) external {
        _write(
            user,
            asset,
            _apply(collateral[user][asset], cDelta),
            _apply(debt[user][asset], dDelta),
            0
        );
    }

    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 cDelta,
        int256 dDelta,
        bytes32 requestId,
        uint64 seq
    ) external {
        requestId;
        seq;
        _write(
            user,
            asset,
            _apply(collateral[user][asset], cDelta),
            _apply(debt[user][asset], dDelta),
            0
        );
    }

    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 cDelta,
        int256 dDelta,
        uint64 nextVersion
    ) external {
        _write(
            user,
            asset,
            _apply(collateral[user][asset], cDelta),
            _apply(debt[user][asset], dDelta),
            nextVersion
        );
    }

    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 cDelta,
        int256 dDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external {
        requestId;
        seq;
        _write(
            user,
            asset,
            _apply(collateral[user][asset], cDelta),
            _apply(debt[user][asset], dDelta),
            nextVersion
        );
    }

    function getPositionVersion(
        address user,
        address asset
    ) external view returns (uint64) {
        return version[user][asset];
    }

    function getUserPositionWithMeta(
        address user,
        address asset
    ) external view returns (uint256, uint256, bool, uint256, uint64) {
        return (
            collateral[user][asset],
            debt[user][asset],
            true,
            updateBlock[user][asset],
            version[user][asset]
        );
    }

    function batchGetUserPositionsWithMeta(
        address[] calldata users,
        address[] calldata assets
    )
        external
        view
        returns (
            uint256[] memory collaterals,
            uint256[] memory debts,
            bool[] memory validFlags,
            uint256[] memory blockNumbers,
            uint64[] memory versions
        )
    {
        require(users.length == assets.length, "MPV: len mismatch");
        uint256 len = users.length;
        collaterals = new uint256[](len);
        debts = new uint256[](len);
        validFlags = new bool[](len);
        blockNumbers = new uint256[](len);
        versions = new uint64[](len);
        for (uint256 i; i < len; ++i) {
            address user = users[i];
            address asset = assets[i];
            collaterals[i] = collateral[user][asset];
            debts[i] = debt[user][asset];
            validFlags[i] = true;
            blockNumbers[i] = updateBlock[user][asset];
            versions[i] = version[user][asset];
        }
    }

    function _write(
        address user,
        address asset,
        uint256 c,
        uint256 d,
        uint64 nextVersion
    ) internal {
        uint64 current = version[user][asset];
        uint64 newVersion = nextVersion == 0 ? current + 1 : nextVersion;
        require(newVersion > current, "MockPositionView: stale version");
        collateral[user][asset] = c;
        debt[user][asset] = d;
        version[user][asset] = newVersion;
        updateBlock[user][asset] = block.number;
    }

    function _apply(
        uint256 base,
        int256 delta
    ) internal pure returns (uint256) {
        if (delta >= 0) return base + uint256(delta);
        uint256 absDelta = uint256(-delta);
        require(base >= absDelta, "MockPositionView: underflow");
        return base - absDelta;
    }
}
