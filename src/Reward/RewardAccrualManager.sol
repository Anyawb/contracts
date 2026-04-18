// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Registry} from "../registry/Registry.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {
    ZeroAddress,
    NotAContract,
    MissingRole,
    InvalidCaller
} from "../errors/StandardErrors.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title RewardAccrualManager - Reward accrual + penalty ledger SSOT
/// @notice Centralizes penalty application and penalty offset across Reward accrual paths.
/// @dev Maintains pending Easy debt when immediate burns fail.
///      It offsets that debt before future reward mint or unlock operations.
contract RewardAccrualManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    RewardModuleBase
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Registry contract address
    address private _registryAddr;

    /// @notice Penalty ledger: pending Easy debt per user (EasyToken 18-decimal base units)
    mapping(address => uint256) private _penaltyLedger;

    /// @notice Emitted when a penalty is applied by burn or ledger accrual.
    /// @dev remainingDebt is zero when the burn succeeds and non-zero when unpaid debt remains in the ledger.
    event PenaltyApplied(
        bytes32 indexed actionKey,
        address indexed user,
        uint256 easyAmount,
        uint256 remainingDebt,
        string reason,
        address indexed executor,
        uint256 blockNumber
    );

    /// @notice Emitted when pending penalty debt is offset against an Easy accrual.
    /// @dev executor is the module that performed the offset call.
    event PenaltyOffsetApplied(
        bytes32 indexed actionKey,
        address indexed user,
        uint256 offsetEasyAmount,
        uint256 remainingDebt,
        string reason,
        address indexed executor,
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
     * - Registry address becomes the SSOT for gateway, token, and RewardView resolution.
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

    /*━━━━━━━━━━━━━━━ Penalty Entries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Applies a liquidation penalty directly from GuaranteeFundManager.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_GUARANTEE_FUND
     *      - caller is not Registry[KEY_GUARANTEE_FUND] (see {MissingRole})
     *      - amount is zero (see {InvalidCaller} via {_applyPenalty})
     *
     * Security:
     * - Non-reentrant direct entry for GFM.
     * - Burn failure is downgraded into penalty-ledger debt and does not revert the penalty path.
     *
     * @param user Penalized account.
     * @param easyAmount Easy amount to penalize, in 18 decimals.
     */
    function applyPenaltyByGfm(
        address user,
        uint256 easyAmount
    ) external onlyValidRegistry nonReentrant {
        address gfm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_GUARANTEE_FUND
        );
        if (msg.sender != gfm) revert MissingRole();
        _applyPenalty(
            ActionKeys.ACTION_LIQUIDATE,
            user,
            easyAmount,
            "LiquidationPenaltyByGFM",
            msg.sender
        );
    }

    /**
     * @notice Applies a liquidation penalty through the Reward gateway.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_RM, KEY_REWARD_MANAGER_CORE, or KEY_GUARANTEE_FUND
     *      - caller is neither RewardManager nor RewardManagerCore (see {MissingRole})
     *      - executor is not Registry[KEY_GUARANTEE_FUND] (see {InvalidCaller})
     *      - amount is zero (see {InvalidCaller} via {_applyPenalty})
     *
     * Security:
     * - Non-reentrant gateway path restricted to Reward write modules.
     * - executor is forced to the current GFM to keep liquidation attribution canonical.
     * - Burn failure is downgraded into penalty-ledger debt and does not revert the penalty path.
     *
     * @param user Penalized account.
     * @param easyAmount Easy amount to penalize, in 18 decimals.
     * @param executor Expected liquidation executor; MUST equal Registry[KEY_GUARANTEE_FUND].
     */
    function applyPenaltyFromGateway(
        address user,
        uint256 easyAmount,
        address executor
    ) external onlyValidRegistry nonReentrant {
        address rm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        address rmc = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_REWARD_MANAGER_CORE
        );
        if (msg.sender != rm && msg.sender != rmc) revert MissingRole();

        address gfm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_GUARANTEE_FUND
        );
        if (executor != gfm) revert InvalidCaller();

        _applyPenalty(
            ActionKeys.ACTION_LIQUIDATE,
            user,
            easyAmount,
            "LiquidationPenaltyByGFM",
            executor
        );
    }

    /**
     * @notice Applies a late-repayment penalty.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_REWARD_MANAGER_CORE
     *      - caller is not RewardManagerCore (see {MissingRole})
     *      - amount is zero (see {InvalidCaller} via {_applyPenalty})
     *
     * Security:
     * - Non-reentrant path restricted to RewardManagerCore.
     * - Burn failure is downgraded into penalty-ledger debt and does not revert the penalty path.
     *
     * @param user Penalized account.
     * @param easyAmount Easy amount to penalize, in 18 decimals.
     * @param executor Upstream executor recorded in the event payload.
     */
    function applyLateRepayPenalty(
        address user,
        uint256 easyAmount,
        address executor
    ) external onlyValidRegistry nonReentrant {
        address rmc = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_REWARD_MANAGER_CORE
        );
        if (msg.sender != rmc) revert MissingRole();
        _applyPenalty(
            ActionKeys.ACTION_LIQUIDATE,
            user,
            easyAmount,
            "LateRepayPenalty",
            executor
        );
    }

    /**
     * @notice Offsets pending penalty debt with a reward accrual.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_REWARD_MANAGER_CORE or KEY_EASY_EMISSION_CONTROLLER
     *      - caller is neither RewardManagerCore nor EasyEmissionController (see {MissingRole})
     *
     * Security:
     * - Non-reentrant path restricted to Reward accrual modules.
     * - Returns 0 when the accrual is fully consumed by debt.
     *   Callers MUST treat that as "nothing left to mint or unlock" rather
     *   than an error.
     * - RewardView push is best-effort and MUST NOT block debt settlement.
     *
     * @param user Account whose pending debt is offset.
     * @param easyRewardAmount Easy amount available for offset, in 18 decimals.
     * @param reason Short machine-readable reason recorded in the event payload.
     * @return netAmount Easy amount remaining after offset, in 18 decimals.
     */
    function offsetPenaltyOnReward(
        address user,
        uint256 easyRewardAmount,
        string calldata reason
    ) external onlyValidRegistry nonReentrant returns (uint256 netAmount) {
        if (easyRewardAmount == 0) return 0;

        // Allow RewardManagerCore and EasyEmissionController to offset
        address rmc = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_REWARD_MANAGER_CORE
        );
        address ec = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_EASY_EMISSION_CONTROLLER
        );
        if (msg.sender != rmc && msg.sender != ec) revert MissingRole();

        uint256 debt = _penaltyLedger[user];
        if (debt == 0) return easyRewardAmount;

        if (easyRewardAmount >= debt) {
            _penaltyLedger[user] = 0;
            _tryPushPenaltyLedger(user, 0);
            emit PenaltyOffsetApplied(
                ActionKeys.ACTION_CLAIM_REWARD,
                user,
                debt,
                0,
                reason,
                msg.sender,
                block.number
            );
            return easyRewardAmount - debt;
        }

        _penaltyLedger[user] = debt - easyRewardAmount;
        _tryPushPenaltyLedger(user, _penaltyLedger[user]);
        emit PenaltyOffsetApplied(
            ActionKeys.ACTION_CLAIM_REWARD,
            user,
            easyRewardAmount,
            _penaltyLedger[user],
            reason,
            msg.sender,
            block.number
        );
        return 0;
    }

    /**
     * @notice Returns a user's pending penalty debt.
     * @dev View-only helper.
     *
     * Security:
     * - No access restriction; used for observability and integration checks.
     *
     * @param user Account to query.
     * @return Pending Easy debt, in 18 decimals.
     */
    function getPenaltyDebt(address user) external view returns (uint256) {
        return _penaltyLedger[user];
    }

    /*━━━━━━━━━━━━━━━ RewardModuleBase ━━━━━━━━━━━━━━━*/

    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal Helpers ━━━━━━━━━━━━━━━*/

    /// @dev Attempts an immediate burn first; if burn fails, records debt in the ledger instead of reverting.
    function _applyPenalty(
        bytes32 actionKey,
        address user,
        uint256 amount,
        string memory reason,
        address executor
    ) internal {
        if (amount == 0) revert InvalidCaller();

        try _getRewardToken().burn(user, amount) {
            _tryPushEasyBurned(user, amount, reason);
            emit PenaltyApplied(
                actionKey,
                user,
                amount,
                _penaltyLedger[user],
                reason,
                executor,
                block.number
            );
            return;
        } catch {
            _penaltyLedger[user] += amount;
            _tryPushPenaltyLedger(user, _penaltyLedger[user]);
            emit PenaltyApplied(
                actionKey,
                user,
                amount,
                _penaltyLedger[user],
                reason,
                executor,
                block.number
            );
        }
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts if caller lacks ACTION_UPGRADE_MODULE or newImplementation is zero (see {ZeroAddress}).
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    uint256[49] private __gap;
}
