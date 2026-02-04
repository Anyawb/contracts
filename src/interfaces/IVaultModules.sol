// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IVaultCore } from "./IVaultCore.sol";
import { IVaultRouter } from "./IVaultRouter.sol";
import { IVaultAdmin } from "./IVaultAdmin.sol";

/**
 * @title IVaultModules
 * @notice Convenience aggregate interface for Vault modules.
 * @dev This interface is a compile-time/type-generation convenience only.
 *      Implementations SHOULD NOT rely on this as an architectural coupling point.
 *
 * Reverts if:
 * - (none)
 *
 * Security:
 * - Read-only type aggregation; no stateful behavior.
 */
// solhint-disable-next-line no-empty-blocks
interface IVaultModules is IVaultCore, IVaultRouter, IVaultAdmin {
    // Inherits all functions from the sub-interfaces.
}