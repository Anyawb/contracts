// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Registry} from "../registry/Registry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";
import {EasyToken} from "../Token/EasyToken.sol";
import {
    InvalidCaller,
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../errors/StandardErrors.sol";

/// @title EasyRecycleDistributor
/// @notice Receives spent Easy and settles the canonical 75/15/10 split.
/// @dev Normal spend flow is {EasyConsumption} -> {handleEasyIncome}.
///      Direct balance recovery uses {settleOutstandingEasyBalance}.
contract EasyRecycleDistributor is
    Initializable,
    UUPSUpgradeable,
    RewardModuleBase
{
    using SafeERC20 for IERC20;

    /// @notice Registry address
    address private _registryAddr;

    address private _teamRecipient;
    address private _ecoRecipient;

    /// @notice Emitted when team and ecosystem recipients are updated.
    /// @dev Emitted on initialization and governance updates.
    event RecipientsUpdated(
        address indexed teamRecipient,
        address indexed ecoRecipient,
        uint256 blockNumber
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the distributor and recipient addresses.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *      - teamRecipient or ecoRecipient is zero (see {ZeroAddress})
     *
     * Security:
     * - One-time initializer.
     * - Recipient addresses define the 15% team and 10% ecosystem sinks for all future settlements.
     *
     * @param initialRegistryAddr Registry contract address.
     * @param teamRecipient Recipient of the 15% team allocation.
     * @param ecoRecipient Recipient of the 10% ecosystem allocation.
     */
    function initialize(
        address initialRegistryAddr,
        address teamRecipient,
        address ecoRecipient
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        if (teamRecipient == address(0) || ecoRecipient == address(0))
            revert ZeroAddress();

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        _teamRecipient = teamRecipient;
        _ecoRecipient = ecoRecipient;

        emit RecipientsUpdated(teamRecipient, ecoRecipient, block.number);
    }

    /*━━━━━━━━━━━━━━━ Settlement Entries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Handles a spend income and applies the canonical burn/team/eco split.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_EASY_CONSUMPTION
     *      - caller is not Registry[KEY_EASY_CONSUMPTION] (see {MissingRole})
     *      - amount is zero (see {InvalidCaller})
     *      - downstream burn or ERC20 transfers revert
     *
     * Security:
     * - Restricted to the canonical spend gateway.
     * - Settlement is not best-effort; transfer or burn failures revert the entire call.
     *
     * @param payer Original account whose Easy spend triggered this settlement.
    * @param easyAmount Easy amount received by this contract, in 18 decimals.
     * @param spendType Reward spend category propagated to RewardView
     *        observability.
     */
    function handleEasyIncome(
        address payer,
        uint256 easyAmount,
        uint8 spendType
    ) external onlyValidRegistry {
        address consumption = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_EASY_CONSUMPTION
        );
        if (msg.sender != consumption) revert MissingRole();
        if (easyAmount == 0) revert InvalidCaller();

        _settleAmount(payer, easyAmount, spendType);
    }

    /**
     * @notice Settles any unexpected Easy balance held by this contract.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_EASY_TOKEN
     *      - this contract holds no Easy balance (see {InvalidCaller})
     *      - downstream burn or ERC20 transfers revert
     *
     * Security:
     * - Recovery-only path for accidental direct transfers.
     * - Anyone may trigger settlement once the module is valid in Registry.
     *   Funds still follow the fixed 75/15/10 split.
     *
     * @return amountSettled Easy amount settled from this contract balance, in 18 decimals.
     */
    function settleOutstandingEasyBalance()
        external
        onlyValidRegistry
        returns (uint256 amountSettled)
    {
        EasyToken token = EasyToken(
            Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN)
        );
        amountSettled = token.balanceOf(address(this));
        if (amountSettled == 0) revert InvalidCaller();

        _settleAmount(address(0), amountSettled, type(uint8).max);
    }

    /// @dev Settles one amount using the fixed 75/15/10 burn-team-eco split.
    function _settleAmount(
        address payer,
        uint256 amount,
        uint8 spendType
    ) internal {
        if (amount == 0) revert InvalidCaller();

        uint256 burnAmount = (amount * 75) / 100;
        uint256 teamAmount = (amount * 15) / 100;
        uint256 ecoAmount = amount - burnAmount - teamAmount;

        EasyToken token = EasyToken(
            Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN)
        );
        token.burn(address(this), burnAmount);

        IERC20(address(token)).safeTransfer(_teamRecipient, teamAmount);
        IERC20(address(token)).safeTransfer(_ecoRecipient, ecoAmount);

        _tryPushEasyRecycledSplit(
            payer,
            amount,
            burnAmount,
            teamAmount,
            ecoAmount,
            spendType
        );
    }

    /**
     * @notice Updates the team and ecosystem recipients.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - teamRecipient or ecoRecipient is zero (see {ZeroAddress})
     *
     * Security:
     * - Role-gated governance write.
     * - Changes affect all future 15%/10% distributions.
     *
     * @param teamRecipient New recipient of the 15% team allocation.
     * @param ecoRecipient New recipient of the 10% ecosystem allocation.
     */
    function setRecipients(
        address teamRecipient,
        address ecoRecipient
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (teamRecipient == address(0) || ecoRecipient == address(0))
            revert ZeroAddress();
        _teamRecipient = teamRecipient;
        _ecoRecipient = ecoRecipient;
        emit RecipientsUpdated(teamRecipient, ecoRecipient, block.number);
    }

    /**
     * @notice Returns the configured team and ecosystem recipients.
     * @dev Reverts if Registry validation fails in {onlyValidRegistry}.
     *
     * Security:
     * - View-only; no state mutation.
     *
     * @return teamRecipient Current recipient of the 15% team allocation.
     * @return ecoRecipient Current recipient of the 10% ecosystem allocation.
     */
    function getRecipients()
        external
        view
        onlyValidRegistry
        returns (address teamRecipient, address ecoRecipient)
    {
        return (_teamRecipient, _ecoRecipient);
    }

    /*━━━━━━━━━━━━━━━ RewardModuleBase ━━━━━━━━━━━━━━━*/

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts if caller lacks ACTION_UPGRADE_MODULE or newImplementation is zero (see {ZeroAddress}).
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    uint256[45] private __gap;
}
