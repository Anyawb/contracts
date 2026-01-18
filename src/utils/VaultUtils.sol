// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ZeroAddress, AmountIsZero, InvalidHealthFactor, InvalidLTV } from "../errors/StandardErrors.sol";

/**
 * @title VaultUtils
 * @notice Stateless validation and helper utilities shared across modules.
 * @dev Security:
 * - Library functions are pure/view only; no external calls.
 * - Solidity ^0.8.x overflow/underflow checks apply (operations revert on overflow).
 */
library VaultUtils {
    
    /* ============ Constants ============ */
    /// @notice Minimum valid health factor in bps (10_000 = 100%).
    uint256 internal constant MIN_VALID_HF_BPS = 10000;
    
    /// @notice Maximum valid LTV in bps (10_000 = 100%).
    uint256 internal constant MAX_VALID_LTV_BPS = 10000;
    
    /// @notice Default minimum health factor in bps (11_000 = 110%).
    uint256 internal constant DEFAULT_MIN_HF_BPS = 11000;

    /* ============ Validation Functions ============ */
    
    /**
     * @notice Validate an address is non-zero.
     * @dev Reverts if:
     *      - addr == address(0) (ZeroAddress)
     *
     * Security:
     * - Pure validation only.
     *
     * @param addr Address to validate.
     */
    function validateAddress(address addr) internal pure {
        if (addr == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Validate an amount is non-zero.
     * @dev Reverts if:
     *      - amount == 0 (AmountIsZero)
     *
     * Security:
     * - Pure validation only.
     *
     * @param amount Amount to validate (token decimals).
     */
    function validateAmount(uint256 amount) internal pure {
        if (amount == 0) revert AmountIsZero();
    }

    /**
     * @notice Validate a health factor is within the supported range.
     * @dev Reverts if:
     *      - hfBps < MIN_VALID_HF_BPS (InvalidHealthFactor)
     *
     * Security:
     * - Pure validation only.
     *
     * @param hfBps Health factor in bps (10_000 = 100%).
     */
    function validateHealthFactor(uint256 hfBps) internal pure {
        if (hfBps < MIN_VALID_HF_BPS) revert InvalidHealthFactor();
    }

    /**
     * @notice Validate an LTV is within the supported range.
     * @dev Reverts if:
     *      - ltvBps > MAX_VALID_LTV_BPS (InvalidLTV)
     *
     * Security:
     * - Pure validation only.
     *
     * @param ltvBps LTV in bps (10_000 = 100%).
     */
    function validateLTV(uint256 ltvBps) internal pure {
        if (ltvBps > MAX_VALID_LTV_BPS) revert InvalidLTV();
    }

    /**
     * @notice Validate a numeric parameter is non-zero.
     * @dev Reverts if:
     *      - param == 0 (AmountIsZero)
     *
     * Security:
     * - Pure validation only.
     *
     * @param param Parameter value to validate (unit depends on caller).
     */
    function validateNonZero(uint256 param, string memory /* paramName */) internal pure {
        if (param == 0) revert AmountIsZero();
    }

    /* ============ Module Address Utilities ============ */
    
    /**
     * @notice Return whether a module address is configured (non-zero).
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure check only.
     *
     * @param moduleAddr Module address.
     * @return isConfigured True if moduleAddr != address(0).
     */
    function isModuleConfigured(address moduleAddr) internal pure returns (bool) {
        return moduleAddr != address(0);
    }

    /**
     * @notice Get a module address, falling back to a provided default if unset.
     * @dev Reverts if:
     *      - none (caller decides whether fallback may be zero)
     *
     * Security:
     * - Pure selection only.
     *
     * @param moduleAddr Preferred module address (may be zero).
     * @param fallbackAddr Fallback address (may be zero).
     * @return resolved Effective address chosen.
     */
    function getModuleAddress(address moduleAddr, address fallbackAddr) internal pure returns (address) {
        return moduleAddr != address(0) ? moduleAddr : fallbackAddr;
    }

    /**
     * @notice Get a module address with a non-zero guarantee.
     * @dev Reverts if:
     *      - resolved address is zero (ZeroAddress)
     *
     * Security:
     * - Pure selection + validation only.
     *
     * @param moduleAddr Preferred module address (may be zero).
     * @param fallbackAddr Fallback address (may be zero).
     * @return resolved Effective address chosen (non-zero).
     */
    function getModuleAddressSafe(
        address moduleAddr, 
        address fallbackAddr, 
        string memory /* moduleName */
    ) internal pure returns (address) {
        address result = getModuleAddress(moduleAddr, fallbackAddr);
        if (result == address(0)) {
            revert ZeroAddress();
        }
        return result;
    }

    /* ============ Math Utilities ============ */
    
    /**
     * @notice Compute amount * bps / 10_000 (deprecated; use VaultMath).
     * @dev Reverts if:
     *      - multiplication overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param amount Base amount (token decimals).
     * @param bps Basis points where 10_000 = 100% (0 is allowed).
     * @return result Floor(amount * bps / 10_000).
     */
    function calculateBps(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return (amount * bps) / 10000;
    }

    /**
     * @notice Compute LTV in bps (deprecated; use VaultMath).
     * @dev Reverts if:
     *      - debt * 10_000 overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param debt Debt amount/value (unit must match collateral).
     * @param collateral Collateral amount/value (unit must match debt).
     * @return ltvBps LTV in bps; returns 0 if collateral == 0.
     */
    function calculateLTV(uint256 debt, uint256 collateral) internal pure returns (uint256 ltvBps) {
        if (collateral == 0) return 0;
        return (debt * 10000) / collateral;
    }

    /**
     * @notice Compute health factor in bps with an additive bonus (deprecated; use VaultMath).
     * @dev Reverts if:
     *      - collateral * (10_000 + bonusBps) overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param collateral Total collateral value (unit must match debt).
     * @param debt Total debt value (unit must match collateral).
     * @param bonusBps Additive bonus in bps applied to collateral (10_000 = 100%).
     * @return healthFactorBps Health factor in bps; returns max uint if debt == 0.
     */
    function calculateHealthFactor(uint256 collateral, uint256 debt, uint256 bonusBps) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        return (collateral * (10000 + bonusBps)) / debt;
    }

    /**
     * @notice Compute health factor in bps with zero bonus (deprecated; use VaultMath).
     * @dev Reverts if:
     *      - same as calculateHealthFactor(collateral, debt, 0)
     *
     * Security:
     * - Pure math only.
     *
     * @param collateral Total collateral value (unit must match debt).
     * @param debt Total debt value (unit must match collateral).
     * @return healthFactorBps Health factor in bps; returns max uint if debt == 0.
     */
    function calculateMinHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        return calculateHealthFactor(collateral, debt, 0);
    }

    /* ============ Comparison Utilities ============ */
    
    /**
     * @notice Return whether a value is greater than zero.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure comparison only.
     *
     * @param value Value to check.
     * @return isGreater True if value > 0.
     */
    function isGreaterThanZero(uint256 value) internal pure returns (bool) {
        return value > 0;
    }

    /**
     * @notice Return whether a value is zero.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure comparison only.
     *
     * @param value Value to check.
     * @return isZeroFlag True if value == 0.
     */
    function isZero(uint256 value) internal pure returns (bool) {
        return value == 0;
    }

    /**
     * @notice Return whether an address is the zero address.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure comparison only.
     *
     * @param addr Address to check.
     * @return isZeroFlag True if addr == address(0).
     */
    function isZeroAddress(address addr) internal pure returns (bool) {
        return addr == address(0);
    }

    /* ============ Array Utilities ============ */
    
    /**
     * @notice Return whether two address arrays have equal length.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure comparison only.
     *
     * @param arr1 First array.
     * @param arr2 Second array.
     * @return isEqual True if arr1.length == arr2.length.
     */
    function arraysEqualLength(address[] memory arr1, address[] memory arr2) internal pure returns (bool) {
        return arr1.length == arr2.length;
    }

    /**
     * @notice Return whether two uint256 arrays have equal length.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure comparison only.
     *
     * @param arr1 First array.
     * @param arr2 Second array.
     * @return isEqual True if arr1.length == arr2.length.
     */
    function arraysEqualLength(uint256[] memory arr1, uint256[] memory arr2) internal pure returns (bool) {
        return arr1.length == arr2.length;
    }

    /**
     * @notice Validate an address array is non-empty.
     * @dev Reverts if:
     *      - arr.length == 0 (AmountIsZero)
     *
     * Security:
     * - Pure validation only.
     *
     * @param arr Array to validate.
     */
    function validateNonEmptyArray(address[] memory arr) internal pure {
        if (arr.length == 0) revert AmountIsZero();
    }

    /**
     * @notice Validate a uint256 array is non-empty.
     * @dev Reverts if:
     *      - arr.length == 0 (AmountIsZero)
     *
     * Security:
     * - Pure validation only.
     *
     * @param arr Array to validate.
     */
    function validateNonEmptyArray(uint256[] memory arr) internal pure {
        if (arr.length == 0) revert AmountIsZero();
    }
} 