// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAuthorityWhitelistRead} from "./IAuthorityWhitelistRead.sol";
import {IAuthorityWhitelistAdmin} from "./IAuthorityWhitelistAdmin.sol";

/**
 * @title IAuthorityWhitelist
 * @notice Legacy umbrella interface for subject-level authority-name whitelists.
 * @dev Reverts if:
 *      - see inherited {IAuthorityWhitelistRead} and {IAuthorityWhitelistAdmin} semantics
 *
 * Security:
 * - Compatibility-only aggregation layer.
 * - Prefer {IAuthorityWhitelistRead} for ordinary checks and {IAuthorityWhitelistAdmin} for governance paths.
 */
interface IAuthorityWhitelist is
    IAuthorityWhitelistRead,
    IAuthorityWhitelistAdmin
{
    /**
     * @notice Returns whether `name` passes whitelist validation.
     * @dev Reverts if:
     *      - see {IAuthorityWhitelistRead.check}
     *
     * Security:
     * - Read-only compatibility alias for the narrow authority whitelist read surface.
     *
     * @param name Authority, role, or module name.
     * @return pass Whether the name is currently whitelisted.
     */
    function check(string calldata name) external view override returns (bool);

    /**
     * @notice Add a new authority name to the whitelist.
     * @dev Reverts if:
     *      - see {IAuthorityWhitelistAdmin.addAuthority}
     *
     * Security:
     * - Governance compatibility alias for the narrow authority whitelist admin surface.
     *
     * @param name Authority name.
     */
    function addAuthority(string calldata name) external override;

    /**
     * @notice Remove an authority name from the whitelist.
     * @dev Reverts if:
     *      - see {IAuthorityWhitelistAdmin.removeAuthority}
     *
     * Security:
     * - Governance compatibility alias for the narrow authority whitelist admin surface.
     *
     * @param name Authority name.
     */
    function removeAuthority(string calldata name) external override;

    /**
     * @notice Get the associated Registry address.
     * @dev Reverts if:
     *      - see {IAuthorityWhitelistAdmin.getRegistry}
     *
     * Security:
     * - Read-only metadata helper exposed for compatibility.
     *
     * @return registryAddr Registry address.
     */
    function getRegistry()
        external
        view
        override
        returns (address registryAddr);

    /**
     * @notice Update the Registry used for governance resolution.
     * @dev Reverts if:
     *      - see {IAuthorityWhitelistAdmin.setRegistry}
     *
     * Security:
     * - Governance compatibility alias for the narrow authority whitelist admin surface.
     *
     * @param newRegistryAddr New Registry address.
     */
    function setRegistry(address newRegistryAddr) external override;
}
