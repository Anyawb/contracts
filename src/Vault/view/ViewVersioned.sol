// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IViewVersioned } from "../../interfaces/IViewVersioned.sol";
import { ProxyIntrospectionLib } from "../../libraries/ProxyIntrospectionLib.sol";

/**
 * @title ViewVersioned
 * @notice Base contract for View modules to expose consistent versioning/introspection.
 *
 * @dev
 * - apiVersion: integrator-facing API contract (functions/events semantics)
 * - schemaVersion: cached/output schema contract (fields/encoding/interpretation)
 */
abstract contract ViewVersioned is IViewVersioned {
    function apiVersion() public pure virtual returns (uint256);
    function schemaVersion() public pure virtual returns (uint256);

    function getVersionInfo()
        external
        view
        override
        returns (uint256 apiVer, uint256 schemaVer, address implementation)
    {
        apiVer = apiVersion();
        schemaVer = schemaVersion();
        implementation = ProxyIntrospectionLib.getImplementationOrSelf();
    }
}


