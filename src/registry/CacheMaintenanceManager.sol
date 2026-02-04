// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "./Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ICacheRefreshable } from "../interfaces/ICacheRefreshable.sol";
import { NotAContract, ZeroAddress } from "../errors/StandardErrors.sol";

/**
 * @title CacheMaintenanceManager
 * @notice Governance-gated, auditable, best-effort module-cache refresh entrypoint (A-class cache).
 * @dev Reverts if:
 *      - registryAddr == address(0) (constructor)
 *      - caller lacks ACTION_SET_PARAMETER (via ACM)
 *      - Registry.KEY_CACHE_MAINTENANCE_MANAGER is unset or not equal to this contract
 *
 * Security:
 * - Single on-chain entrypoint for A-class module-address cache refresh
 * - Best-effort: one target failure does not stop the batch
 * - Emits per-target audit events with raw revert data (if any)
 *
 * Architecture guide alignment:
 * - A-class cache refresh is centralized:
 *   ICacheRefreshable.refreshModuleCache() + CacheMaintenanceManager.batchRefresh()
 */
contract CacheMaintenanceManager {
    // ============ Custom Errors ============
    /**
     * @notice CacheMaintenanceManager is not registered as the maintainer in Registry.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Thrown to ensure this contract is the single on-chain entrypoint for A-class cache refresh.
     *
     * @param configuredMaintainer The address currently configured in Registry for KEY_CACHE_MAINTENANCE_MANAGER.
     */
    error CacheMaintenanceManager__NotRegisteredAsMaintainer(address configuredMaintainer);

    /**
     * @notice A zero target address was provided in a refresh batch.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Used to encode failure reasons in audit events without reverting the whole batch.
     */
    error CacheMaintenanceManager__ZeroTarget();

    /**
     * @notice Emitted for every refresh attempt (success or failure).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - This is an audit event for off-chain monitoring and incident response.
     *
     * @param target Target contract address that was called.
     * @param ok Whether the call succeeded.
     * @param reason Raw revert data if failed; empty if succeeded.
     */
    event CacheRefreshAttempted(address indexed target, bool ok, bytes reason);

    /**
     * @notice Emitted after a batch refresh completes.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Off-chain consumers can use this as a cheap per-tx summary of batch results.
     *
     * @param total Total targets attempted.
     * @param okCount Successful refresh count.
     * @param failedCount Failed refresh count.
     */
    event CacheRefreshBatchCompleted(uint256 total, uint256 okCount, uint256 failedCount);

    /// @notice Registry address (authoritative module registry).
    address private immutable _registryAddr;

    /**
     * @notice Constructs the maintenance manager with a Registry address.
     * @dev Reverts if:
     *      - registryAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - Immutable registry address.
     *
     * @param registryAddr Registry contract address.
     */
    constructor(address registryAddr) {
        if (registryAddr == address(0)) revert ZeroAddress();
        _registryAddr = registryAddr;
    }

    // ============ Access control ============
    /**
     * @notice Requires a role via the global AccessControlManager resolved from Registry.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL is not registered (via Registry.getModuleOrRevert)
     *      - caller lacks role (via ACM.requireRole)
     *
     * Security:
     * - Read-only role check.
     *
     * @param actionKey ActionKeys.* role identifier.
     * @param user Caller address.
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    modifier onlyGovernance() {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _;
    }

    // ============ Public ops ============

    /**
     * @notice Batch refresh targets (best-effort; one failure does not stop others).
     * @dev Reverts if:
     *      - caller lacks ACTION_SET_PARAMETER
     *      - KEY_CACHE_MAINTENANCE_MANAGER is not registered or does not point to this contract
     *
     * Security:
     * - Best-effort loop; failures are captured in CacheRefreshAttempted events
     *
     * @param targets Contracts implementing ICacheRefreshable (module-address cache holders).
     * @return okCount Number of successful refreshes.
     * @return failedCount Number of failed refreshes.
     */
    function batchRefresh(address[] calldata targets)
        external
        onlyGovernance
        returns (uint256 okCount, uint256 failedCount)
    {
        // Safety: ensure targets that enforce "CacheMaintenanceManager-only" are compatible.
        address configuredMaint = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CACHE_MAINTENANCE_MANAGER);
        if (configuredMaint != address(this)) {
            revert CacheMaintenanceManager__NotRegisteredAsMaintainer(configuredMaint);
        }

        uint256 total = targets.length;
        for (uint256 i; i < total; ) {
            bool ok = _refreshTarget(targets[i]);
            if (ok) okCount++; else failedCount++;
            unchecked { ++i; }
        }
        emit CacheRefreshBatchCompleted(total, okCount, failedCount);
    }

    /**
     * @notice Returns the configured Registry address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only.
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // ============ Internal ============

    function _refreshTarget(address target) internal returns (bool ok) {
        if (target == address(0)) {
            emit CacheRefreshAttempted(
                target,
                false,
                abi.encodeWithSelector(CacheMaintenanceManager__ZeroTarget.selector)
            );
            return false;
        }
        if (target.code.length == 0) {
            // Reuse the standard error shape for consistent off-chain decoding.
            emit CacheRefreshAttempted(target, false, abi.encodeWithSelector(NotAContract.selector, target));
            return false;
        }
        try ICacheRefreshable(target).refreshModuleCache() {
            emit CacheRefreshAttempted(target, true, hex"");
            return true;
        } catch (bytes memory reason) {
            emit CacheRefreshAttempted(target, false, reason);
            return false;
        }
    }
}

