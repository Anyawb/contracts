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
import { IRewardManager, IRewardManagerV2 } from "../interfaces/IRewardManager.sol";
// NOTE:
// - This contract is the ORDER_ENGINE in the Architecture-Guide.
// - The debt ledger engine is KEY_LE (VaultLendingEngine).

/// @dev Minimal typed VaultCore interface for debt-ledger sync.
interface IVaultCoreRepayFor {
    function repayFor(address borrower, address asset, uint256 amount) external;
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
        uint256 term;       // seconds
        address borrower;
        address lender;
        address asset;      // ERC20 address
        uint256 startTimestamp;
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
    
    /* solhint-disable private-vars-leading-underscore */
    /// @notice Repayment fee in bps (e.g. 6 = 0.06%).
    uint256 private constant REPAY_FEE_BPS = 6;
    /// @notice On-time window (default 24 hours).
    uint256 private constant ON_TIME_WINDOW = 24 hours;

    /// @notice Allowed term durations (seconds).
    uint256 private constant DUR_5D   = 5 days;
    uint256 private constant DUR_10D  = 10 days;
    uint256 private constant DUR_15D  = 15 days;
    uint256 private constant DUR_30D  = 30 days;
    uint256 private constant DUR_60D  = 60 days;
    uint256 private constant DUR_90D  = 90 days;
    uint256 private constant DUR_180D = 180 days;
    uint256 private constant DUR_360D = 360 days;

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
    uint256 private constant MAX_RETRY_COUNT = 3;
    /* solhint-enable private-vars-leading-underscore */

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

        __UUPSUpgradeable_init();
        __Pausable_init();

        _registryAddr = initialRegistryAddr;
        
        // Record for auditability (unified system event).
        // solhint-disable-next-line not-rely-on-time
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
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
        // solhint-disable-next-line not-rely-on-time
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
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
        // solhint-disable-next-line not-rely-on-time
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
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
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // Record for auditability.
        // solhint-disable-next-line not-rely-on-time
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
        
        // Emit module address update (compat/event stream).
        // solhint-disable-next-line not-rely-on-time
        emit SystemEvents.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_LE),
            oldRegistry,
            newRegistryAddr,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
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
        // solhint-disable-next-line not-rely-on-time
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
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
     *  - term: seconds
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
        // Long duration (>= 90 days) requires user level >= 4 (RewardView gate).
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
        // solhint-disable-next-line not-rely-on-time
        // solhint-disable-next-line not-rely-on-time
        uint256 startTs = block.timestamp;
        uint256 maturity;
        
        // Gas: unchecked arithmetic (startTs + term).
        unchecked {
            maturity = startTs + order.term;
        }

        // Persist order.
        _loanOrders[orderId] = LoanOrder({
            principal: order.principal,
            rate: order.rate,
            term: order.term,
            borrower: order.borrower,
            lender: order.lender,
            asset: order.asset,
            startTimestamp: startTs,
            maturity: maturity,
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
        // solhint-disable-next-line not-rely-on-time
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
                // solhint-disable-next-line not-rely-on-time
                block.timestamp
            )
        );

        // Notify RewardManager after order creation.
        // - Prefer V2 (orderId/maturity/outcome); fallback to V1 if unsupported.
        address rewardManagerBorrow = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        // solhint-disable-next-line not-rely-on-time
        /* solhint-disable no-empty-blocks */
        try IRewardManagerV2(rewardManagerBorrow).onLoanEventV2(
            order.borrower,
            orderId,
            order.principal,
            maturity,
            IRewardManagerV2.LoanEventOutcome.Borrow
        ) {
        } catch {
            try IRewardManager(rewardManagerBorrow).onLoanEvent(order.borrower, order.principal, order.term, true) {
            } catch {
            }
        }
        /* solhint-enable no-empty-blocks */

        // Record for auditability.
        // solhint-disable-next-line not-rely-on-time
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
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
            feeAmount = (_repayAmount * REPAY_FEE_BPS) / 1e4;
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
        // solhint-disable-next-line not-rely-on-time
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
                // solhint-disable-next-line not-rely-on-time
                block.timestamp
            )
        );
        
        // Determine repayment outcome.
        bool isFullyRepaid = ord.repaidAmount >= totalDue;
        // solhint-disable-next-line not-rely-on-time
        uint256 nowTs = block.timestamp;
        bool isOnTime = (nowTs + ON_TIME_WINDOW >= ord.maturity) && (nowTs <= ord.maturity + ON_TIME_WINDOW);
        bool isOnTimeAndFullyRepaid = isFullyRepaid && isOnTime;
        
        // Record for auditability.
        // solhint-disable-next-line not-rely-on-time
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_REPAY,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );

        // If fully repaid, update LoanNFT status.
        if (isFullyRepaid) {
            uint256 tokenId = _orderToTokenId[orderId];
            _loanNft.updateLoanStatus(tokenId, ILoanNFT.LoanStatus.Repaid);
        }

        // Notify RewardManager on full repay only (avoid partial repay side-effects).
        if (isFullyRepaid) {
            address rewardManagerRepay = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);

            // V2 outcome (order-based).
            IRewardManagerV2.LoanEventOutcome outcome;
            if (isOnTimeAndFullyRepaid) {
                outcome = IRewardManagerV2.LoanEventOutcome.RepayOnTimeFull;
            } else {
                // Early: now + window < maturity
                // solhint-disable-next-line not-rely-on-time
                // solhint-disable-next-line not-rely-on-time
                bool isEarly = (block.timestamp + ON_TIME_WINDOW < ord.maturity);
                outcome = isEarly
                    ? IRewardManagerV2.LoanEventOutcome.RepayEarlyFull
                    : IRewardManagerV2.LoanEventOutcome.RepayLateFull;
            }

            // Prefer V2, fallback to V1.
            /* solhint-disable no-empty-blocks */
            try IRewardManagerV2(rewardManagerRepay).onLoanEventV2(
                ord.borrower, orderId, _repayAmount, ord.maturity, outcome
            ) {
            } catch {
                try IRewardManager(rewardManagerRepay).onLoanEvent(
                    ord.borrower, _repayAmount, 0, isOnTimeAndFullyRepaid
                ) {
                } catch {
                }
            }
            /* solhint-enable no-empty-blocks */
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
    // solhint-disable-next-line private-vars-leading-underscore
    function _getLoanOrderForView(uint256 orderId) external view onlyValidRegistry returns (LoanOrder memory order) {
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
    // solhint-disable-next-line private-vars-leading-underscore
    function _getUserLoanCountForView(address user) external view onlyValidRegistry returns (uint256 count) {
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
    // solhint-disable-next-line private-vars-leading-underscore
    function _getFailedFeeAmountForView(uint256 orderId) external view onlyValidRegistry returns (uint256 feeAmount) {
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
    // solhint-disable-next-line private-vars-leading-underscore
    function _getNftRetryCountForView(uint256 orderId) external view onlyValidRegistry returns (uint256 retryCount) {
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
    // solhint-disable-next-line private-vars-leading-underscore
    function _canAccessLoanOrderForView(uint256 orderId, address user) external view returns (bool hasAccess) {
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
    // solhint-disable-next-line private-vars-leading-underscore
    function _isMatchEngineForView(address account) external view returns (bool isMatch) {
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
    // solhint-disable-next-line private-vars-leading-underscore
    function _getRegistryForView() external view returns (address registry) {
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
            for (uint256 i = 0; i <= MAX_RETRY_COUNT; i++) {
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
                    if (i == MAX_RETRY_COUNT) {
                        string memory errorMsg = reason.length > 0 ? string(reason) : "NFT mint failed after retries";
                        DataPushLibrary._emitData(
                            DataPushTypes.DATA_TYPE_MODULE_HEALTH,
                            // solhint-disable-next-line not-rely-on-time
                            abi.encode(address(_loanNft), "LoanNFT", false, errorMsg, block.timestamp)
                        );
                        // User-level degradation event: associated with the borrower.
                        address orderAsset = _loanOrders[orderId].asset;
                        DataPushLibrary._emitData(
                            DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                            // solhint-disable-next-line not-rely-on-time
                            abi.encode(borrower, address(this), orderAsset, errorMsg, true, uint256(0), block.timestamp)
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
        /* solhint-disable no-empty-blocks */
        try _feeRouter.distributeNormal(asset, feeAmount) {
            // ok
        } catch (bytes memory reason) {
            // Gas: unchecked add.
            unchecked {
                // Track failed fee amount for ops follow-up.
                _failedFeeAmount[orderId] += feeAmount;
            }
            
            string memory errorMsg = reason.length > 0 ? string(reason) : "Fee distribution failed";
            emit FeeDistributionFailed(orderId, feeAmount, errorMsg);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_MODULE_HEALTH,
                // solhint-disable-next-line not-rely-on-time
                abi.encode(address(_feeRouter), "FeeRouter", false, errorMsg, block.timestamp)
            );
            // User-level degradation event: associated with the borrower.
            address borrower = _loanOrders[orderId].borrower;
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                // solhint-disable-next-line not-rely-on-time
                abi.encode(borrower, address(this), asset, errorMsg, true, uint256(feeAmount), block.timestamp)
            );
            
            // NOTE: intentionally does not revert.
        }
        /* solhint-enable no-empty-blocks */
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

        /* solhint-disable no-empty-blocks */
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LOAN_NFT) returns (address loanNFTAddr) {
            if (loanNFTAddr != address(0) && loanNFTAddr != address(_loanNft)) {
                _loanNft = ILoanNFT(loanNFTAddr);
            }
        } catch {
            // Keep current address on failure.
        }
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FR) returns (address feeRouterAddr) {
            if (feeRouterAddr != address(0) && feeRouterAddr != address(_feeRouter)) {
                _feeRouter = IFeeRouter(feeRouterAddr);
            }
        } catch {
            // Keep current address on failure.
        }
        /* solhint-enable no-empty-blocks */
    }

    /// @dev Return true if duration is in the allowed whitelist (seconds).
    function _isAllowedDuration(uint256 durationSec) internal pure returns (bool) {
        return (
            durationSec == DUR_5D   || durationSec == DUR_10D || durationSec == DUR_15D ||
            durationSec == DUR_30D  || durationSec == DUR_60D || durationSec == DUR_90D ||
            durationSec == DUR_180D || durationSec == DUR_360D
        );
    }

    /// @dev Return true if duration is a long duration (>= 90 days).
    function _isLongDuration(uint256 durationSec) internal pure returns (bool) {
        return (durationSec == DUR_90D || durationSec == DUR_180D || durationSec == DUR_360D);
    }

    /// @dev Calculate total due = principal + interest (simple pro-rata interest).
    /// @param ord Loan order data.
    /// @return totalDue Total due amount (token decimals of ord.asset).
    function _calculateTotalDue(LoanOrder memory ord) internal pure returns (uint256) {
        // Gas: unchecked arithmetic.
        unchecked {
            // interest = principal * rate(bps) * term / (365 days * 1e4)
            uint256 interest = (ord.principal * ord.rate * ord.term) / (365 days * 1e4);
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
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
    }

    /*━━━━━━━━━━━━━━━ GAP ━━━━━━━━━━━━━━━*/

    uint256[44] private __gap;
} 

/// @dev Minimal read-only interface for RewardView (borrow-level gate).
interface IRewardViewBorrowCheck {
    function getUserLevelForBorrowCheck(address user) external view returns (uint8);
}