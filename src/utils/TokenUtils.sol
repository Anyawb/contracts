// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ZeroAddress} from "../errors/StandardErrors.sol";
import {RWAAssetNotAllowed} from "../errors/StandardErrors.sol";

import {IRWAAssetPriceRead} from "../interfaces/IRWAAssetPriceRead.sol";
import {IRWATokenRegistry} from "../interfaces/IRWATokenRegistry.sol";
import {TokenUtilsInternal} from "./TokenUtilsInternal.sol";

/**
 * @title TokenUtils
 * @notice Convenience facade for token utility operations (delegate-less reuse).
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - This contract performs external token and oracle/registry calls.
 * - Owner may update dependency addresses; callers should treat these as trusted configuration.
 */
contract TokenUtils is Ownable {
    /*━━━━━━━━━━━━━━━ State Variables ━━━━━━━━━━━━━━━*/
    address private _priceOracleAddr;
    address private _tokenRegistryAddr;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when the price oracle address changes.
    /// @dev Emitted by {setPriceOracle} after the trusted oracle dependency is updated.
    event PriceOracleUpdated(address indexed newOracleAddr);

    /// @notice Emitted when the token registry address changes.
    /// @dev Emitted by {setTokenRegistry} after the trusted token-registry dependency is updated.
    event TokenRegistryUpdated(address indexed newRegistryAddr);

    /**
     * @notice Constructs the TokenUtils facade with trusted dependency addresses.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Stores externally provided dependency addresses as trusted configuration.
     * - Ownership is assigned to msg.sender.
     *
     * @param _priceOracle Initial price oracle address.
     * @param _tokenRegistry Initial token registry address.
     */
    constructor(
        address _priceOracle,
        address _tokenRegistry
    ) Ownable(msg.sender) {
        _priceOracleAddr = _priceOracle;
        _tokenRegistryAddr = _tokenRegistry;
    }

    /*━━━━━━━━━━━━━━━ Admin Views And Setters ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the configured price oracle address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return priceOracleAddr Configured price oracle address.
     */
    function priceOracleAddrVar() external view returns (address) {
        return _priceOracleAddr;
    }

    /**
     * @notice Backward-compatible getter for the price oracle address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return priceOracleAddr Configured price oracle address.
     */
    function priceOracle() external view returns (address) {
        return _priceOracleAddr;
    }

    /**
     * @notice Get the configured token registry address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return tokenRegistryAddr Configured token registry address.
     */
    function tokenRegistryAddrVar() external view returns (address) {
        return _tokenRegistryAddr;
    }

    /**
     * @notice Backward-compatible getter for the token registry address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return tokenRegistryAddr Configured token registry address.
     */
    function tokenRegistry() external view returns (address) {
        return _tokenRegistryAddr;
    }

    /**
     * @notice Update the price oracle address.
     * @dev Reverts if:
     *      - newOracleAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - onlyOwner.
     *
     * @param newOracleAddr New oracle address.
     */
    function setPriceOracle(address newOracleAddr) external onlyOwner {
        if (newOracleAddr == address(0)) revert ZeroAddress();
        _priceOracleAddr = newOracleAddr;
        emit PriceOracleUpdated(newOracleAddr);
    }

    /**
     * @notice Update the token registry address.
     * @dev Reverts if:
     *      - newRegistryAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - onlyOwner.
     *
     * @param newRegistryAddr New registry address.
     */
    function setTokenRegistry(address newRegistryAddr) external onlyOwner {
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        _tokenRegistryAddr = newRegistryAddr;
        emit TokenRegistryUpdated(newRegistryAddr);
    }

    /*━━━━━━━━━━━━━━━ External Callables ━━━━━━━━━━━━━━━*/

    /**
     * @notice Pull tokens (ERC20/ERC721/ERC1155) into this contract.
     * @dev Reverts if:
     *      - TokenUtilsInternal._pullTokenUniversal reverts
     *
     * Security:
     * - Performs external token calls.
     *
     * @param token Token contract address.
     * @param from Sender address.
     * @param id Token id (ERC721/ERC1155).
     * @param amount Amount (ERC20/ERC1155); for ERC721 pass 1.
     */
    function pullTokenUniversal(
        address token,
        address from,
        uint256 id,
        uint256 amount
    ) external {
        TokenUtilsInternal._pullTokenUniversal(token, from, id, amount);
    }

    /**
     * @notice Return ERC20 balance delta for an account.
     * @dev Reverts if:
     *      - TokenUtilsInternal._getBalanceDelta reverts
     *
     * Security:
     * - Performs a view-only external call to the token contract.
     *
     * @param token ERC20 token address.
     * @param account Account address.
     * @param beforeBalance Balance snapshot before (token decimals).
     * @return delta Observed balance increase relative to beforeBalance.
     */
    function getBalanceDelta(
        address token,
        address account,
        uint256 beforeBalance
    ) external view returns (uint256) {
        return
            TokenUtilsInternal._getBalanceDelta(token, account, beforeBalance);
    }

    /**
     * @notice Get USD price for a token (pass-through to oracle).
     * @dev Reverts if:
     *      - priceOracle == address(0) (ZeroAddress)
     *      - oracle call reverts (propagates)
     *
     * Security:
     * - Performs a view-only external call to the configured oracle.
     *
     * @param token Token address.
     * @return price Price value returned by the oracle.
     * @return decimals Decimal precision returned by the oracle.
     */
    function getPriceUSD(
        address token
    ) external view returns (uint256 price, uint8 decimals) {
        if (_priceOracleAddr == address(0)) revert ZeroAddress();
        return IRWAAssetPriceRead(_priceOracleAddr).getPriceUSD(token);
    }

    /**
     * @notice Validate whether an RWA token is allowed by the registry.
     * @dev Reverts if:
     *      - tokenRegistry == address(0) (ZeroAddress)
     *      - token is not allowed (RWAAssetNotAllowed)
     *
     * Security:
     * - Performs a view-only external call to the configured token registry.
     *
     * @param token Token address to validate.
     */
    function validateAllowedRWA(address token) external view {
        if (_tokenRegistryAddr == address(0)) revert ZeroAddress();
        bool allowed = IRWATokenRegistry(_tokenRegistryAddr).isAllowed(token);
        if (!allowed) revert RWAAssetNotAllowed(token);
    }
}
