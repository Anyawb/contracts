// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVaultCoreMinimal
 * @notice Minimal VaultCore surface used by modules to resolve the View (VaultRouter) address.
 * @dev Architecture SSOT:
 *      - View address MUST be resolved via Registry.KEY_VAULT_CORE -> IVaultCoreMinimal.viewContractAddrVar().
 */
interface IVaultCoreMinimal {
    /**
     * @notice Get the View (VaultRouter) address.
     * @dev Reverts if:
     *      - (implementation-defined; typically does not revert)
     *
     * Security:
     * - Read-only resolver used by on-chain modules; must be stable and unambiguous (single source).
     *
     * @return viewAddress VaultRouter address
     */
    function viewContractAddrVar() external view returns (address);
}

