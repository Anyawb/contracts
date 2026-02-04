// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { EventLibrary } from "./EventLibrary.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";

/// @title ModuleAccessLibrary
/// @notice Shared library for Registry module resolution with audit events.
/// @dev Provides common module access helpers and emits unified access/failure events.
/// @custom:security-contact security@example.com
library ModuleAccessLibrary {

    /// @dev Reverts when a resolved module address is zero.
    error ModuleAccessLibrary__InvalidModuleAddress(string moduleName);

    /**
     * @notice Resolve a module address from Registry and emit an access event.
     * @dev Reverts if:
     *      - registryAddr == address(0) (see {ZeroAddress})
     *      - Registry missing moduleKey (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Emits {EventLibrary.ModuleAccessed} with block.number as an observation field
     *
     * @param registryAddr Registry contract address.
     * @param moduleKey Module key to resolve.
     * @param caller Caller address recorded in the access event.
     * @return moduleAddress Resolved module address.
     */
    function getModule(
        address registryAddr,
        bytes32 moduleKey,
        address caller
    ) internal returns (address) {
        if (registryAddr == address(0)) revert ZeroAddress();
        
        address moduleAddress = Registry(registryAddr).getModuleOrRevert(moduleKey);
        
        // Emit module access event for auditability.
        emit EventLibrary.ModuleAccessed(
            moduleKey,
            moduleAddress,
            caller,
            block.number,
            EventLibrary.OPERATION_QUERY,
            ""
        );
        
        return moduleAddress;
    }

    /**
     * @notice Resolve a module address with best-effort semantics.
     * @dev Reverts if:
     *      - (none; returns address(0) on failures)
     *
     * Security:
     * - Best-effort: returns address(0) if registryAddr is zero or Registry call fails
     * - Emits {EventLibrary.ModuleAccessed} on success, {EventLibrary.ModuleCallFailure} on failure
     * - block.number is used as an observation field in emitted events
     *
     * @param registryAddr Registry contract address.
     * @param moduleKey Module key to resolve.
     * @param caller Caller address recorded in the access event.
     * @return moduleAddress Resolved module address, or address(0) on failure.
     */
    function safeGetModule(
        address registryAddr,
        bytes32 moduleKey,
        address caller
    ) internal returns (address) {
        if (registryAddr == address(0)) return address(0);
        
        try Registry(registryAddr).getModuleOrRevert(moduleKey) returns (address moduleAddress) {
            // Emit module access event for auditability.
            emit EventLibrary.ModuleAccessed(
                moduleKey,
                moduleAddress,
                caller,
                block.number,
                EventLibrary.OPERATION_QUERY,
                ""
            );
            
            return moduleAddress;
        } catch {
            // Emit failure event for monitoring and retry pipelines.
            emit EventLibrary.ModuleCallFailure(
                moduleKey,
                "Registry call failed",
                true,
                block.number
            );
            
            return address(0);
        }
    }

    /**
     * @notice Validate that a module address is non-zero.
     * @dev Reverts if:
     *      - moduleAddr == address(0) (see {ModuleAccessLibrary__InvalidModuleAddress})
     *
     * Security:
     * - Pure function
     *
     * @param moduleAddr Module address to validate.
     * @param moduleName Human-readable module name for error context.
     */
    function validateModuleAddress(address moduleAddr, string memory moduleName) internal pure {
        if (moduleAddr == address(0)) {
            revert ModuleAccessLibrary__InvalidModuleAddress(moduleName);
        }
    }
}
