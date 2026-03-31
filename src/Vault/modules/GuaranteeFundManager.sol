// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {
    AmountIsZero,
    AmountMismatch,
    NotAContract,
    NotEnoughGuarantee,
    ZeroAddress
} from "../../errors/StandardErrors.sol";
import {ActionKeys} from "../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../constants/ModuleKeys.sol";
import {SystemEvents} from "../SystemEvents.sol";
import {CacheEvents} from "../CacheEvents.sol";
import {LoanEvents} from "../../core/LoanEvents.sol";
import {Registry} from "../../registry/Registry.sol";
import {IAccessControlManager} from "../../interfaces/IAccessControlManager.sol";
import {DataPushLibrary} from "../../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../../constants/DataPushTypes.sol";
import {IGuaranteeFundManager} from "../../interfaces/IGuaranteeFundManager.sol";
import {IFeeRouterDistribution} from "../../interfaces/IFeeRouterDistribution.sol";
import {FeeTypes} from "../../constants/FeeTypes.sol";

/// @title IStatisticsPushManagerMinimal
/// @notice Minimal notification interface for StatisticsPushManager.
/// @dev Used by {GuaranteeFundManager} to trigger best-effort guarantee statistics refreshes.
interface IStatisticsPushManagerMinimal {
    /// @notice Requests a guarantee statistics refresh for one user and asset.
    function notifyGuarantee(address user, address asset) external;
}

/// @title IRewardManagerLiquidationPenalty
/// @notice Minimal liquidation-penalty interface exposed by RewardManager.
/// @dev Used by {GuaranteeFundManager} to trigger Reward-side liquidation
///      penalties without importing the full RewardManager implementation.
interface IRewardManagerLiquidationPenalty {
    /// @notice Applies liquidation penalty for one user and returns the deducted Easy amount.
    function applyLiquidationPenalty(
        address user
    ) external returns (uint256 easyAmount);
}

/**
 * @title GuaranteeFundManager
 * @notice Serves as the custody and transfer source of truth for the early-repayment guarantee fund.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - This module is the SSOT for guarantee-fund custody and transfers: lock, release, and forfeit.
 * - Guarantee records and rules remain in EarlyRepaymentGuaranteeManager.
 * - Module address resolution is centralized in Registry and must not be cached here.
 * - Write entrypoints are restricted to VaultCore or the configured orchestration module where applicable.
 * - Canonical guarantee events come from LoanEvents, and Statistics pushes remain best-effort.
 */
contract GuaranteeFundManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    IGuaranteeFundManager,
    LoanEvents,
    CacheEvents
{
    using SafeERC20 for IERC20;

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @dev user => asset => locked guarantee amount (token decimals).
    mapping(address => mapping(address => uint256)) private _userGuarantees;

    /// @dev asset => total locked guarantee amount across all users (token decimals).
    mapping(address => uint256) private _totalGuaranteesByAsset;

    /// @dev user => list of assets with current locked balance > 0 (for getUserGuaranteeAssets).
    mapping(address => address[]) private _userGuaranteeAssets;
    /// @dev user => asset => index+1 in `_userGuaranteeAssets[user]` (0 means not present).
    mapping(address => mapping(address => uint256))
        private _userGuaranteeAssetIndexPlusOne;

    /// @dev Registry address for module resolution and access control.
    address private _registryAddr;

    /// @dev Max batch size to keep gas bounded.
    uint256 internal constant _MAX_BATCH_SIZE = 50;

    // NOTE: This module intentionally does NOT store module address caches (SSOT is Registry).

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when a caller is not the current VaultCore registered in Registry.
    ///      Used by VaultCore-only write paths.
    error GuaranteeFundManager__OnlyVaultCore();
    /// @dev Reverts when a caller is neither VaultCore nor the configured
    ///      EarlyRepaymentGuaranteeManager. Used by settlement orchestration paths.
    error GuaranteeFundManager__OnlyAuthorizedCaller();
    /// @dev Reverts when paired batch arrays have different lengths. Used by batch guarantee operations.
    error GuaranteeFundManager__LengthMismatch();
    /// @dev Reverts when a required batch input is empty. Used by batch guarantee operations.
    error GuaranteeFundManager__EmptyArrays();
    /// @dev Reverts when a batch operation exceeds _MAX_BATCH_SIZE. Used by bounded batch guarantee operations.
    error GuaranteeFundManager__BatchTooLarge();
    /// @dev Reverts when a UUPS upgrade target has no deployed code. Used by {_authorizeUpgrade}.
    error GuaranteeFundManager__InvalidImplementation();

    /// @notice Best-effort Reward liquidation penalty applied after default settlement.
    event RewardLiquidationPenaltyApplied(
        address indexed user,
        address indexed rewardManager,
        uint256 easyAmount,
        uint256 blockNumber
    );

    /// @notice Best-effort Reward liquidation penalty failed after default settlement.
    event RewardLiquidationPenaltyApplyFailed(
        address indexed user,
        address indexed rewardManager,
        bytes reason,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Restrict calls to the current VaultCore resolved via Registry (SSOT).
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not KEY_VAULT_CORE (GuaranteeFundManager__OnlyVaultCore)
     *
     * Security:
     * - Enforces the VaultCore-only write boundary for this module.
     */
    modifier onlyVaultCore() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        address vaultCore = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_VAULT_CORE
        );
        if (msg.sender != vaultCore)
            revert GuaranteeFundManager__OnlyVaultCore();
        _;
    }

    /**
     * @notice Restrict guarantee lock entry to VaultCore or VaultBusinessLogic (borrow-time orchestration).
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is neither KEY_VAULT_CORE nor KEY_VAULT_BUSINESS_LOGIC (GuaranteeFundManager__OnlyLockOrchestrator)
     *
     * Security:
     * - Enforces "borrow-time lock" entrypoint convergence.
     */
    modifier onlyVaultCoreOrBusinessLogic() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        // Backward compat: do not depend on Registry having KEY_VAULT_CORE configured for custom error matching.
        address vaultCore = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_VAULT_CORE
        );
        if (msg.sender == vaultCore) {
            _;
            return;
        }
        address vbl = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_VAULT_BUSINESS_LOGIC
        );
        if (msg.sender != vbl) revert GuaranteeFundManager__OnlyVaultCore();
        _;
    }

    /**
     * @notice Restrict calls to VaultCore or the EarlyRepaymentGuaranteeManager (ERGM) resolved via Registry.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is neither KEY_VAULT_CORE nor KEY_EARLY_REPAYMENT_GUARANTEE
     *
     * Security:
     * - Used for settlement orchestration paths (early repayment / partial forfeit).
     * - SSOT: always resolve module addresses via Registry; do NOT cache.
     */
    modifier onlyVaultCoreOrEarlyRepaymentGuaranteeManager() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        address vaultCore = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_VAULT_CORE
        );
        // Short-circuit: if caller is VaultCore, do NOT require ERGM to be configured.
        if (msg.sender == vaultCore) {
            _;
            return;
        }
        address ergm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE
        );
        if (msg.sender != ergm)
            revert GuaranteeFundManager__OnlyAuthorizedCaller();
        _;
    }

    /**
     * @notice Ensure Registry address is configured.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *
     * Security:
     * - Prevents accidental operation before initialization / configuration.
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/
    /**
     * @notice Initialize the GuaranteeFundManager module.
     * @dev Reverts if:
     *      - initialVaultCoreAddr == address(0) (ZeroAddress) [backward-compatible deploy guard]
     *      - initialRegistryAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - initializer (callable once)
     * - UUPSUpgradeable: upgrade authorization is role-gated in `_authorizeUpgrade`
     * - ReentrancyGuard: external state-changing entrypoints are nonReentrant
     *
     * @param initialVaultCoreAddr VaultCore address (compat parameter; runtime SSOT is Registry).
     * @param initialRegistryAddr Registry address (non-zero).
     */
    function initialize(
        address initialVaultCoreAddr,
        address initialRegistryAddr,
        address /* upgradeAdmin */
    ) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;

        // Keep strict non-zero guards for backward-compatible deploy & test flows.
        if (initialVaultCoreAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        _registryAddr = initialRegistryAddr;
        // IMPORTANT (deploy order):
        // - Do NOT read KEY_VAULT_CORE during initialization.
        // - Deploy scripts may bind KEY_VAULT_CORE later; enforcing it here can break deployment order.
        // - Runtime modifiers enforce VaultCore SSOT via Registry.
        initialVaultCoreAddr; // silence unused-param warning

        // Emit a standardized action event for observability (business SSOT is Guarantee* + DataPush).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            blockNumber
        );
    }

    /*━━━━━━━━━━━━━━━ Internal Functions ━━━━━━━━━━━━━━━*/
    /// @dev Role check via Registry -> AccessControlManager (SSOT).
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice Return the Registry address reference used by this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return registryAddr Registry address.
     */
    function getRegistry() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /// @dev Best-effort notify the single Statistics push orchestrator (strict B+).
    ///      This module MUST NOT call StatisticsView directly so seq, requestId,
    ///      nextVersion, and failure events stay centralized.
    function _tryNotifyGuaranteeStatsPushManager(
        address user,
        address asset
    ) internal {
        address mgr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_STATS_PUSH_MANAGER
        );
        if (mgr == address(0) || mgr.code.length == 0) return;
        try IStatisticsPushManagerMinimal(mgr).notifyGuarantee(user, asset) {
            return;
        } catch {
            return;
        }
    }

    /// @dev Best-effort: default/liquidation reward penalty is triggered only after guarantee-fund settlement is final.
    ///      Reward is not part of the custody SSOT and must not block funds movement.
    function _tryApplyLiquidationRewardPenalty(address user) internal {
        address rewardManager = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_RM
        );
        if (rewardManager == address(0) || rewardManager.code.length == 0) {
            emit RewardLiquidationPenaltyApplyFailed(
                user,
                rewardManager,
                bytes("reward manager unavailable"),
                block.number
            );
            return;
        }

        try
            IRewardManagerLiquidationPenalty(rewardManager)
                .applyLiquidationPenalty(user)
        returns (uint256 easyAmount) {
            if (easyAmount > 0) {
                emit RewardLiquidationPenaltyApplied(
                    user,
                    rewardManager,
                    easyAmount,
                    block.number
                );
            }
        } catch (bytes memory reason) {
            emit RewardLiquidationPenaltyApplyFailed(
                user,
                rewardManager,
                reason,
                block.number
            );
        }
    }

    function _trackAssetIfNeeded(
        address user,
        address asset,
        uint256 newBalance
    ) internal {
        uint256 idxPlusOne = _userGuaranteeAssetIndexPlusOne[user][asset];
        if (newBalance == 0) {
            if (idxPlusOne == 0) return;
            uint256 idx = idxPlusOne - 1;
            address[] storage arr = _userGuaranteeAssets[user];
            uint256 lastIdx = arr.length - 1;
            if (idx != lastIdx) {
                address last = arr[lastIdx];
                arr[idx] = last;
                _userGuaranteeAssetIndexPlusOne[user][last] = idx + 1;
            }
            arr.pop();
            delete _userGuaranteeAssetIndexPlusOne[user][asset];
            return;
        }

        // newBalance > 0
        if (idxPlusOne != 0) return;
        _userGuaranteeAssets[user].push(asset);
        _userGuaranteeAssetIndexPlusOne[user][asset] = _userGuaranteeAssets[
            user
        ].length;
    }

    /**
     * @notice Return the current VaultCore address resolved via Registry (SSOT).
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - KEY_VAULT_CORE is not registered (propagated)
     *
     * Security:
     * - View-only.
     *
     * @return vaultCore Current VaultCore address resolved from Registry.
     */
    function vaultCoreAddr() external view returns (address vaultCore) {
        if (_registryAddr == address(0)) revert ZeroAddress();
        return
            Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_VAULT_CORE
            );
    }

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Return the locked guarantee amount for (user, asset).
     * @dev Reverts if:
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @param asset ERC20 guarantee asset address.
     * @return amount Current locked guarantee amount in token base units.
     */
    function getLockedGuarantee(
        address user,
        address asset
    ) external view override returns (uint256 amount) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _userGuarantees[user][asset];
    }

    /**
     * @notice Return the total locked guarantee amount for a given asset across all users.
     * @dev Reverts if:
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only.
     *
     * @param asset ERC20 guarantee asset address.
     * @return totalAmount Current total locked guarantee amount in token base units.
     */
    function getTotalGuaranteeByAsset(
        address asset
    ) external view override returns (uint256 totalAmount) {
        if (asset == address(0)) revert ZeroAddress();
        return _totalGuaranteesByAsset[asset];
    }

    /**
     * @notice Return the list of assets for which `user` currently has a non-zero locked guarantee balance.
     * @dev Reverts if:
     *      - user == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @return assets Asset addresses for which the user currently has a non-zero locked balance.
     */
    function getUserGuaranteeAssets(
        address user
    ) external view override returns (address[] memory assets) {
        if (user == address(0)) revert ZeroAddress();
        return _userGuaranteeAssets[user];
    }

    /**
     * @notice Return whether `user` currently has a non-zero locked guarantee for `asset`.
     * @dev Reverts if:
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @param asset ERC20 guarantee asset address.
     * @return paid True if the user currently has a non-zero locked balance for the asset.
     */
    function isGuaranteePaid(
        address user,
        address asset
    ) external view override returns (bool paid) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _userGuarantees[user][asset] > 0;
    }

    /*━━━━━━━━━━━━━━━ Core Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Lock `amount` of guarantee tokens from `user` into this contract (custody SSOT).
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not VaultCore (GuaranteeFundManager__OnlyVaultCore)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *      - amount == 0 (AmountIsZero)
     *      - ERC20 transferFrom fails (propagated)
     *
     * Security:
     * - nonReentrant
     * - onlyVaultCore (SSOT entrypoint)
     *
     * @param user Borrower address to pull funds from.
     * @param asset ERC20 guarantee asset address.
     * @param amount Amount to lock (token decimals).
     */
    function lockGuarantee(
        address user,
        address asset,
        uint256 amount
    )
        external
        override
        onlyVaultCoreOrBusinessLogic
        onlyValidRegistry
        nonReentrant
    {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        // SSOT fund movement: pull funds from `user` into this contract (custody).
        IERC20(asset).safeTransferFrom(user, address(this), amount);

        // Update user/asset balances (ledger).
        uint256 newBal = _userGuarantees[user][asset] + amount;
        _userGuarantees[user][asset] = newBal;
        _totalGuaranteesByAsset[asset] += amount;
        _trackAssetIfNeeded(user, asset, newBal);

        emit GuaranteeLocked(user, asset, amount, blockNumber);

        // Best-effort data push and StatisticsView cache update.
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_LOCKED,
            abi.encode(user, asset, amount, blockNumber)
        );
        _tryNotifyGuaranteeStatsPushManager(user, asset);
    }

    /**
     * @notice Release (refund) up to `amount` of locked guarantee tokens back to `user`.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not VaultCore (GuaranteeFundManager__OnlyVaultCore)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *      - amount == 0 (AmountIsZero)
     *      - ERC20 transfer fails (propagated)
     *
     * Security:
     * - nonReentrant
     * - onlyVaultCore (SSOT entrypoint)
     * - If amount exceeds current locked balance, this function releases the full available balance.
     *
     * @param user Borrower address to receive the refund.
     * @param asset ERC20 guarantee asset address.
     * @param amount Requested release amount (token decimals).
     */
    function releaseGuarantee(
        address user,
        address asset,
        uint256 amount
    ) external override onlyVaultCore onlyValidRegistry nonReentrant {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        uint256 currentGuarantee = _userGuarantees[user][asset];
        if (currentGuarantee < amount) {
            amount = currentGuarantee; // Release full available balance.
        }

        if (amount > 0) {
            uint256 newBal = currentGuarantee - amount;
            _userGuarantees[user][asset] = newBal;
            _totalGuaranteesByAsset[asset] -= amount;
            _trackAssetIfNeeded(user, asset, newBal);

            // Transfer to user (refund).
            IERC20(asset).safeTransfer(user, amount);

            emit GuaranteeReleased(user, asset, amount, blockNumber);

            // Best-effort data push and StatisticsView cache update.
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_RELEASED,
                abi.encode(user, asset, amount, blockNumber)
            );
            _tryNotifyGuaranteeStatsPushManager(user, asset);
        }
    }

    /**
     * @notice Forfeit the entire locked guarantee balance for (user, asset) to `feeReceiver`.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not VaultCore (GuaranteeFundManager__OnlyVaultCore)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *      - feeReceiver == address(0) (ZeroAddress)
     *      - ERC20 transfer fails (propagated)
     *
     * Security:
     * - nonReentrant
     * - onlyVaultCore (SSOT entrypoint)
     * - If current locked balance is 0, this function is a no-op and emits nothing.
     *
     * @param user Borrower address whose guarantee is forfeited.
     * @param asset ERC20 guarantee asset address.
     * @param feeReceiver Receiver of the forfeited funds.
     */
    function forfeitGuarantee(
        address user,
        address asset,
        address feeReceiver
    ) external override onlyVaultCore onlyValidRegistry nonReentrant {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (feeReceiver == address(0)) revert ZeroAddress();

        uint256 currentGuarantee = _userGuarantees[user][asset];
        if (currentGuarantee > 0) {
            _userGuarantees[user][asset] = 0;
            _totalGuaranteesByAsset[asset] -= currentGuarantee;
            _trackAssetIfNeeded(user, asset, 0);

            // Transfer to fee receiver (forfeit).
            IERC20(asset).safeTransfer(feeReceiver, currentGuarantee);

            emit GuaranteeForfeited(
                user,
                asset,
                currentGuarantee,
                feeReceiver,
                blockNumber
            );

            // Best-effort data push and StatisticsView cache update.
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
                abi.encode(
                    user,
                    asset,
                    currentGuarantee,
                    feeReceiver,
                    blockNumber
                )
            );
            _tryNotifyGuaranteeStatsPushManager(user, asset);
        }
    }

    /**
     * @notice Early repayment settlement: 3-way distribution of the full locked guarantee balance.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not VaultCore nor ERGM (GuaranteeFundManager__OnlyAuthorizedCaller)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *      - sum(refundToBorrower, penaltyToLender, platformFee) != lockedBalance (AmountMismatch)
     *      - (if penaltyToLender > 0) lender == address(0) (ZeroAddress)
     *      - (if platformFee > 0) platform == address(0) (ZeroAddress)
     *      - ERC20 transfers fail (propagated)
     *
     * Security:
     * - nonReentrant
     * - onlyVaultCoreOrEarlyRepaymentGuaranteeManager (settlement orchestrator)
     * - CEI: internal balance cleared before transfers
     *
     * @param user Borrower address.
     * @param asset ERC20 guarantee asset address.
     * @param lender Lender address receiving `penaltyToLender`.
     * @param refundToBorrower Amount refunded to borrower (token decimals).
     * @param penaltyToLender Amount paid to lender as penalty (token decimals).
     * @param platformFee Amount routed as platform fee (token decimals).
     */
    function settleEarlyRepayment(
        address user,
        address asset,
        address lender,
        uint256 refundToBorrower,
        uint256 penaltyToLender,
        uint256 platformFee
    )
        external
        override
        onlyVaultCoreOrEarlyRepaymentGuaranteeManager
        onlyValidRegistry
        nonReentrant
    {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        uint256 total = _userGuarantees[user][asset];
        uint256 sum;
        unchecked {
            sum = refundToBorrower + penaltyToLender + platformFee;
        }
        if (sum != total) revert AmountMismatch();

        // Clear internal balance before external transfers (CEI).
        _userGuarantees[user][asset] = 0;
        _totalGuaranteesByAsset[asset] -= total;
        _trackAssetIfNeeded(user, asset, 0);

        if (refundToBorrower > 0) {
            IERC20(asset).safeTransfer(user, refundToBorrower);
            emit GuaranteeReleased(user, asset, refundToBorrower, blockNumber);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_RELEASED,
                abi.encode(user, asset, refundToBorrower, blockNumber)
            );
            _tryNotifyGuaranteeStatsPushManager(user, asset);
        }

        if (penaltyToLender > 0) {
            if (lender == address(0)) revert ZeroAddress();
            IERC20(asset).safeTransfer(lender, penaltyToLender);
            emit GuaranteeForfeited(
                user,
                asset,
                penaltyToLender,
                lender,
                blockNumber
            );
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
                abi.encode(user, asset, penaltyToLender, lender, blockNumber)
            );
            _tryNotifyGuaranteeStatsPushManager(user, asset);
        }

        if (platformFee > 0) {
            address feeRouter = Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_FR
            );
            IERC20(asset).safeTransfer(feeRouter, platformFee);
            IFeeRouterDistribution(feeRouter).distributePrepaid(
                asset,
                platformFee,
                FeeTypes.FEE_TYPE_EARLY_REPAYMENT_PLATFORM,
                user
            );
            emit GuaranteeForfeited(
                user,
                asset,
                platformFee,
                feeRouter,
                blockNumber
            );
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
                abi.encode(user, asset, platformFee, feeRouter, blockNumber)
            );
            _tryNotifyGuaranteeStatsPushManager(user, asset);
        }
    }

    /**
     * @notice Forfeit a partial `amount` of locked guarantee to `receiver`.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not VaultCore nor ERGM (GuaranteeFundManager__OnlyAuthorizedCaller)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *      - receiver == address(0) (ZeroAddress)
     *      - amount == 0 (AmountIsZero)
     *      - amount > lockedBalance (NotEnoughGuarantee)
     *      - ERC20 transfer fails (propagated)
     *
     * Security:
     * - nonReentrant
     * - onlyVaultCoreOrEarlyRepaymentGuaranteeManager
     *
     * @param user Borrower address.
     * @param asset ERC20 guarantee asset address.
     * @param receiver Receiver of the forfeited amount.
     * @param amount Amount to forfeit (token decimals).
     */
    function forfeitPartial(
        address user,
        address asset,
        address receiver,
        uint256 amount
    )
        external
        override
        onlyVaultCoreOrEarlyRepaymentGuaranteeManager
        onlyValidRegistry
        nonReentrant
    {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (receiver == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        uint256 bal = _userGuarantees[user][asset];
        if (amount > bal) revert NotEnoughGuarantee();

        uint256 newBal = bal - amount;
        _userGuarantees[user][asset] = newBal;
        _totalGuaranteesByAsset[asset] -= amount;
        _trackAssetIfNeeded(user, asset, newBal);

        IERC20(asset).safeTransfer(receiver, amount);
        emit GuaranteeForfeited(user, asset, amount, receiver, blockNumber);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
            abi.encode(user, asset, amount, receiver, blockNumber)
        );
        _tryNotifyGuaranteeStatsPushManager(user, asset);
    }

    /**
     * @notice Forfeit a partial amount and then best-effort trigger Reward liquidation penalty.
     * @dev Reward-unit calculation remains inside Reward domain to avoid mixing guarantee asset units with Easy units.
     */
    function forfeitPartialWithRewardPenalty(
        address user,
        address asset,
        address receiver,
        uint256 amount
    )
        external
        override
        onlyVaultCoreOrEarlyRepaymentGuaranteeManager
        onlyValidRegistry
        nonReentrant
    {
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (receiver == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        uint256 bal = _userGuarantees[user][asset];
        if (amount > bal) revert NotEnoughGuarantee();

        uint256 newBal = bal - amount;
        _userGuarantees[user][asset] = newBal;
        _totalGuaranteesByAsset[asset] -= amount;
        _trackAssetIfNeeded(user, asset, newBal);

        IERC20(asset).safeTransfer(receiver, amount);
        emit GuaranteeForfeited(user, asset, amount, receiver, blockNumber);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
            abi.encode(user, asset, amount, receiver, blockNumber)
        );
        _tryNotifyGuaranteeStatsPushManager(user, asset);
        _tryApplyLiquidationRewardPenalty(user);
    }

    /**
     * @notice Default settlement: distribute the entire locked balance to multiple receivers.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not VaultCore (GuaranteeFundManager__OnlyVaultCore)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *      - receivers.length == 0 (GuaranteeFundManager__LengthMismatch)
     *      - receivers.length != amounts.length (GuaranteeFundManager__LengthMismatch)
     *      - receivers.length > _MAX_BATCH_SIZE (GuaranteeFundManager__BatchTooLarge)
     *      - sum(amounts) != lockedBalance (AmountMismatch)
     *      - any receiver == address(0) for a non-zero amount (ZeroAddress)
     *      - ERC20 transfers fail (propagated)
     *
     * Security:
     * - nonReentrant
     * - onlyVaultCore
     * - CEI: internal balance cleared before transfers
     *
     * @param user Borrower address.
     * @param asset ERC20 guarantee asset address.
     * @param receivers Receiver addresses.
     * @param amounts Amounts per receiver (token decimals).
     */
    function settleDefault(
        address user,
        address asset,
        address[] calldata receivers,
        uint256[] calldata amounts
    ) external override onlyVaultCore onlyValidRegistry nonReentrant {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        uint256 len = receivers.length;
        if (len == 0 || len != amounts.length)
            revert GuaranteeFundManager__LengthMismatch();
        if (len > _MAX_BATCH_SIZE) revert GuaranteeFundManager__BatchTooLarge();

        uint256 bal = _userGuarantees[user][asset];
        uint256 sum;
        unchecked {
            for (uint256 i = 0; i < len; i++) {
                sum += amounts[i];
            }
        }
        if (sum != bal) revert AmountMismatch();

        // Clear internal balance before external transfers (CEI).
        _userGuarantees[user][asset] = 0;
        _totalGuaranteesByAsset[asset] -= bal;
        _trackAssetIfNeeded(user, asset, 0);

        for (uint256 i = 0; i < len; i++) {
            address recv = receivers[i];
            uint256 amt = amounts[i];
            if (amt == 0) continue;
            if (recv == address(0)) revert ZeroAddress();
            IERC20(asset).safeTransfer(recv, amt);
            emit GuaranteeForfeited(user, asset, amt, recv, blockNumber);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_FORFEITED,
                abi.encode(user, asset, amt, recv, blockNumber)
            );
            _tryNotifyGuaranteeStatsPushManager(user, asset);
        }

        _tryApplyLiquidationRewardPenalty(user);
    }

    /*━━━━━━━━━━━━━━━ Batch Operations ━━━━━━━━━━━━━━━*/
    /**
     * @notice Batch lock guarantees for a single user across multiple assets.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not VaultCore (GuaranteeFundManager__OnlyVaultCore)
     *      - user == address(0) (ZeroAddress)
     *      - assets.length != amounts.length (GuaranteeFundManager__LengthMismatch)
     *      - assets.length == 0 (GuaranteeFundManager__EmptyArrays)
     *      - assets.length > _MAX_BATCH_SIZE (GuaranteeFundManager__BatchTooLarge)
     *      - any asset == address(0) for a non-zero amount (ZeroAddress)
     *      - ERC20 transferFrom fails (propagated)
     *
     * Security:
     * - nonReentrant
     * - onlyVaultCore
     * - Entries with amount == 0 are skipped.
     *
     * @param user Borrower address.
     * @param assets ERC20 guarantee asset addresses.
     * @param amounts Amounts to lock for each asset (token decimals).
     */
    function batchLockGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    )
        external
        override
        onlyVaultCoreOrBusinessLogic
        onlyValidRegistry
        nonReentrant
    {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        uint256 length = assets.length;
        if (length != amounts.length)
            revert GuaranteeFundManager__LengthMismatch();
        if (length == 0) revert GuaranteeFundManager__EmptyArrays();
        if (length > _MAX_BATCH_SIZE)
            revert GuaranteeFundManager__BatchTooLarge();

        for (uint256 i = 0; i < length; i++) {
            address asset = assets[i];
            uint256 amount = amounts[i];

            if (amount == 0) continue;
            if (asset == address(0)) revert ZeroAddress();

            // SSOT fund movement: pull funds from `user` into this contract (custody).
            IERC20(asset).safeTransferFrom(user, address(this), amount);

            uint256 newBal = _userGuarantees[user][asset] + amount;
            _userGuarantees[user][asset] = newBal;
            _totalGuaranteesByAsset[asset] += amount;
            _trackAssetIfNeeded(user, asset, newBal);

            emit GuaranteeLocked(user, asset, amount, blockNumber);

            // DataPush + StatisticsView cache update (per-item, best-effort).
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_GUARANTEE_LOCKED,
                abi.encode(user, asset, amount, blockNumber)
            );
            _tryNotifyGuaranteeStatsPushManager(user, asset);
        }

        // DataPush (batch summary).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_GUARANTEE_LOCKED,
            abi.encode(user, length, blockNumber)
        );
    }

    /**
     * @notice Batch release guarantees for a single user across multiple assets.
     * @dev Reverts if:
     *      - registry is zero (ZeroAddress)
     *      - caller is not VaultCore (GuaranteeFundManager__OnlyVaultCore)
     *      - user == address(0) (ZeroAddress)
     *      - assets.length != amounts.length (GuaranteeFundManager__LengthMismatch)
     *      - assets.length == 0 (GuaranteeFundManager__EmptyArrays)
     *      - assets.length > _MAX_BATCH_SIZE (GuaranteeFundManager__BatchTooLarge)
     *      - any asset == address(0) for a non-zero amount (ZeroAddress)
     *      - ERC20 transfer fails (propagated)
     *
     * Security:
     * - nonReentrant
     * - onlyVaultCore
     * - Entries with amount == 0 are skipped.
     * - If an entry's requested amount exceeds current balance, it releases the full balance for that asset.
     *
     * @param user Borrower address.
     * @param assets ERC20 guarantee asset addresses.
     * @param amounts Requested release amounts per asset (token decimals).
     */
    function batchReleaseGuarantees(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external override onlyVaultCore onlyValidRegistry nonReentrant {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        if (user == address(0)) revert ZeroAddress();
        uint256 length = assets.length;
        if (length != amounts.length)
            revert GuaranteeFundManager__LengthMismatch();
        if (length == 0) revert GuaranteeFundManager__EmptyArrays();
        if (length > _MAX_BATCH_SIZE)
            revert GuaranteeFundManager__BatchTooLarge();

        for (uint256 i = 0; i < length; i++) {
            address asset = assets[i];
            uint256 amount = amounts[i];

            if (amount == 0) continue;
            if (asset == address(0)) revert ZeroAddress();

            uint256 currentGuarantee = _userGuarantees[user][asset];
            if (currentGuarantee < amount) {
                amount = currentGuarantee;
            }

            if (amount > 0) {
                uint256 newBal = currentGuarantee - amount;
                _userGuarantees[user][asset] = newBal;
                _totalGuaranteesByAsset[asset] -= amount;
                _trackAssetIfNeeded(user, asset, newBal);

                // Transfer to user (refund).
                IERC20(asset).safeTransfer(user, amount);

                emit GuaranteeReleased(user, asset, amount, blockNumber);

                // Best-effort per-item data push and StatisticsView cache update.
                DataPushLibrary._emitData(
                    DataPushTypes.DATA_TYPE_GUARANTEE_RELEASED,
                    abi.encode(user, asset, amount, blockNumber)
                );
                _tryNotifyGuaranteeStatsPushManager(user, asset);
            }
        }

        // DataPush (batch summary).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_GUARANTEE_RELEASED,
            abi.encode(user, length, blockNumber)
        );
    }

    /*━━━━━━━━━━━━━━━ Upgrade Auth ━━━━━━━━━━━━━━━*/
    /**
     * @notice UUPS upgrade authorization hook.
     * @dev Reverts if:
     *      - caller lacks ActionKeys.ACTION_UPGRADE_MODULE (via ACM.requireRole)
     *      - newImplementation == address(0) (ZeroAddress)
     *      - newImplementation has no code (GuaranteeFundManager__InvalidImplementation)
     *
     * Security:
     * - Role-gated via ACM ActionKeys (ACTION_UPGRADE_MODULE)
     *
     * @param newImplementation New implementation address.
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        // NOTE (Time-Dependency-Refactor): use block number as the onchain time axis marker.
        uint256 blockNumber = block.number;
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();

        // Validate new implementation contract.
        if (newImplementation.code.length == 0)
            revert GuaranteeFundManager__InvalidImplementation();

        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            blockNumber
        );
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    /// @notice Storage gap for upgrade safety
    /// @dev SmartContractStandard baseline: keep `uint256[50] __gap` at the end to preserve upgrade flexibility.
    uint256[50] private __gap;
}
