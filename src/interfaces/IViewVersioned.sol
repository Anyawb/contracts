// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IViewVersioned
 * @notice Standardized versioning surface for upgradeable View modules.
 *
 * @dev
 * - apiVersion: external API contract for integrators (functions/events semantics).
 * - schemaVersion: cached/output schema contract (struct/event fields, encoding, interpretation).
 * - implementation: implementation address when called via proxy; falls back to `address(this)` otherwise.
 */
interface IViewVersioned {
    function getVersionInfo()
        external
        view
        returns (uint256 apiVersion, uint256 schemaVersion, address implementation);
}


