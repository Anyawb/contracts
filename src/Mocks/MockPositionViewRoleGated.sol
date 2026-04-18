// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ActionKeys} from "../constants/ActionKeys.sol";
import {MissingRole} from "../errors/StandardErrors.sol";
import {ViewAccessLib} from "../libraries/ViewAccessLib.sol";

/**
 * @title MockPositionViewRoleGated
 * @notice Mock PositionView with Scheme-U style read gating:
 *         - if msg.sender == user: allow (self read)
 *         - else: requires ACTION_VIEW_USER_DATA or ACTION_ADMIN on msg.sender
 *
 * @dev This mock exists to prove "internal grant doesn't bypass external gate":
 *      PreviewView may have downstream roles to call PositionView, but external callers
 *      must still pass PreviewView's own entry gate (caller==user OR has viewer/admin role).
 */
contract MockPositionViewRoleGated {
    address public immutable registryAddr;

    mapping(address => mapping(address => uint256)) public collateral;
    mapping(address => mapping(address => uint256)) public debt;
    mapping(address => mapping(address => uint64)) public version;
    mapping(address => mapping(address => uint256)) public updateBlock;

    constructor(address registryAddr_) {
        registryAddr = registryAddr_;
    }

    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 c,
        uint256 d
    ) external {
        _write(user, asset, c, d, 0);
    }

    function getUserPositionWithMeta(
        address user,
        address asset
    )
        external
        view
        returns (
            uint256 collateral_,
            uint256 debt_,
            bool isValid,
            uint256 blockNumber,
            uint64 version_
        )
    {
        if (msg.sender != user) {
            bool ok = ViewAccessLib.hasRole(
                registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            ) ||
                ViewAccessLib.hasRole(
                    registryAddr,
                    ActionKeys.ACTION_VIEW_USER_DATA,
                    msg.sender
                );
            if (!ok) revert MissingRole();
        }
        return (
            collateral[user][asset],
            debt[user][asset],
            true,
            updateBlock[user][asset],
            version[user][asset]
        );
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
        require(newVersion > current, "MPVRG: stale ver");
        collateral[user][asset] = c;
        debt[user][asset] = d;
        version[user][asset] = newVersion;
        updateBlock[user][asset] = block.number;
    }
}
