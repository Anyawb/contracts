// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {Registry} from "../../registry/Registry.sol";
import {ModuleKeys} from "../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../constants/ActionKeys.sol";
import {ICollateralManager} from "../../interfaces/ICollateralManager.sol";
import {CacheEvents} from "../CacheEvents.sol";
import {DataPushLibrary} from "../../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../../constants/DataPushTypes.sol";
import {IAccessControlManager} from "../../interfaces/IAccessControlManager.sol";
import {IPositionView} from "../../interfaces/IPositionView.sol";
import {IVaultCoreDataPush} from "../../interfaces/IVaultCoreDataPush.sol";
import {IVaultCoreMinimal} from "../../interfaces/IVaultCoreMinimal.sol";
import {ViewConstants} from "../view/ViewConstants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {NotAContract} from "../../errors/StandardErrors.sol";

/// @title IStatisticsPushManagerMinimal
/// @notice Minimal notification interface for StatisticsPushManager.
/// @dev Used by {CollateralManager} to trigger best-effort user statistics
///      refreshes without importing the full push-manager implementation.
interface IStatisticsPushManagerMinimal {
    /// @notice Requests a user statistics refresh.
    function notifyUserStats(address user) external;
}

/**
 * @title CollateralManager
 * @notice Maintains the collateral ledger and custody for direct-to-ledger writes.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - This contract holds real ERC20 collateral.
 * - User-path writes route VaultCore -> VaultRouter -> CollateralManager.
 * - Seizure paths remain role-gated by ACTION_LIQUIDATE at the ledger layer.
 * - View and cache pushes are best-effort and must not block ledger writes.
 */
contract CollateralManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    ICollateralManager,
    CacheEvents
{
    using SafeERC20 for IERC20;

    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    /*━━━━━━━━━━━━━━━ Configuration ━━━━━━━━━━━━━━━*/

    /// @notice Registry address (private storage).
    address private _registryAddr;

    /// @notice DataPush type constants live in DataPushTypes.

    /*━━━━━━━━━━━━━━━ Ledger Storage ━━━━━━━━━━━━━━━*/

    /// @notice User collateral ledger: user => asset => amount (token decimals).
    mapping(address => mapping(address => uint256)) private _userCollateral;

    /// @notice Total collateral by asset: asset => totalAmount (token decimals).
    mapping(address => uint256) private _totalCollateralByAsset;

    /// @notice User asset list: user => asset[].
    mapping(address => address[]) private _userAssets;

    /// @notice 1-based index into user asset list: user => asset => indexPlusOne.
    mapping(address => mapping(address => uint256)) private _userAssetIndex;

    /// @notice Cached user asset count.
    mapping(address => uint256) private _userAssetCount;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted after a deposit is processed.
    /// @dev Emitted by deposit flows after ledger and custody state are updated.
    event DepositProcessed(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for DepositProcessed.
    event DepositProcessedAtBlock(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /**
     * @notice Emitted after a withdraw is processed.
     * @dev Emitted by withdraw flows after ledger and custody state are updated.
     *
     * @param user User address
     * @param asset Collateral asset address
     * @param amount Amount withdrawn (token decimals)
     * @param blockNumber Legacy field: emission time axis marker (treated as blockNumber in this repo)
     */
    event WithdrawProcessed(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for WithdrawProcessed.
    event WithdrawProcessedAtBlock(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /**
     * @notice Emitted after a batch deposit is processed.
     * @dev Emitted by batch-deposit flows after the bounded batch finishes processing.
     *
     * @param user User address
     * @param operationCount Number of attempted operations
     * @param blockNumber Legacy field: emission time axis marker (treated as blockNumber in this repo)
     */
    event BatchDepositProcessed(
        address indexed user,
        uint256 operationCount,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for BatchDepositProcessed.
    event BatchDepositProcessedAtBlock(
        address indexed user,
        uint256 operationCount,
        uint256 blockNumber
    );

    /**
     * @notice Emitted after a batch withdraw is processed.
     * @dev Emitted by batch-withdraw flows after the bounded batch finishes processing.
     *
     * @param user User address
     * @param operationCount Number of attempted operations
     * @param blockNumber Legacy field: emission time axis marker (treated as blockNumber in this repo)
     */
    event BatchWithdrawProcessed(
        address indexed user,
        uint256 operationCount,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for BatchWithdrawProcessed.
    event BatchWithdrawProcessedAtBlock(
        address indexed user,
        uint256 operationCount,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when an address parameter is address(0).
    ///      Used by collateral entry, exit, and query validation paths.
    error CollateralManager__ZeroAddress();

    /// @dev Reverts when an amount is zero or otherwise invalid for the requested operation.
    ///      Used by collateral mutation paths.
    error CollateralManager__InvalidAmount();

    /// @dev Reverts when paired batch input arrays have different lengths.
    ///      Used by batch collateral operations.
    error CollateralManager__LengthMismatch();

    /// @dev Reverts when a user has insufficient collateral balance for the requested exit.
    ///      Used by withdraw and seize paths.
    error CollateralManager__InsufficientCollateral();

    /// @dev Reverts when a caller is not authorized for the requested collateral path.
    ///      Used by router, liquidation, and ACM-gated flows.
    error CollateralManager__UnauthorizedAccess();

    /*━━━━━━━━━━━━━━━ Access control ━━━━━━━━━━━━━━━*/

    /// @notice Ensures Registry is configured and is a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0))
            revert CollateralManager__ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @notice Allow VaultRouter as the sole user-path writer.
    /// @dev Architecture-Guide SSOT: user deposit/withdraw routes via VaultCore -> VaultRouter -> CollateralManager.
    ///      CollateralManager does not accept direct user-path writes from VaultCore to avoid bypassing routing guards.
    modifier onlyVaultRouter() {
        // Strict guard: CollateralManager is a custody/ledger SSOT and must not run with an invalid Registry.
        if (_registryAddr == address(0))
            revert CollateralManager__ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        address router = _resolveVaultRouterAddr();
        if (msg.sender != router)
            revert CollateralManager__UnauthorizedAccess();
        _;
    }

    /// @notice Allow VaultRouter, LiquidationManager, SettlementManager, or BlocksOnlyCoordinator to perform
    ///         collateral exits.
    /// @dev SettlementManager and BlocksOnlyCoordinator may return collateral to the borrower after debt-free
    ///      settlement,
    ///      while LiquidationManager remains the seizure executor for liquidation paths.
    modifier onlyAuthorizedCollateralExitCaller() {
        if (_registryAddr == address(0))
            revert CollateralManager__ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        address vaultRouter = _resolveVaultRouterAddr();
        address liquidationManager = _resolveLiquidationManagerAddr();
        address settlementManager = _resolveSettlementManagerAddr();
        address blocksOnlyCoordinator = _resolveBlocksOnlyCoordinatorAddr();
        if (
            msg.sender != vaultRouter &&
            msg.sender != liquidationManager &&
            msg.sender != settlementManager &&
            msg.sender != blocksOnlyCoordinator
        ) {
            revert CollateralManager__UnauthorizedAccess();
        }
        _;
    }

    /**
     * @notice Require AccessControlManager role.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL is not registered in Registry
     *      - caller does not have the required role
    /**
     * @notice Withdraws collateral to `receiver` under the authorized exit-caller policy.
     * @dev Reverts if:
     *      - caller is not VaultRouter, LiquidationManager, SettlementManager, or BlocksOnlyCoordinator
     *        (CollateralManager__UnauthorizedAccess)
     *      - receiver == address(0) (CollateralManager__ZeroAddress)
     *      - receiver == user and caller is not VaultRouter, SettlementManager, or BlocksOnlyCoordinator
     *        (CollateralManager__UnauthorizedAccess)
     *      - receiver != user and caller lacks ACTION_LIQUIDATE
    * - Delegates authorization to ACM.requireRole.
     *
     * @param actionKey Action key (bytes32, see ActionKeys)
     * @param caller Caller address to validate
     */
    function _requireRole(bytes32 actionKey, address caller) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(actionKey, caller);
    }

    /// @dev Best-effort notify the single Statistics push orchestrator (strict B+).
    ///      This ledger module MUST NOT call StatisticsView directly.
    function _tryNotifyStatsPushManager(address user) internal {
        address mgr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_STATS_PUSH_MANAGER
        );
        if (mgr == address(0) || mgr.code.length == 0) return;
        try IStatisticsPushManagerMinimal(mgr).notifyUserStats(user) {
            return;
        } catch {
            return;
        }
    }

    /*━━━━━━━━━━━━━━━ Construction & initialization ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize CollateralManager with Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (CollateralManager__ZeroAddress)
     *
     * Security:
     * - Initializer: callable only once
     * - UUPSUpgradeable: upgrade authorization is role-gated in `_authorizeUpgrade`
     * - ReentrancyGuard: external state-changing entrypoints are nonReentrant
     *
     * @param initialRegistryAddr Registry address (non-zero)
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0))
            revert CollateralManager__ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Core business logic ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when the best-effort View/cache push fails.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Failure-path event emission only.
     * - Emitted from catch blocks and never blocks ledger writes.
     *
     * @param user Target user address.
     * @param asset Collateral asset address.
     * @param reason Raw revert data.
     */
    event ViewCachePushFailed(
        address indexed user,
        address indexed asset,
        bytes reason
    );

    /**
     * @notice Handle collateral deposit (authority path).
     * @dev Reverts if:
     *      - user is zero
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - Pulls tokens from user (requires prior approve to CM)
     *
     * @param user User address (non-zero)
     * @param asset Collateral asset address (non-zero)
     * @param amount Collateral amount (token decimals)
     */
    function _processDeposit(
        address user,
        address asset,
        uint256 amount
    ) internal {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (asset == address(0)) revert CollateralManager__ZeroAddress();
        if (amount == 0) revert CollateralManager__InvalidAmount();

        // 0) Pull collateral into the pool (requires prior ERC20 approve to this contract).
        uint256 received = _pullTokenIntoPool(user, asset, amount);
        if (received == 0) revert CollateralManager__InvalidAmount();

        // 1) Update ledger.
        uint256 oldBalance = _userCollateral[user][asset];
        _userCollateral[user][asset] = oldBalance + received;
        _totalCollateralByAsset[asset] =
            _totalCollateralByAsset[asset] + received;

        // 2) Update user asset list.
        if (oldBalance == 0) {
            _addUserAsset(user, asset);
        }

        // 3) Best-effort View/cache push (delta-based).
        {
            uint64 nextVersion = _getNextVersion(user, asset);
            address vaultCore = _resolveVaultCoreAddr();
            bool pushedOk = false;
            try
                IVaultCoreDataPush(vaultCore).pushUserPositionUpdateDelta(
                    user,
                    asset,
                    _toInt(received),
                    int256(0),
                    bytes32(0),
                    0,
                    nextVersion
                )
            {
                pushedOk = true;
            } catch (bytes memory reason) {
                // Emit the canonical failure event for off-chain alerting and retry flows.
                address viewAddr = address(0);
                try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (
                    address v
                ) {
                    viewAddr = v;
                } catch {
                    viewAddr = address(0);
                }
                emit CacheUpdateFailed(
                    user,
                    asset,
                    viewAddr,
                    _userCollateral[user][asset],
                    0,
                    reason
                );
                emit ViewCachePushFailed(user, asset, reason);
            }
            pushedOk;
        }

        // 4) Emit business event.
        emit DepositProcessed(user, asset, received, block.number);
        emit DepositProcessedAtBlock(user, asset, received, block.number);

        // 5) Emit generic data bus event (DataPushed).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_DEPOSIT_PROCESSED,
            abi.encode(user, asset, received, block.number)
        );

        // 6) Best-effort notify stats push orchestrator (strict B+).
        _tryNotifyStatsPushManager(user);
    }

    /**
     * @notice Handle collateral withdrawal to user (authority path).
     * @dev Reverts if:
     *      - user is zero
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - Withdraws only to user (receiver=user)
     *
     * @param user User address (non-zero)
     * @param asset Collateral asset address (non-zero)
     * @param amount Withdraw amount (token decimals)
     */
    function _processWithdraw(
        address user,
        address asset,
        uint256 amount
    ) internal {
        // User withdraw: receiver is always user.
        _withdrawCollateralTo(user, asset, amount, user);
    }

    /**
     * @notice Unified collateral exit for user withdrawals, debt-free settlement releases, or seizure.
     * @dev Reverts if:
     *      - caller is not VaultRouter, LiquidationManager, SettlementManager, or BlocksOnlyCoordinator
     *        (CollateralManager__UnauthorizedAccess)
     *      - receiver == address(0) (CollateralManager__ZeroAddress)
     *      - receiver == user and caller is not VaultRouter, SettlementManager, or BlocksOnlyCoordinator
     *        (CollateralManager__UnauthorizedAccess)
     *      - receiver != user and caller lacks ACTION_LIQUIDATE
     *      - user, asset, amount, balance, or token-transfer checks fail in `_withdrawCollateralTo`
     *
     * Security:
     * - Non-reentrant collateral exit point shared by withdrawal, settlement, and seizure flows.
     * - BlocksOnlyCoordinator access is limited to returning collateral to the borrower for blocks-only repay or
     *   maturity settlement flows; it does not bypass liquidation role checks for third-party receivers.
     *
     * @param user Collateral owner address.
     * @param asset Collateral asset address.
     * @param amount Amount to withdraw in token base units.
     * @param receiver Recipient of real tokens (user for withdraw; liquidator/recipient for seizure).
     */
    function withdrawCollateralTo(
        address user,
        address asset,
        uint256 amount,
        address receiver
    ) external onlyAuthorizedCollateralExitCaller nonReentrant {
        if (receiver == address(0)) revert CollateralManager__ZeroAddress();
        // If receiver == user, only VaultRouter, SettlementManager, or BlocksOnlyCoordinator may call:
        // - VaultRouter: user-initiated withdraw
        // - SettlementManager: automatic collateral release after settle/repay
        // - BlocksOnlyCoordinator: blocks-only product-native repay/maturity settlement
        address vaultRouter = _resolveVaultRouterAddr();
        address settlementManager = _resolveSettlementManagerAddr();
        address blocksOnlyCoordinator = _resolveBlocksOnlyCoordinatorAddr();
        if (
            receiver == user &&
            msg.sender != vaultRouter &&
            msg.sender != settlementManager &&
            msg.sender != blocksOnlyCoordinator
        ) {
            revert CollateralManager__UnauthorizedAccess();
        }
        // Seizure path must be role-gated at the ledger layer (Architecture-Guide SSOT).
        if (receiver != user) {
            _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);
        }
        _withdrawCollateralTo(user, asset, amount, receiver);
    }

    /**
     * @notice Batch deposit collateral (authority path).
     * @dev Reverts if:
     *      - user is zero
     *      - assets/amounts length mismatch
     *      - batch size is zero or exceeds MAX_BATCH_SIZE
     *
     * Security:
     * - Non-reentrant
     * - Pulls tokens per asset from user (requires approve to CM)
     *
     * @param user User address (non-zero)
     * @param assets Collateral asset list (non-zero, len<=MAX_BATCH_SIZE)
     * @param amounts Amount list (token decimals)
     */
    function _batchProcessDeposit(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) internal {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (assets.length != amounts.length)
            revert CollateralManager__LengthMismatch();
        if (assets.length == 0 || assets.length > _MAX_BATCH_SIZE)
            revert CollateralManager__InvalidAmount();

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0))
                revert CollateralManager__ZeroAddress();
            if (amounts[i] == 0) revert CollateralManager__InvalidAmount();

            // Pull collateral per asset.
            uint256 received = _pullTokenIntoPool(user, assets[i], amounts[i]);
            if (received == 0) continue;

            // Update ledger per asset.
            uint256 oldBalance = _userCollateral[user][assets[i]];
            _userCollateral[user][assets[i]] = oldBalance + received;
            _totalCollateralByAsset[assets[i]] =
                _totalCollateralByAsset[assets[i]] + received;

            if (oldBalance == 0) {
                _addUserAsset(user, assets[i]);
            }

            // Best-effort View/cache push (delta-based).
            uint64 nextVersion = _getNextVersion(user, assets[i]);
            address vaultCore = _resolveVaultCoreAddr();
            bool pushedOk = false;
            try
                IVaultCoreDataPush(vaultCore).pushUserPositionUpdateDelta(
                    user,
                    assets[i],
                    _toInt(received),
                    int256(0),
                    bytes32(0),
                    0,
                    nextVersion
                )
            {
                pushedOk = true;
            } catch (bytes memory reason) {
                address viewAddr = address(0);
                try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (
                    address v
                ) {
                    viewAddr = v;
                } catch {
                    viewAddr = address(0);
                }
                emit CacheUpdateFailed(
                    user,
                    assets[i],
                    viewAddr,
                    _userCollateral[user][assets[i]],
                    0,
                    reason
                );
                emit ViewCachePushFailed(user, assets[i], reason);
            }
            pushedOk;
        }

        // Emit batch business event.
        emit BatchDepositProcessed(user, assets.length, block.number);
        emit BatchDepositProcessedAtBlock(user, assets.length, block.number);

        // Emit generic data bus event (DataPushed).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_DEPOSIT_PROCESSED,
            abi.encode(user, assets.length, block.number)
        );
    }

    /**
     * @notice Batch withdraw collateral (authority path).
     * @dev Reverts if:
     *      - user is zero
     *      - assets/amounts length mismatch
     *      - batch size is zero or exceeds MAX_BATCH_SIZE
     *
     * Security:
     * - Non-reentrant
     * - Receiver fixed to user in batch
     *
     * @param user User address (non-zero)
     * @param assets Collateral asset list (non-zero, len<=MAX_BATCH_SIZE)
     * @param amounts Amount list (token decimals)
     */
    function _batchProcessWithdraw(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) internal {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (assets.length != amounts.length)
            revert CollateralManager__LengthMismatch();
        if (assets.length == 0 || assets.length > _MAX_BATCH_SIZE)
            revert CollateralManager__InvalidAmount();

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0))
                revert CollateralManager__ZeroAddress();
            if (amounts[i] == 0) revert CollateralManager__InvalidAmount();
            // Batch user withdraw: receiver is always user.
            _withdrawCollateralTo(user, assets[i], amounts[i], user);
        }

        // Emit batch business event.
        emit BatchWithdrawProcessed(user, assets.length, block.number);
        emit BatchWithdrawProcessedAtBlock(user, assets.length, block.number);

        // Emit generic data bus event (DataPushed).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_WITHDRAW_PROCESSED,
            abi.encode(user, assets.length, block.number)
        );
    }

    /*━━━━━━━━━━━━━━━ Compatibility (legacy ABI) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Deposit collateral (authority path, routed by VaultRouter).
     * @dev Reverts if:
     *      - caller is not VaultRouter (CollateralManager__UnauthorizedAccess)
     *      - user/asset is zero (CollateralManager__ZeroAddress)
     *      - amount is zero (CollateralManager__InvalidAmount)
     *      - token transferFrom fails / received==0 (CollateralManager__InvalidAmount or ERC20 revert)
     *
     * Security:
     * - Non-reentrant
     * - Caller-gated: onlyVaultRouter (prevents bypassing VaultRouter routing guards)
     * - Funds custody: pulls ERC20 from user into this contract (pool)
     *
     * @param user User address (non-zero)
     * @param asset Collateral asset address (non-zero)
     * @param amount Amount to deposit (token decimals)
     */
    function depositCollateral(
        address user,
        address asset,
        uint256 amount
    ) external onlyVaultRouter nonReentrant {
        _processDeposit(user, asset, amount);
    }

    /**
     * @notice Withdraw collateral to user (authority path, routed by VaultRouter).
     * @dev Reverts if:
     *      - caller is not VaultRouter (CollateralManager__UnauthorizedAccess)
     *      - user/asset/amount is invalid or balance is insufficient (see `_withdrawCollateralTo`)
     *
     * Security:
     * - Non-reentrant
     * - Caller-gated: onlyVaultRouter
     * - Funds custody: transfers ERC20 from this contract (pool) to user
     *
     * @param user User address (non-zero)
     * @param asset Collateral asset address (non-zero)
     * @param amount Amount to withdraw (token decimals)
     */
    function withdrawCollateral(
        address user,
        address asset,
        uint256 amount
    ) external onlyVaultRouter nonReentrant {
        _processWithdraw(user, asset, amount);
    }

    /**
     * @notice Batch deposit collateral (authority path, routed by VaultRouter).
     * @dev Reverts if:
     *      - caller is not VaultRouter (CollateralManager__UnauthorizedAccess)
     *      - user is zero (CollateralManager__ZeroAddress)
     *      - assets/amounts length mismatch (CollateralManager__LengthMismatch)
     *      - batch size is zero or exceeds _MAX_BATCH_SIZE (CollateralManager__InvalidAmount)
     *      - any asset is zero (CollateralManager__ZeroAddress)
     *      - any amount is zero (CollateralManager__InvalidAmount)
     *
     * Security:
     * - Non-reentrant
     * - Caller-gated: onlyVaultRouter
     * - Funds custody: pulls ERC20 into this contract (pool) per asset
     */
    function batchDepositCollateral(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyVaultRouter nonReentrant {
        _batchProcessDeposit(user, assets, amounts);
    }

    /**
     * @notice Batch withdraw collateral to user (authority path, routed by VaultRouter).
     * @dev Reverts if:
     *      - caller is not VaultRouter (CollateralManager__UnauthorizedAccess)
     *      - user is zero (CollateralManager__ZeroAddress)
     *      - assets/amounts length mismatch (CollateralManager__LengthMismatch)
     *      - batch size is zero or exceeds _MAX_BATCH_SIZE (CollateralManager__InvalidAmount)
     *      - any asset is zero (CollateralManager__ZeroAddress)
     *      - any amount is zero (CollateralManager__InvalidAmount)
     *
     * Security:
     * - Non-reentrant
     * - Caller-gated: onlyVaultRouter
     * - Funds custody: transfers ERC20 from this contract (pool) to user per asset
     *
     * @param user User address (non-zero)
     * @param assets Collateral asset list (non-zero, len<=MAX_BATCH_SIZE)
     * @param amounts Amount list (token decimals)
     */
    function batchWithdrawCollateral(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyVaultRouter nonReentrant {
        _batchProcessWithdraw(user, assets, amounts);
    }

    /**
     * @notice Execute a collateral exit by updating the ledger, attempting the
     *         view push, and then transferring custody tokens.
     * @dev Reverts if:
     *      - user/asset/receiver is zero (CollateralManager__ZeroAddress)
     *      - amount is zero (CollateralManager__InvalidAmount)
     *      - user collateral balance < amount (CollateralManager__InsufficientCollateral)
     *      - ERC20 transfer fails (ERC20 revert)
     *
     * Security:
     * - Checks-effects-interactions: updates the ledger before the external ERC20 transfer.
     * - Best-effort view push: failures emit ViewCachePushFailed and do not revert the ledger write.
     *
     * @param user Collateral owner
     * @param asset Collateral asset
     * @param amount Amount (token decimals)
     * @param receiver Recipient of real tokens
     */
    function _withdrawCollateralTo(
        address user,
        address asset,
        uint256 amount,
        address receiver
    ) internal {
        if (user == address(0)) revert CollateralManager__ZeroAddress();
        if (asset == address(0)) revert CollateralManager__ZeroAddress();
        if (receiver == address(0)) revert CollateralManager__ZeroAddress();
        if (amount == 0) revert CollateralManager__InvalidAmount();

        uint256 currentBalance = _userCollateral[user][asset];
        if (currentBalance < amount)
            revert CollateralManager__InsufficientCollateral();

        // 1) Update ledger.
        _userCollateral[user][asset] = currentBalance - amount;
        _totalCollateralByAsset[asset] =
            _totalCollateralByAsset[asset] - amount;
        if (_userCollateral[user][asset] == 0) {
            _removeUserAsset(user, asset);
        }

        // 2) Best-effort View/cache push (delta-based).
        {
            uint64 nextVersion = _getNextVersion(user, asset);
            address vaultCore = _resolveVaultCoreAddr();
            bool pushedOk = false;
            try
                IVaultCoreDataPush(vaultCore).pushUserPositionUpdateDelta(
                    user,
                    asset,
                    -_toInt(amount),
                    int256(0),
                    bytes32(0),
                    0,
                    nextVersion
                )
            {
                pushedOk = true;
            } catch (bytes memory reason) {
                address viewAddr = address(0);
                try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (
                    address v
                ) {
                    viewAddr = v;
                } catch {
                    viewAddr = address(0);
                }
                emit CacheUpdateFailed(
                    user,
                    asset,
                    viewAddr,
                    _userCollateral[user][asset],
                    0,
                    reason
                );
                emit ViewCachePushFailed(user, asset, reason);
            }
            pushedOk;
        }

        // 3) Transfer real tokens from the pool to receiver.
        IERC20(asset).safeTransfer(receiver, amount);

        // 4) Emit business event + generic data bus event.
        emit WithdrawProcessed(user, asset, amount, block.number);
        emit WithdrawProcessedAtBlock(user, asset, amount, block.number);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_WITHDRAW_PROCESSED,
            abi.encode(user, asset, amount, block.number)
        );

        // 5) Best-effort notify stats push orchestrator (strict B+).
        _tryNotifyStatsPushManager(user);
    }

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return a user's current collateral balance for an asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @param asset Collateral asset address.
     * @return amount Current collateral amount in token base units.
     */
    function getCollateral(
        address user,
        address asset
    ) external view onlyValidRegistry returns (uint256 amount) {
        return _userCollateral[user][asset];
    }

    /**
     * @notice Return the system total collateral balance for an asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @param asset Collateral asset address.
     * @return totalCollateral Current total collateral amount in token base units.
     */
    function getTotalCollateralByAsset(
        address asset
    ) external view onlyValidRegistry returns (uint256 totalCollateral) {
        return _totalCollateralByAsset[asset];
    }

    /**
     * @notice Return the list of collateral assets currently tracked for a user.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @return assets Collateral asset addresses currently tracked for the user.
     */
    function getUserCollateralAssets(
        address user
    ) external view onlyValidRegistry returns (address[] memory assets) {
        uint256 count = _userAssetCount[user];
        assets = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            assets[i] = _userAssets[user][i];
        }
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @notice Add an asset to a user's asset list (idempotent).
    /// @param user User address
    /// @param asset Asset address
    function _addUserAsset(address user, address asset) internal {
        uint256 index = _userAssetIndex[user][asset];
        if (index == 0) {
            _userAssets[user].push(asset);
            _userAssetIndex[user][asset] = _userAssets[user].length;
            _userAssetCount[user]++;
        }
    }

    /// @notice Remove an asset from a user's asset list (swap-and-pop).
    /// @param user User address
    /// @param asset Asset address
    function _removeUserAsset(address user, address asset) internal {
        uint256 index = _userAssetIndex[user][asset];
        if (index > 0) {
            uint256 lastIndex = _userAssets[user].length - 1;
            address lastAsset = _userAssets[user][lastIndex];

            _userAssets[user][index - 1] = lastAsset;
            _userAssetIndex[user][lastAsset] = index;

            _userAssets[user].pop();
            delete _userAssetIndex[user][asset];
            _userAssetCount[user]--;
        }
    }

    /*━━━━━━━━━━━━━━━ Upgrade authorization ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when an upgrade attempt passes authorization checks.
    /// @dev Intentionally emitted to keep `_authorizeUpgrade` non-view (OZ UUPS hook signature).
    event UpgradeAuthorized(
        address indexed newImplementation,
        address indexed caller
    );

    /**
     * @notice UUPS upgrade authorization.
     * @dev Reverts if:
     *      - newImplementation is zero (CollateralManager__ZeroAddress)
     *      - caller missing ACTION_UPGRADE_MODULE (MissingRole via ACM)
     *      - KEY_ACCESS_CONTROL is not registered in Registry
     *
     * Security:
     * - Delegates to ACM.requireRole
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        if (newImplementation == address(0))
            revert CollateralManager__ZeroAddress();
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(
            ActionKeys.ACTION_UPGRADE_MODULE,
            msg.sender
        );

        emit UpgradeAuthorized(newImplementation, msg.sender);
    }

    uint256[50] private __gap;

    /*━━━━━━━━━━━━━━━ Internal utilities ━━━━━━━━━━━━━━━*/

    /// @notice Resolve VaultCore address (Registry KEY_VAULT_CORE).
    function _resolveVaultCoreAddr() internal view returns (address) {
        return
            Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_VAULT_CORE
            );
    }

    /// @notice Resolve VaultRouter address via VaultCore.viewContractAddrVar().
    function _resolveVaultRouterAddr() internal view returns (address) {
        return IVaultCoreMinimal(_resolveVaultCoreAddr()).viewContractAddrVar();
    }

    /// @notice Resolve the next PositionView version for a user and asset through a best-effort path.
    function _getNextVersion(
        address user,
        address asset
    ) internal view returns (uint64) {
        // Best-effort: missing/failed PositionView must not block ledger writes.
        address positionView = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_POSITION_VIEW
        );
        if (positionView == address(0) || positionView.code.length == 0)
            return 0;
        try
            IPositionView(positionView).getPositionVersion(user, asset)
        returns (uint64 version) {
            unchecked {
                return version + 1;
            }
        } catch {
            return 0;
        }
    }

    /// @notice Resolve LiquidationManager address (Registry KEY_LIQUIDATION_MANAGER).
    function _resolveLiquidationManagerAddr() internal view returns (address) {
        return
            Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_LIQUIDATION_MANAGER
            );
    }

    /// @notice Resolve SettlementManager address (Registry KEY_SETTLEMENT_MANAGER).
    /// @dev Uses getModule (non-revert) to keep user-path writes functional when SettlementManager is not deployed.
    function _resolveSettlementManagerAddr() internal view returns (address) {
        return
            Registry(_registryAddr).getModule(
                ModuleKeys.KEY_SETTLEMENT_MANAGER
            );
    }

    /// @notice Resolve the optional BlocksOnlyCoordinator address from Registry.
    /// @dev Uses `getModule` (non-revert) so collateral flows remain compatible when the blocks-only module is absent.
    function _resolveBlocksOnlyCoordinatorAddr()
        internal
        view
        returns (address)
    {
        return
            Registry(_registryAddr).getModule(
                ModuleKeys.KEY_BLOCKS_ONLY_COORDINATOR
            );
    }

    /// @notice Convert uint256 to int256 with overflow check.
    function _toInt(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max))
            revert CollateralManager__InvalidAmount();
        return int256(value);
    }

    /// @notice Pull tokens into the pool and return actual received amount (fee-on-transfer compatible).
    function _pullTokenIntoPool(
        address user,
        address asset,
        uint256 amount
    ) internal returns (uint256 received) {
        IERC20 token = IERC20(asset);
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(user, address(this), amount);
        uint256 afterBal = token.balanceOf(address(this));
        unchecked {
            received = afterBal - beforeBal;
        }
    }
}
