// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RewardManagerCore} from "./RewardManagerCore.sol";
import {IRewardManagerByOrder} from "../interfaces/IRewardManager.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {SystemEvents} from "../Vault/SystemEvents.sol";
import {Registry} from "../registry/Registry.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";
import {
    ZeroAddress,
    NotAContract,
    MissingRole
} from "../errors/StandardErrors.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @dev Minimal order-scoped RewardManagerCore adapter kept local for stable IDE and static-analysis resolution.
interface IRewardManagerCoreByOrder {
    function onLoanEventByOrder(
        address user,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        uint8 outcome
    ) external;
}

/// @title IRewardManagerCoreLiquidationPenalty
/// @notice Minimal liquidation-penalty interface exposed by RewardManagerCore.
/// @dev Used by {RewardManager} to quote and apply liquidation penalties
///      without importing the full RewardManagerCore surface.
interface IRewardManagerCoreLiquidationPenalty {
    /// @notice Quotes the current liquidation penalty for a user.
    function quoteLiquidationPenalty(
        address user
    ) external view returns (uint256 easyAmount);

    /// @notice Applies liquidation penalty based on the user's current locked Easy state.
    function applyLiquidationPenaltyByCurrentLock(
        address user,
        address executor
    ) external returns (uint256 easyAmount);

    /// @notice Updates the liquidation penalty rate in RewardManagerCore.
    function setLiquidationPenaltyBps(uint256 liquidationBps) external;
}

/// @title IEasyEmissionControllerByOrder
/// @notice Minimal order-scoped emission interface for EasyEmissionController.
/// @dev Used by {RewardManager} to trigger post-repayment Easy minting without importing the full implementation.
interface IEasyEmissionControllerByOrder {
    /// @notice Processes an order-level loan event with borrower, lender, and asset context.
    function onLoanEventByOrderWithLender(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        uint8 outcome
    ) external;
}

/// @title IRewardConfigEarnGovernance
/// @notice Minimal earn-governance write interface exposed by RewardConfig.
/// @dev Used by {RewardManager} to route earn-side governance writes into RewardConfig.
interface IRewardConfigEarnGovernance {
    /// @notice Updates dynamic reward parameters in RewardConfig/EarnConfig.
    function setDynamicRewardParams(
        uint256 thresholdEasy,
        uint256 multiplierBps
    ) external;

    /// @notice Updates one level multiplier in RewardConfig/EarnConfig.
    function setLevelMultiplier(uint8 level, uint256 multiplierBps) external;
}

/// @title RewardManager
/// @notice Unified write and governance entry point for the Reward subsystem.
/// @dev Read-only integrations MUST use RewardView.
///      This module only orchestrates Reward writes, governance, and gateway checks.
contract RewardManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    RewardModuleBase
{
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when a requested level is outside the supported 1..5 range. Used by {updateUserLevel}.
    error RewardManager__InvalidLevel(uint8 level);
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Registry contract address kept private to avoid read-path
    ///      fragmentation.
    address private _registryAddr;

    /// @notice Emitted when a penalty is applied through this gateway.
    /// @dev executor is the actual liquidation executor propagated into Reward accounting and monitoring.
    event PenaltyApplied(
        address indexed executor,
        address indexed user,
        uint256 easyAmount,
        uint256 blockNumber
    );

    /**
     * @notice Initializes the module.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - One-time initializer.
     * - Registry address becomes the SSOT for Reward module and ACL resolution.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal Module Resolution ━━━━━━━━━━━━━━━*/

    /// @dev Returns the RewardManagerCore implementation resolved from Registry.
    function _getRewardManagerCore() internal view returns (RewardManagerCore) {
        return
            RewardManagerCore(
                Registry(_registryAddr).getModuleOrRevert(
                    ModuleKeys.KEY_REWARD_MANAGER_CORE
                )
            );
    }

    /*━━━━━━━━━━━━━━━ RewardModuleBase ━━━━━━━━━━━━━━━*/

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Loan And Penalty Entries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Forwards one order-level loan event into RewardManagerCore.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_ORDER_ENGINE or KEY_REWARD_MANAGER_CORE
     *      - caller is not Registry[KEY_ORDER_ENGINE] (see {MissingRole})
     *      - downstream {IRewardManagerCoreByOrder.onLoanEventByOrder} reverts
     *
     * Security:
     * - Non-reentrant order-engine gateway.
     * - This is the canonical entry for order-based lock, unlock, and penalty accounting.
     *
     * @param user Borrower account.
     * @param orderId Order identifier.
     * @param amount Principal amount in the loan asset base units.
    * @param maturity Order maturity block (`maturityBlock`, block-based SSOT) forwarded to RewardManagerCore.
     * @param outcome Loan outcome enum defined by {IRewardManagerByOrder}.
     */
    function onLoanEventByOrder(
        address user,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        IRewardManagerByOrder.LoanEventOutcome outcome
    ) external onlyValidRegistry nonReentrant {
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ORDER_ENGINE
        );
        if (msg.sender != orderEngine) revert MissingRole();

        IRewardManagerCoreByOrder(address(_getRewardManagerCore()))
            .onLoanEventByOrder(
                user,
                orderId,
                amount,
                maturity,
                uint8(outcome)
            );
    }

    /**
     * @notice Processes one order-level loan event and, when available, triggers Easy emission.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_ORDER_ENGINE or KEY_REWARD_MANAGER_CORE
     *      - caller is not Registry[KEY_ORDER_ENGINE] (see {MissingRole})
     *      - downstream RewardManagerCore call reverts
     *      - downstream EasyEmissionController call reverts when the module is present and contract-backed
     *
     * Security:
     * - Non-reentrant order-engine gateway.
     * - EasyEmissionController is optional; missing or non-contract addresses are ignored deliberately.
     *
     * @param borrower Borrower account.
     * @param lender Lender account.
     * @param asset Borrowed asset used for Easy emission valuation.
     * @param orderId Order identifier.
     * @param amount Principal amount in the loan asset base units.
    * @param maturity Order maturity block (`maturityBlock`, block-based SSOT) forwarded downstream.
     * @param outcome Loan outcome enum defined by {IRewardManagerByOrder}.
     */
    function onLoanEventByOrderWithLender(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        IRewardManagerByOrder.LoanEventOutcome outcome
    ) external onlyValidRegistry nonReentrant {
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ORDER_ENGINE
        );
        if (msg.sender != orderEngine) revert MissingRole();

        IRewardManagerCoreByOrder(address(_getRewardManagerCore()))
            .onLoanEventByOrder(
                borrower,
                orderId,
                amount,
                maturity,
                uint8(outcome)
            );

        address controller = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_EASY_EMISSION_CONTROLLER
        );
        if (controller != address(0) && controller.code.length != 0) {
            IEasyEmissionControllerByOrder(controller)
                .onLoanEventByOrderWithLender(
                    borrower,
                    lender,
                    asset,
                    orderId,
                    amount,
                    maturity,
                    uint8(outcome)
                );
        }
    }

    /**
     * @notice Quotes the current liquidation penalty for a user.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_REWARD_MANAGER_CORE
     *      - downstream {IRewardManagerCoreLiquidationPenalty.quoteLiquidationPenalty} reverts
     *
     * Security:
     * - View-only gateway into RewardManagerCore.
     *
     * @param user Account to quote.
     * @return easyAmount Quoted Easy penalty amount, in 18 decimals.
     */
    function quoteLiquidationPenalty(
        address user
    ) external view onlyValidRegistry returns (uint256 easyAmount) {
        return
            IRewardManagerCoreLiquidationPenalty(
                address(_getRewardManagerCore())
            ).quoteLiquidationPenalty(user);
    }

    /**
     * @notice Applies the liquidation penalty derived from the user's current locked Easy balance.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_GUARANTEE_FUND or KEY_REWARD_MANAGER_CORE
     *      - caller is not Registry[KEY_GUARANTEE_FUND] (see {MissingRole})
     *      - downstream {IRewardManagerCoreLiquidationPenalty.applyLiquidationPenaltyByCurrentLock} reverts
     *
     * Security:
     * - Non-reentrant liquidation gateway restricted to GuaranteeFund.
     * - Penalty measurement stays in the Reward domain and is based on current aggregated lockedEasy.
     *
     * @param user Penalized account.
     * @return easyAmount Actual Easy penalty applied, in 18 decimals.
     */
    function applyLiquidationPenalty(
        address user
    ) external onlyValidRegistry nonReentrant returns (uint256 easyAmount) {
        address guaranteeFundManager = Registry(_registryAddr)
            .getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        if (msg.sender != guaranteeFundManager) revert MissingRole();

        easyAmount = IRewardManagerCoreLiquidationPenalty(
            address(_getRewardManagerCore())
        ).applyLiquidationPenaltyByCurrentLock(user, msg.sender);

        if (easyAmount > 0) {
            emit PenaltyApplied(msg.sender, user, easyAmount, block.number);
        }

        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Governance Writes ━━━━━━━━━━━━━━━*/

    /**
     * @notice Updates earn-side dynamic reward parameters.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - Registry missing KEY_REWARD_CONFIG or KEY_REWARD_MANAGER_CORE
     *      - downstream RewardConfig or RewardManagerCore call reverts
     *
     * Security:
     * - Governance-only write.
     * - RewardView observability push is best-effort once RewardManagerCore receives the updated values.
     *
     * @param thresholdEasy Easy threshold for enabling the dynamic reward boost.
     * @param multiplierBps Dynamic multiplier in BPS.
     */
    function setDynamicRewardParams(
        uint256 thresholdEasy,
        uint256 multiplierBps
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address rewardConfig = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_REWARD_CONFIG
        );
        IRewardConfigEarnGovernance(rewardConfig).setDynamicRewardParams(
            thresholdEasy,
            multiplierBps
        );
        _getRewardManagerCore().pushDynamicRewardParamsToView(
            thresholdEasy,
            multiplierBps
        );
    }

    /**
     * @notice Updates one earn-side level multiplier.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - Registry missing KEY_REWARD_CONFIG or KEY_REWARD_MANAGER_CORE
     *      - downstream RewardConfig or RewardManagerCore call reverts
     *
     * Security:
     * - Governance-only write.
     * - RewardView observability push is best-effort once RewardManagerCore receives the updated values.
     *
     * @param level User level whose multiplier is updated.
     * @param multiplierBps Multiplier in BPS, where 10000 = 1x.
     */
    function setLevelMultiplier(
        uint8 level,
        uint256 multiplierBps
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        address rewardConfig = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_REWARD_CONFIG
        );
        IRewardConfigEarnGovernance(rewardConfig).setLevelMultiplier(
            level,
            multiplierBps
        );
        _getRewardManagerCore().pushLevelMultiplierToView(level, multiplierBps);
    }

    /**
     * @notice Updates a user's Reward level.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - newLevel is outside 1..5 (see {RewardManager__InvalidLevel})
     *      - Registry missing KEY_REWARD_MANAGER_CORE
     *      - downstream {RewardManagerCore.updateUserLevel} reverts
     *
     * Security:
     * - Governance-only write.
     *
     * @param user Account whose level is updated.
     * @param newLevel New level in the inclusive range 1..5.
     */
    function updateUserLevel(
        address user,
        uint8 newLevel
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newLevel == 0 || newLevel > 5)
            revert RewardManager__InvalidLevel(newLevel);

        // Delegate the level write to RewardManagerCore, which owns the level ledger.
        _getRewardManagerCore().updateUserLevel(user, newLevel);
    }

    /**
     * @notice Updates the late-repayment penalty rate.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - Registry missing KEY_REWARD_MANAGER_CORE
     *      - downstream {RewardManagerCore.setLatePenaltyBps} reverts
     *
     * Security:
     * - Governance-only write.
     *
     * @param lateBps Late repayment penalty in BPS.
     */
    function setLatePenaltyBps(
        uint256 lateBps
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setLatePenaltyBps(lateBps);
    }

    /**
     * @notice Updates the liquidation penalty rate.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - caller lacks ACTION_SET_PARAMETER
     *      - Registry missing KEY_REWARD_MANAGER_CORE
     *      - downstream {IRewardManagerCoreLiquidationPenalty.setLiquidationPenaltyBps} reverts
     *
     * Security:
     * - Governance-only write.
     *
     * @param liquidationBps Liquidation penalty in BPS.
     */
    function setLiquidationPenaltyBps(
        uint256 liquidationBps
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        IRewardManagerCoreLiquidationPenalty(address(_getRewardManagerCore()))
            .setLiquidationPenaltyBps(liquidationBps);
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts if caller lacks ACTION_UPGRADE_MODULE or newImplementation is zero (see {ZeroAddress}).
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
