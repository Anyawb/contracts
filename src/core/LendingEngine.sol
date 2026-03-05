// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ILoanNFT } from "../interfaces/ILoanNFT.sol";
import { IFeeRouter } from "../interfaces/IFeeRouter.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistryDynamicModuleKey } from "../interfaces/IRegistryDynamicModuleKey.sol";
import { SystemEvents } from "../Vault/SystemEvents.sol";
import { NotAContract, PausedSystem } from "../errors/StandardErrors.sol";
import { GracefulDegradation } from "../libraries/GracefulDegradation.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../constants/DataPushTypes.sol";
import { IRewardManager, IRewardManagerByOrder, IRewardManagerByOrderWithLender } from "../interfaces/IRewardManager.sol";
// NOTE:
// - This contract is the ORDER_ENGINE in the Architecture-Guide.
// - The debt ledger engine is KEY_LE (VaultLendingEngine).

/// @dev Minimal typed VaultCore interface for debt-ledger sync.
interface IVaultCoreRepayFor {
    function repayFor(address borrower, address asset, uint256 amount) external;
}

/// @dev Minimal typed LoanFlowPushManager notify interface (best-effort).
interface ILoanFlowPushManagerNotify {
    function notifyBorrow(address user, address asset, uint256 amountBaseUnits, uint256 orderId) external;
    function notifyRepay(
        address user,
        address asset,
        uint256 amountBaseUnits,
        uint256 orderId,
        uint256 repaidAmountAfter
    ) external;
}

/**
 * @title LendingEngine
 * @notice ORDER_ENGINE implementation: creates and settles loan orders (LoanNFT + DataPush side-effects).
 * @dev Architecture (SSOT):
 * - Debt ledger writes are NOT done here. They are done in KEY_LE (VaultLendingEngine / ILendingEngineBasic)
 *   via VaultCore.borrowFor / VaultCore.repayFor, per docs/Architecture-Guide.md.
 * - View-layer reads are exposed via LendingEngineView (0 gas). This contract provides a view-adapter
 *   surface (`*_ForView`) that LendingEngineView calls.
 *
 * Security (high-level):
 * - Role-gated entrypoints (ACM + ActionKeys)
 * - Pausable
 * - External calls: LoanNFT mint/update, FeeRouter distribution, VaultCore.repayFor
 * @custom:security-contact security@example.com
 */
contract LendingEngine is Initializable, PausableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;
    using GracefulDegradation for *;

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    struct LoanOrder {
        uint256 principal;
        uint256 rate;       // bps
        /// @dev SSOT (time refactor): term is measured in blocks (NOT seconds).
        ///      Frontend/keeper should do ETA mapping offchain.
        uint256 term;       // blocks
        address borrower;
        address lender;
        address asset;      // ERC20 address
        /// @dev Legacy field name kept for ABI stability.
        ///      SSOT (time refactor): this is a block number (startBlock), NOT time-in-seconds.
        uint256 startTimestamp;
        /// @dev Legacy field name kept for ABI stability.
        ///      SSOT (time refactor): this is a block number (maturityBlock), NOT time-in-seconds.
        uint256 maturity;
        uint256 repaidAmount;
    }

    /*━━━━━━━━━━━━━━━ STATE ━━━━━━━━━━━━━━━*/

    uint256 private _orderIdCounter;

    /// @notice Registry address (SSOT module resolver).
    address private _registryAddr;
    
    /// @notice RegistryDynamicModuleKey address (dynamic module key helper).
    IRegistryDynamicModuleKey private _registryDynamicModuleKey;
    
    /// @notice LoanNFT module address (cached best-effort).
    ILoanNFT private _loanNft;
    
    /// @notice FeeRouter module address (cached best-effort).
    IFeeRouter private _feeRouter;
    
    /// @notice Repayment fee in bps (e.g. 30 = 0.30%).
    uint256 private constant _REPAY_FEE_BPS = 30;
    /// @notice On-time window (blocks).
    /// @dev Block-based SSOT. Chain-dependent; UI/keepers MUST use offchain ETA mapping for wallclock display.
    uint256 private constant _ON_TIME_WINDOW_BLOCKS = 7200;

    /// @notice Allowed term durations (blocks).
    /// @dev Block-based SSOT. See `TermBlocksLib.termDaysToBlocks` for the legacy bucket mapping.
    uint256 private constant _DUR_5D_BLOCKS   = 36000;
    uint256 private constant _DUR_10D_BLOCKS  = 72000;
    uint256 private constant _DUR_15D_BLOCKS  = 108000;
    uint256 private constant _DUR_30D_BLOCKS  = 216000;
    uint256 private constant _DUR_60D_BLOCKS  = 432000;
    uint256 private constant _DUR_90D_BLOCKS  = 648000;
    uint256 private constant _DUR_180D_BLOCKS = 1296000;
    uint256 private constant _DUR_360D_BLOCKS = 2592000;

    /// @dev Baseline blocks-per-year used for simple interest pro-rating.
    ///      Block-based SSOT; chain-dependent and MUST NOT be interpreted as an on-chain wallclock year.
    uint256 private constant _YEAR_BLOCKS = 2628000;

    /// @notice Loan order storage.
    mapping(uint256 orderId => LoanOrder) private _loanOrders;
    
    /// @notice orderId -> LoanNFT tokenId.
    mapping(uint256 orderId => uint256 tokenId) private _orderToTokenId;

    /*━━━━━━━━━━━━━━━ GRACEFUL DEGRADATION ━━━━━━━━━━━━━━━*/
    
    /// @notice LoanNFT operation retry counters.
    mapping(uint256 => uint256) private _nftRetryCount;
    
    /// @notice Failed fee distribution accumulator: orderId -> amount.
    mapping(uint256 => uint256) private _failedFeeAmount;
    
    /// @notice External module health cache (reserved).
    mapping(address => bool) private _moduleHealthCache;
    
    /// @notice Maximum retry count for external module operations.
    uint256 private constant _MAX_RETRY_COUNT = 3;

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Legacy event kept for backward compatibility (prefer DataPushed).
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; consumers must treat ORDER_ENGINE as SSOT and prefer DataPushTypes.DATA_TYPE_LOAN_CREATED
     *
     * @param orderId Order id
     * @param borrower Borrower address
     * @param lender Lender address
     * @param principal Principal amount (token decimals of the debt asset)
     */
    event LoanOrderCreated(
        uint256 indexed orderId,
        address indexed borrower,
        address indexed lender,
        uint256 principal
    );
    
    /**
     * @notice Legacy event kept for backward compatibility (prefer DataPushed).
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; consumers must treat ORDER_ENGINE as SSOT and prefer DataPushTypes.DATA_TYPE_LOAN_REPAID
     *
     * @param orderId Order id
     * @param payer Repayer address
     * @param repayAmount Repay amount (token decimals of the debt asset)
     */
    event LoanRepaid(uint256 indexed orderId, address indexed payer, uint256 repayAmount);
    
    /**
     * @notice Emitted when the Registry address is updated.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; config writes are role-gated in implementation
     *
     * @param oldRegistry Previous Registry address
     * @param newRegistry New Registry address
     */
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    
    /**
     * @notice Emitted when RegistryDynamicModuleKey address is updated.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; config writes are role-gated in implementation
     *
     * @param oldAddr Previous address
     * @param newAddr New address
     */
    event RegistryDynamicModuleKeyUpdated(address indexed oldAddr, address indexed newAddr);

    /*━━━━━━━━━━━━━━━ MONITORING EVENTS ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Monitoring: LoanNFT operation retry attempt.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; emitted for ops/monitoring; must not be treated as SSOT over state transitions
     *
     * @param orderId Order id
     * @param operation Operation name (ASCII string)
     * @param retryCount Retry attempt index/count
     * @param success Whether the retry succeeded
     */
    event NftOperationRetried(uint256 indexed orderId, string operation, uint256 retryCount, bool success);

    /**
     * @notice Monitoring: fee distribution failure.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; emitted for ops/monitoring
     *
     * @param orderId Order id
     * @param feeAmount Fee amount attempted (token decimals)
     * @param reason Best-effort reason string (implementation-defined)
     */
    event FeeDistributionFailed(uint256 indexed orderId, uint256 feeAmount, string reason);

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Caller is not the match engine.
     * @dev Reverts if:
     *      - N/A (error selector only)
     *
     * Security:
     * - Enforces role separation in ORDER_ENGINE implementation
     */
    error LendingEngine__NotMatchEngine();
    /**
     * @notice Invalid order parameters or order state.
     * @dev Reverts if:
     *      - N/A (error selector only)
     *
     * Security:
     * - Guards order lifecycle invariants
     */
    error LendingEngine__InvalidOrder();
    /**
     * @notice Order is already fully repaid.
     * @dev Reverts if:
     *      - N/A (error selector only)
     */
    error LendingEngine__AlreadyRepaid();
    /**
     * @notice Invalid repay amount.
     * @dev Reverts if:
     *      - N/A (error selector only)
     */
    error LendingEngine__InvalidRepayAmount();
    /**
     * @notice Zero address provided where non-zero is required.
     * @dev Reverts if:
     *      - N/A (error selector only)
     */
    error LendingEngine__ZeroAddress();
    /**
     * @notice Registry is not configured.
     * @dev Reverts if:
     *      - N/A (error selector only)
     *
     * Security:
     * - Prevents module resolution on an unset Registry
     */
    error LendingEngine__RegistryNotSet();
    /**
     * @notice Invalid loan term.
     * @dev Reverts if:
     *      - N/A (error selector only)
     */
    error LendingEngine__InvalidTerm();
    /**
     * @notice Borrower level too low to borrow.
     * @dev Reverts if:
     *      - N/A (error selector only)
     */
    error LendingEngine__LevelTooLow();
    /**
     * @notice Invalid upgrade implementation (no code at target).
     * @dev Reverts if:
     *      - N/A (error selector only)
     */
    error LendingEngine__InvalidImplementation();
    /**
     * @notice LoanNFT minting failed.
     * @dev Reverts if:
     *      - N/A (error selector only)
     *
     * @param orderId Order id
     */
    error LendingEngine__NftMintFailed(uint256 orderId);

    /*━━━━━━━━━━━━━━━ MODIFIERS ━━━━━━━━━━━━━━━*/
    
    /// @notice Validate Registry address is set.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert LendingEngine__ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ INITIALIZER ━━━━━━━━━━━━━━━*/

    /**
     * @notice Initialize the ORDER_ENGINE.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (LendingEngine__ZeroAddress)
     *
     * Security:
     * - initializer (callable only once)
     *
     * @param initialRegistryAddr Registry address (SSOT module resolver).
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert LendingEngine__ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        __Pausable_init();

        _registryAddr = initialRegistryAddr;
        
        // Record for auditability (unified system event).
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Pause sensitive ORDER_ENGINE entrypoints.
     * @dev Reverts if:
     *      - caller lacks ACTION_PAUSE_SYSTEM
     *
     * Security:
     * - Role-gated via ACM (ACTION_PAUSE_SYSTEM)
     */
    function pause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_PAUSE_SYSTEM, msg.sender);
        _pause();
        
        // Record for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Unpause sensitive ORDER_ENGINE entrypoints.
     * @dev Reverts if:
     *      - caller lacks ACTION_UNPAUSE_SYSTEM
     *
     * Security:
     * - Role-gated via ACM (ACTION_UNPAUSE_SYSTEM)
     */
    function unpause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, msg.sender);
        _unpause();
        
        // Record for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            block.number
        );
    }
    
    /**
     * @notice Update the Registry address used for module resolution.
     * @dev Reverts if:
     *      - caller lacks ACTION_SET_PARAMETER
     *      - newRegistryAddr == address(0) (LendingEngine__ZeroAddress)
     *
     * Security:
     * - Role-gated via ACM (ACTION_SET_PARAMETER)
     *
     * @param newRegistryAddr New Registry address.
     */
    function updateRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert LendingEngine__ZeroAddress();
        if (newRegistryAddr.code.length == 0) revert NotAContract(newRegistryAddr);
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // Record for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
        
        // Emit module address update (compat/event stream).
        emit SystemEvents.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_LE),
            oldRegistry,
            newRegistryAddr,
            block.number
        );
    }
    
    /**
     * @notice Set the RegistryDynamicModuleKey helper contract address.
     * @dev Reverts if:
     *      - caller lacks ACTION_SET_PARAMETER
     *      - dynamicModuleKeyAddr == address(0) (LendingEngine__ZeroAddress)
     *
     * Security:
     * - Role-gated via ACM (ACTION_SET_PARAMETER)
     *
     * @param dynamicModuleKeyAddr RegistryDynamicModuleKey contract address.
     */
    function setRegistryDynamicModuleKey(address dynamicModuleKeyAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (dynamicModuleKeyAddr == address(0)) revert LendingEngine__ZeroAddress();
        
        address oldAddr = address(_registryDynamicModuleKey);
        _registryDynamicModuleKey = IRegistryDynamicModuleKey(dynamicModuleKeyAddr);
        
        emit RegistryDynamicModuleKeyUpdated(oldAddr, dynamicModuleKeyAddr);
        
        // Record for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ EXTERNAL FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Create a loan order and mint a LoanNFT certificate.
     * @dev Reverts if:
     *      - system is paused (PausedSystem)
     *      - caller lacks ACTION_ORDER_CREATE (via ACM)
     *      - order is invalid (LendingEngine__InvalidOrder)
     *      - order.lender is not the funding pool (LenderPoolVault) (LendingEngine__InvalidOrder)
     *      - term is not allowed (LendingEngine__InvalidTerm)
     *      - term is long-duration and borrower level is too low (LendingEngine__LevelTooLow)
     *
     * Security:
     * - Role-gated via ACM (ACTION_ORDER_CREATE)
     *
     * @param order LoanOrder input. Units:
     *  - principal: token decimals of `order.asset`
     *  - rate: bps (1e4 = 100%)
     *  - term: blocks (SSOT; no onchain time-in-seconds gates)
     * @return orderId Newly created order id.
     */
    function createLoanOrder(LoanOrder calldata order) external onlyValidRegistry returns (uint256 orderId) {
        _requireRole(ActionKeys.ACTION_ORDER_CREATE, msg.sender);
        if (paused()) revert PausedSystem();
        if (order.principal == 0 || order.borrower == address(0) || order.lender == address(0)) {
            revert LendingEngine__InvalidOrder();
        }
        // Option A enforcement: LoanOrder.lender must be the funding pool contract address (LenderPoolVault).
        // This prevents any path from writing an EOA/multisig into the order's lender field.
        address pool = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LENDER_POOL_VAULT);
        if (order.lender != pool) revert LendingEngine__InvalidOrder();

        // Term whitelist check.
        if (!_isAllowedDuration(order.term)) revert LendingEngine__InvalidTerm();
        // Long duration (>= _DUR_90D_BLOCKS baseline) requires user level >= 4 (RewardView gate).
        if (_isLongDuration(order.term)) {
            address rewardView = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_VIEW);
            uint8 level = IRewardViewBorrowCheck(rewardView).getUserLevelForBorrowCheck(order.borrower);
            if (level < 4) revert LendingEngine__LevelTooLow();
        }

        // Best-effort refresh module addresses.
        _updateModuleAddresses();

        orderId = _orderIdCounter;
        unchecked {
            _orderIdCounter++;
        }

        // Compute start/maturity.
        uint256 startBlock = block.number;
        uint256 maturityBlock;
        
        // Gas: unchecked arithmetic (startBlock + termBlocks).
        unchecked {
            maturityBlock = startBlock + order.term;
        }

        // Persist order.
        _loanOrders[orderId] = LoanOrder({
            principal: order.principal,
            rate: order.rate,
            term: order.term,
            borrower: order.borrower,
            lender: order.lender,
            asset: order.asset,
            startTimestamp: startBlock,
            maturity: maturityBlock,
            repaidAmount: 0
        });

        // Mint LoanNFT (with retry + graceful degradation).
        ILoanNFT.LoanMetadata memory meta = ILoanNFT.LoanMetadata({
            principal: order.principal,
            rate: order.rate,
            term: order.term,
            oraclePrice: 0, // optional: MatchEngine may supply a price snapshot off-chain
            loanId: orderId,
            collateralHash: bytes32(0),
            status: ILoanNFT.LoanStatus.Active
        });
        uint256 tokenId = _mintNftWithRetry(orderId, order.borrower, meta);
        _orderToTokenId[orderId] = tokenId;

        emit LoanOrderCreated(orderId, order.borrower, order.lender, order.principal);
        // Unified DataPush (SSOT event stream).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_CREATED,
            abi.encode(
                address(this),
                orderId,
                order.borrower,
                order.lender,
                order.principal,
                order.asset,
                tokenId,
                block.number
            )
        );

        // Best-effort notify LoanFlowPushManager (protocol loan-flow cache).
        // MUST NOT revert order creation; failures are observable via CacheUpdateFailedWithContext in the push manager.
        {
            address loanFlowPM = IRegistry(_registryAddr).getModule(ModuleKeys.KEY_LOAN_FLOW_PUSH_MANAGER);
            if (loanFlowPM != address(0) && loanFlowPM.code.length != 0) {
                try ILoanFlowPushManagerNotify(loanFlowPM).notifyBorrow(order.borrower, order.asset, order.principal, orderId) {
                    uint256 noop = 0;
                    noop;
                } catch {
                    uint256 noop = 0;
                    noop;
                }
            }
        }

        // Notify RewardManager after order creation.
        // - Prefer order-based callback (orderId/maturity/outcome); fallback to legacy onLoanEvent if unsupported.
        address rewardManagerBorrow = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        bool rewardNotified = false;
        try IRewardManagerByOrderWithLender(rewardManagerBorrow).onLoanEventByOrderWithLender(
            order.borrower,
            order.lender,
            order.asset,
            orderId,
            order.principal,
            maturityBlock,
            IRewardManagerByOrder.LoanEventOutcome.Borrow
        ) {
            rewardNotified = true;
        } catch {
            uint256 noop = 0;
            noop;
        }

        if (!rewardNotified) {
            try IRewardManagerByOrder(rewardManagerBorrow).onLoanEventByOrder(
                order.borrower,
                orderId,
                order.principal,
                maturityBlock,
                IRewardManagerByOrder.LoanEventOutcome.Borrow
            ) {
                rewardNotified = true;
            } catch {
                uint256 noop = 0;
                noop;
            }
        }

        if (!rewardNotified) {
            try IRewardManager(rewardManagerBorrow).onLoanEvent(order.borrower, order.principal, order.term, true) {
                uint256 noop = 0;
                noop;
            } catch {
                uint256 noop = 0;
                noop;
            }
        }

        // Record for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Repay a loan order (partial or full).
     * @dev Reverts if:
     *      - system is paused (PausedSystem)
     *      - caller lacks ACTION_REPAY (via ACM)
     *      - orderId is invalid (LendingEngine__InvalidOrder)
     *      - order is already fully repaid (LendingEngine__AlreadyRepaid)
     *      - repayAmount is zero or exceeds remaining due (LendingEngine__InvalidRepayAmount)
     *      - VaultCore.repayFor reverts (ExternalModuleRevertedRaw)
     *      - ERC20 transfer/approve fails (SafeERC20)
     *
     * Security:
     * - Role-gated via ACM (ACTION_REPAY)
     * - External calls: FeeRouter (best-effort), VaultCore.repayFor (hard requirement), ERC20 transfers
     *
     * @param orderId Target order id.
     * @param _repayAmount Amount to repay (token decimals of order.asset; includes interest and fees per this contract)
     *                    per this ORDER_ENGINE.
     */
    function repay(uint256 orderId, uint256 _repayAmount) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REPAY, msg.sender);
        if (paused()) revert PausedSystem();
        LoanOrder storage ord = _loanOrders[orderId];
        if (ord.borrower == address(0)) revert LendingEngine__InvalidOrder();

        // Best-effort refresh module addresses.
        _updateModuleAddresses();

        uint256 totalDue = _calculateTotalDue(ord);
        if (ord.repaidAmount >= totalDue) revert LendingEngine__AlreadyRepaid();
        if (_repayAmount == 0 || _repayAmount > totalDue - ord.repaidAmount) revert LendingEngine__InvalidRepayAmount();

        uint256 feeAmount;
        uint256 lenderAmount;
        uint256 repaidBefore = ord.repaidAmount;
        
        // Gas: unchecked arithmetic.
        unchecked {
            feeAmount = (_repayAmount * _REPAY_FEE_BPS) / 1e4;
            lenderAmount = _repayAmount - feeAmount;
            
            // --- Effects (CEI): update state before external interactions ---
            ord.repaidAmount += _repayAmount;
        }

        // Sync to debt ledger (VaultCore -> KEY_LE):
        // - This ORDER_ENGINE tracks principal+interest; KEY_LE tracks principal debt.
        // - Use a principal-first mapping: reduce principal by the delta of repaid principal.
        {
            uint256 principal = ord.principal;
            uint256 principalBefore = repaidBefore < principal ? repaidBefore : principal;
            uint256 principalAfter = ord.repaidAmount < principal ? ord.repaidAmount : principal;
            uint256 principalDelta = principalAfter - principalBefore;
            if (principalDelta > 0) {
                address vaultCore = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
                IVaultCoreRepayFor(vaultCore).repayFor(ord.borrower, ord.asset, principalDelta);
            }
        }

        // --- Interactions ---
        if (feeAmount > 0) {
            IERC20(ord.asset).safeTransferFrom(msg.sender, address(this), feeAmount);
            // slither-disable-next-line unchecked-transfer
            IERC20(ord.asset).approve(address(_feeRouter), feeAmount);
            
            // Best-effort: fee distribution should not block repayment.
            _distributeFeeWithFallback(orderId, ord.asset, feeAmount);
        }

        // Forward the remaining amount to the lender (pool).
        IERC20(ord.asset).safeTransferFrom(msg.sender, ord.lender, lenderAmount);

        emit LoanRepaid(orderId, msg.sender, _repayAmount);
        // Unified DataPush (SSOT event stream).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_REPAID,
            abi.encode(
                address(this),
                orderId,
                msg.sender,
                ord.borrower,
                ord.lender,
                _repayAmount,
                ord.repaidAmount,
                totalDue,
                ord.asset,
                block.number
            )
        );

        // Best-effort notify LoanFlowPushManager (protocol loan-flow cache).
        // MUST NOT revert repayment (ledger SSOT already synced via VaultCore.repayFor).
        {
            address loanFlowPM = IRegistry(_registryAddr).getModule(ModuleKeys.KEY_LOAN_FLOW_PUSH_MANAGER);
            if (loanFlowPM != address(0) && loanFlowPM.code.length != 0) {
                try ILoanFlowPushManagerNotify(loanFlowPM).notifyRepay(
                    ord.borrower, ord.asset, _repayAmount, orderId, ord.repaidAmount
                ) {
                    uint256 noop = 0;
                    noop;
                } catch {
                    uint256 noop = 0;
                    noop;
                }
            }
        }
        
        // Determine repayment outcome.
        bool isFullyRepaid = ord.repaidAmount >= totalDue;
        uint256 nowBlock = block.number;
        bool isOnTime =
            (nowBlock + _ON_TIME_WINDOW_BLOCKS >= ord.maturity) &&
            (nowBlock <= ord.maturity + _ON_TIME_WINDOW_BLOCKS);
        bool isOnTimeAndFullyRepaid = isFullyRepaid && isOnTime;
        
        // Record for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_REPAY,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY),
            msg.sender,
            block.number
        );

        // If fully repaid, update LoanNFT status.
        if (isFullyRepaid) {
            uint256 tokenId = _orderToTokenId[orderId];
            _loanNft.updateLoanStatus(tokenId, ILoanNFT.LoanStatus.Repaid);
        }

        // Notify RewardManager on full repay only (avoid partial repay side-effects).
        if (isFullyRepaid) {
            address rewardManagerRepay = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);

            // Order-based outcome.
            IRewardManagerByOrder.LoanEventOutcome outcome;
            if (isOnTimeAndFullyRepaid) {
                outcome = IRewardManagerByOrder.LoanEventOutcome.RepayOnTimeFull;
            } else {
                // Early: now + window < maturity (block-based)
                bool isEarly = (block.number + _ON_TIME_WINDOW_BLOCKS < ord.maturity);
                outcome = isEarly
                    ? IRewardManagerByOrder.LoanEventOutcome.RepayEarlyFull
                    : IRewardManagerByOrder.LoanEventOutcome.RepayLateFull;
            }

            // Prefer order-based callback with lender/asset, fallback to legacy.
            bool repayNotified = false;
            try IRewardManagerByOrderWithLender(rewardManagerRepay).onLoanEventByOrderWithLender(
                ord.borrower,
                ord.lender,
                ord.asset,
                orderId,
                ord.principal,
                ord.maturity,
                outcome
            ) {
                repayNotified = true;
            } catch {
                uint256 noop = 0;
                noop;
            }

            if (!repayNotified) {
                try IRewardManagerByOrder(rewardManagerRepay).onLoanEventByOrder(
                    ord.borrower, orderId, ord.principal, ord.maturity, outcome
                ) {
                    repayNotified = true;
                } catch {
                    uint256 noop = 0;
                    noop;
                }
            }

            if (!repayNotified) {
                try IRewardManager(rewardManagerRepay).onLoanEvent(
                    ord.borrower, _repayAmount, 0, isOnTimeAndFullyRepaid
                ) {
                    uint256 noop = 0;
                    noop;
                } catch {
                    uint256 noop = 0;
                    noop;
                }
            }
        }
    }

    /*━━━━━━━━━━━━━━━ View-adapter functions (used by LendingEngineView / SettlementManager) ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice View-adapter: get loan order data by id.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA (via ACM)
     *
     * Security:
     * - View-only
     * - Role-gated (ACTION_VIEW_SYSTEM_DATA)
     *
     * @param orderId Loan order id.
     * @return order Loan order snapshot.
     */
    function getLoanOrderForView(uint256 orderId) external view onlyValidRegistry returns (LoanOrder memory order) {
        // System/ops-only view adapter: used by LendingEngineView and SettlementManager.
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        
        return _loanOrders[orderId];
    }
    
    /**
     * @notice View-adapter: count number of loan orders for a borrower.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA (via ACM)
     *
     * Security:
     * - View-only
     * - Role-gated (ACTION_VIEW_SYSTEM_DATA)
     *
     * @param user Borrower address.
     * @return count Number of loan orders.
     */
    function getUserLoanCountForView(address user) external view onlyValidRegistry returns (uint256 count) {
        // System/ops-only view adapter: used by LendingEngineView and off-chain diagnostics.
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        
        uint256 currentOrderId = _orderIdCounter;
        for (uint256 i = 0; i < currentOrderId; i++) {
            if (_loanOrders[i].borrower == user) {
                count++;
            }
        }
    }
    
    /**
     * @notice View-adapter: get accumulated failed fee amount for an order.
     * @dev Reverts if:
     *      - caller lacks ACTION_SET_PARAMETER (via ACM)
     *
     * Security:
     * - View-only
     * - Admin-gated (ACTION_SET_PARAMETER)
     *
     * @param orderId Loan order id.
     * @return feeAmount Accumulated failed fee amount (token decimals of the order asset).
     */
    function getFailedFeeAmountForView(uint256 orderId) external view onlyValidRegistry returns (uint256 feeAmount) {
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        
        return _failedFeeAmount[orderId];
    }
    
    /**
     * @notice View-adapter: get LoanNFT retry count for an order.
     * @dev Reverts if:
     *      - caller lacks ACTION_SET_PARAMETER (via ACM)
     *
     * Security:
     * - View-only
     * - Admin-gated (ACTION_SET_PARAMETER)
     *
     * @param orderId Loan order id.
     * @return retryCount Retry count.
     */
    function getNftRetryCountForView(uint256 orderId) external view onlyValidRegistry returns (uint256 retryCount) {
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        
        return _nftRetryCount[orderId];
    }
    
    // NOTE: monitoring registry is removed; no "monitor count" API is exposed.
    
    /**
     * @notice View-adapter: access check for a loan order.
     * @dev This function is intentionally NOT reverting:
     *      it returns false on missing order / missing registry / lookup failures.
     *
     * Security:
     * - View-only
     *
     * @param orderId Loan order id.
     * @param user User address to check.
     * @return hasAccess Whether `user` is allowed to view the order.
     */
    function canAccessLoanOrderForView(uint256 orderId, address user) external view returns (bool hasAccess) {
        LoanOrder memory order = _loanOrders[orderId];
        
        // Missing order.
        if (order.borrower == address(0)) return false;
        
        // Borrower or lender.
        if (order.borrower == user || order.lender == user) return true;
        
        // Admin role fallback.
        if (_registryAddr == address(0)) return false;
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL) returns (address acmAddr) {
            return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_SET_PARAMETER, user);
        } catch {
            return false;
        }
    }
    
    /**
     * @notice View-adapter: check whether an account is considered a "match engine".
     * @dev Current implementation treats ACTION_ORDER_CREATE as the capability signal.
     *
     * Security:
     * - View-only
     *
     * @param account Account to check.
     * @return isMatch True if the account is considered a match engine.
     */
    function isMatchEngineForView(address account) external view returns (bool isMatch) {
        if (_registryAddr == address(0)) return false;
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL) returns (address acmAddr) {
            return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_ORDER_CREATE, account);
        } catch {
            return false;
        }
    }
    
    /**
     * @notice View-adapter: return the Registry address used by this ORDER_ENGINE.
     * @dev Convenience for off-chain tooling and view modules.
     *
     * @return registry Registry address.
     */
    function getRegistryForView() external view returns (address registry) {
        return _registryAddr;
    }
    
    /*━━━━━━━━━━━━━━━ INTERNALS ━━━━━━━━━━━━━━━*/

    /*━━━━━━━━━━━━━━━ Graceful Degradation ━━━━━━━━━━━━━━━*/
    
    /// @notice Mint LoanNFT with retry + graceful degradation (internal helper).
    /// @param orderId Loan order id.
    /// @param borrower Borrower address.
    /// @param meta LoanNFT metadata.
    /// @return tokenId Minted token id.
    function _mintNftWithRetry(uint256 orderId, address borrower, ILoanNFT.LoanMetadata memory meta)
        internal
        returns (uint256 tokenId)
    {
        uint256 retryCount = _nftRetryCount[orderId];
        
        // Gas: unchecked loop increment.
        unchecked {
            for (uint256 i = 0; i <= _MAX_RETRY_COUNT; i++) {
                try _loanNft.mintLoanCertificate(borrower, meta) returns (uint256 _tokenId) {
                    tokenId = _tokenId;
                    
                    // Clear retry counter on success.
                    if (_nftRetryCount[orderId] > 0) {
                        delete _nftRetryCount[orderId];
                        emit NftOperationRetried(orderId, "mint", i, true);
                    }
                    
                    return tokenId;
                } catch (bytes memory reason) {
                    retryCount = i + 1;
                    _nftRetryCount[orderId] = retryCount;
                    
                    emit NftOperationRetried(orderId, "mint", retryCount, false);
                    
                    // On last retry: emit degradation events then revert with a typed error.
                    if (i == _MAX_RETRY_COUNT) {
                        string memory errorMsg = reason.length > 0 ? string(reason) : "NFT mint failed after retries";
                        DataPushLibrary._emitData(
                            DataPushTypes.DATA_TYPE_COMPONENT_HEALTH,
                            abi.encode(address(_loanNft), "LoanNFT", false, errorMsg, block.number)
                        );
                        // User-level degradation event: associated with the borrower.
                        address orderAsset = _loanOrders[orderId].asset;
                        DataPushLibrary._emitData(
                            DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                            abi.encode(borrower, address(this), orderAsset, errorMsg, true, uint256(0), block.number)
                        );
                        revert LendingEngine__NftMintFailed(orderId);
                    }
                }
            }
        }
    }
    
    /// @notice Distribute fees with graceful degradation (do not block repayment).
    /// @param orderId Loan order id.
    /// @param asset ERC20 asset address.
    /// @param feeAmount Fee amount (token decimals).
    function _distributeFeeWithFallback(uint256 orderId, address asset, uint256 feeAmount) internal {
        try _feeRouter.distributeNormal(asset, feeAmount) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory reason) {
            // Gas: unchecked add.
            unchecked {
                // Track failed fee amount for ops follow-up.
                _failedFeeAmount[orderId] += feeAmount;
            }
            
            string memory errorMsg = reason.length > 0 ? string(reason) : "Fee distribution failed";
            emit FeeDistributionFailed(orderId, feeAmount, errorMsg);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_COMPONENT_HEALTH,
                abi.encode(address(_feeRouter), "FeeRouter", false, errorMsg, block.number)
            );
            // User-level degradation event: associated with the borrower.
            address borrower = _loanOrders[orderId].borrower;
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                abi.encode(borrower, address(this), asset, errorMsg, true, uint256(feeAmount), block.number)
            );
            
            // NOTE: intentionally does not revert.
        }
    }

    /// @notice Require a role via ACM.
    /// @param actionKey Action key.
    /// @param user User address.
    function _requireRole(bytes32 actionKey, address user) internal view {
        if (_registryAddr == address(0)) revert LendingEngine__ZeroAddress();
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @dev Best-effort refresh cached module addresses from Registry.
    function _updateModuleAddresses() internal {
        if (_registryAddr == address(0)) revert LendingEngine__RegistryNotSet();

        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LOAN_NFT) returns (address loanNFTAddr) {
            if (loanNFTAddr != address(0) && loanNFTAddr != address(_loanNft)) {
                _loanNft = ILoanNFT(loanNFTAddr);
            }
        } catch {
            // Keep current address on failure.
            uint256 noop = 0;
            noop;
        }
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FR) returns (address feeRouterAddr) {
            if (feeRouterAddr != address(0) && feeRouterAddr != address(_feeRouter)) {
                _feeRouter = IFeeRouter(feeRouterAddr);
            }
        } catch {
            // Keep current address on failure.
            uint256 noop = 0;
            noop;
        }
    }

    /// @dev Return true if duration is in the allowed whitelist (blocks).
    function _isAllowedDuration(uint256 durationBlocks) internal pure returns (bool) {
        return (
            durationBlocks == _DUR_5D_BLOCKS   || durationBlocks == _DUR_10D_BLOCKS || durationBlocks == _DUR_15D_BLOCKS ||
            durationBlocks == _DUR_30D_BLOCKS  || durationBlocks == _DUR_60D_BLOCKS || durationBlocks == _DUR_90D_BLOCKS ||
            durationBlocks == _DUR_180D_BLOCKS || durationBlocks == _DUR_360D_BLOCKS
        );
    }

    /// @dev Return true if duration is a long duration (>= 90d baseline; blocks-based).
    function _isLongDuration(uint256 durationBlocks) internal pure returns (bool) {
        return (durationBlocks == _DUR_90D_BLOCKS || durationBlocks == _DUR_180D_BLOCKS || durationBlocks == _DUR_360D_BLOCKS);
    }

    /// @dev Calculate total due = principal + interest (simple pro-rata interest).
    /// @param ord Loan order data.
    /// @return totalDue Total due amount (token decimals of ord.asset).
    function _calculateTotalDue(LoanOrder memory ord) internal pure returns (uint256) {
        // Gas: unchecked arithmetic.
        unchecked {
            // SSOT (time refactor): term is blocks. Use a blocks-per-year baseline.
            // interest = principal * rate(bps) * termBlocks / (_YEAR_BLOCKS * 1e4)
            uint256 interest = (ord.principal * ord.rate * ord.term) / (_YEAR_BLOCKS * 1e4);
            return ord.principal + interest;
        }
    }

    /// @notice UUPS upgrade authorization.
    /// @dev Reverts if:
    ///      - caller lacks ACTION_UPGRADE_MODULE
    ///      - newImplementation is zero address (LendingEngine__ZeroAddress)
    ///      - newImplementation has no code (LendingEngine__InvalidImplementation)
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert LendingEngine__ZeroAddress();
        if (newImplementation.code.length == 0) revert LendingEngine__InvalidImplementation();
        
        // Record for auditability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ GAP ━━━━━━━━━━━━━━━*/

    uint256[44] private __gap;
} 

/// @dev Minimal read-only interface for RewardView (borrow-level gate).
interface IRewardViewBorrowCheck {
    function getUserLevelForBorrowCheck(address user) external view returns (uint8);
}