// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "./Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ICacheRefreshable } from "../interfaces/ICacheRefreshable.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";

/// @title CacheMaintenanceManager
/// @notice Governance-gated, auditable, best-effort cache refresh entrypoint.
/// @dev This contract centralizes "refresh module cache" operations to reduce the exposed surface area and unify auditing.
contract CacheMaintenanceManager {
    /// @notice Emitted for every refresh attempt (success or failure).
    /// @param target Target contract address that was called.
    /// @param ok Whether the call succeeded.
    /// @param reason Raw revert data if failed; empty if succeeded.
    event CacheRefreshAttempted(address indexed target, bool ok, bytes reason);

    /// @notice Emitted after a batch refresh completes.
    /// @param total Total targets attempted.
    /// @param okCount Successful refresh count.
    /// @param failedCount Failed refresh count.
    event CacheRefreshBatchCompleted(uint256 total, uint256 okCount, uint256 failedCount);

    /// @notice Registry address (authoritative module registry).
    address private immutable _registryAddr;

    constructor(address registryAddr) {
        if (registryAddr == address(0)) revert ZeroAddress();
        _registryAddr = registryAddr;
    }

    // ============ Access control ============
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    modifier onlyGovernance() {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _;
    }

    // ============ Public ops ============

    /// @notice Batch refresh targets (best-effort; one failure does not stop others).
    /// @dev This is the ONLY on-chain entrypoint for cache refresh operations.
    function batchRefresh(address[] calldata targets) external onlyGovernance returns (uint256 okCount, uint256 failedCount) {
        uint256 total = targets.length;
        for (uint256 i; i < total; ) {
            bool ok = _refreshTarget(targets[i]);
            if (ok) okCount++; else failedCount++;
            unchecked { ++i; }
        }
        emit CacheRefreshBatchCompleted(total, okCount, failedCount);
    }

    /// @notice Expose Registry address (for tooling).
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // ============ Internal ============

    function _refreshTarget(address target) internal returns (bool ok) {
        if (target == address(0)) {
            emit CacheRefreshAttempted(target, false, abi.encodePacked("Zero target"));
            return false;
        }
        try ICacheRefreshable(target).refreshModuleCache() {
            emit CacheRefreshAttempted(target, true, "");
            return true;
        } catch (bytes memory reason) {
            emit CacheRefreshAttempted(target, false, reason);
            return false;
        }
    }
}

