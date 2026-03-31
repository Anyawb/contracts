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
import {NotAContract, ZeroAddress} from "../errors/StandardErrors.sol";

/// @title IEasyRecycleDistributor
/// @notice Minimal recycle-settlement interface for EasyRecycleDistributor.
/// @dev Used by {EasyConsumption} to forward spent Easy into the canonical recycle split path.
interface IEasyRecycleDistributor {
    /// @notice Handles one Easy spend income and settles the configured recycle split.
    function handleEasyIncome(
        address payer,
        uint256 easyAmount,
        uint8 spendType
    ) external;
}

/// @title EasyConsumption
/// @notice Per-call Easy spending entry for EasiM and strategy API usage.
/// @dev Transfers exactly 1 Easy (18 decimals) from the caller-designated user
///      into {EasyRecycleDistributor} for canonical recycle settlement.
contract EasyConsumption is Initializable, UUPSUpgradeable, RewardModuleBase {
    using SafeERC20 for IERC20;

    enum SpendType {
        EasiMCall,
        StrategyApiCall
    }

    address private _registryAddr;
    uint256 private constant _SPEND_AMOUNT = 1e18;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the module with the Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - One-time initializer.
     * - Registry address becomes the SSOT for module resolution and role checks.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Spend Entries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Spends 1 Easy for an EasiM call.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - user is zero (see {ZeroAddress})
     *      - caller is not user and lacks ACTION_CONSUME_EASY
     *      - Registry missing KEY_EASY_TOKEN or KEY_EASY_RECYCLE_DISTRIBUTOR
     *      - Easy transferFrom reverts or returns false
     *      - {IEasyRecycleDistributor.handleEasyIncome} reverts
     *
     * Security:
     * - Caller may spend for itself directly; third-party spend requires
     *   ACTION_CONSUME_EASY.
     * - External calls to EasyToken and EasyRecycleDistributor are part of the
     *   canonical spend pipeline and are not best-effort.
     *
     * @param user Account whose Easy balance is charged.
     */
    function consumeEasiMCall(address user) external onlyValidRegistry {
        _consume(user, SpendType.EasiMCall);
    }

    /**
     * @notice Spends 1 Easy for a strategy API call.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - user is zero (see {ZeroAddress})
     *      - caller is not user and lacks ACTION_CONSUME_EASY
     *      - Registry missing KEY_EASY_TOKEN or KEY_EASY_RECYCLE_DISTRIBUTOR
     *      - Easy transferFrom reverts or returns false
     *      - {IEasyRecycleDistributor.handleEasyIncome} reverts
     *
     * Security:
     * - Caller may spend for itself directly; third-party spend requires
     *   ACTION_CONSUME_EASY.
     * - External calls to EasyToken and EasyRecycleDistributor are part of the
     *   canonical spend pipeline and are not best-effort.
     *
     * @param user Account whose Easy balance is charged.
     */
    function consumeStrategyApiCall(address user) external onlyValidRegistry {
        _consume(user, SpendType.StrategyApiCall);
    }

    /// @dev Executes the canonical spend path and emits RewardView observability best-effort.
    function _consume(address user, SpendType spendType) internal {
        if (user == address(0)) revert ZeroAddress();
        if (msg.sender != user) {
            _requireRole(ActionKeys.ACTION_CONSUME_EASY, msg.sender);
        }

        EasyToken token = EasyToken(
            Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN)
        );
        address recycle = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_EASY_RECYCLE_DISTRIBUTOR
        );

        IERC20(address(token)).safeTransferFrom(user, recycle, _SPEND_AMOUNT);

        IEasyRecycleDistributor(recycle).handleEasyIncome(
            user,
            _SPEND_AMOUNT,
            uint8(spendType)
        );

        _tryPushEasySpent(user, uint8(spendType), _SPEND_AMOUNT);
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
