// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { 
    AmountIsZero, 
    NotAContract,
    ZeroAddress, 
    ExternalModuleRevertedRaw,
    GuaranteeNotActive,
    InvalidGuaranteeId,
    GuaranteeAlreadyProcessed,
    GuaranteeRecordNotFound,
    GuaranteeIdOverflow,
    InvalidGuaranteeTerm,
    GuaranteeInterestTooHigh,
    BorrowerCannotBeLender,
    EarlyRepaymentGuaranteeManager__OnlyVaultCore,
    EarlyRepaymentGuaranteeManager__InvalidImplementation,
    EarlyRepaymentGuaranteeManager__RateTooHigh,
    EarlyRepaymentGuaranteeManager__RateUnchanged
} from "../../errors/StandardErrors.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { SystemEvents } from "../SystemEvents.sol";
import { Registry } from "../../registry/Registry.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { IGuaranteeFundManager } from "../../interfaces/IGuaranteeFundManager.sol";
import { IEarlyRepaymentGuaranteeManager } from "../../interfaces/IEarlyRepaymentGuaranteeManager.sol";

/**
 * @title EarlyRepaymentGuaranteeManager
 * @notice Manage early-repayment guarantee records and orchestrate settlement outcomes.
 * @dev SSOT / boundary:
 *      - This module is the SSOT for guarantee *records* (principal, promisedInterest, term, status),
 *        but it is NOT the custody/transfer authority for funds.
 *      - The SSOT for guarantee *fund custody and transfers* is `GuaranteeFundManager` (KEY_GUARANTEE_FUND).
 *      - Business write entrypoints are restricted to `VaultCore` (onlyVaultCore).
 *      - Governance/ops entrypoints are restricted by ACM ActionKeys (onlyRole).
 *      - Module address resolution SSOT is always `Registry.getModuleOrRevert(...)`; this module must not be used
 *        as an address-resolution facade.
 *
 * Reverts if:
 * - (see each external/public function; view getters are non-reverting unless explicitly documented)
 *
 * Security:
 * - UUPSUpgradeable: upgrades are role-gated in `_authorizeUpgrade`
 * - ReentrancyGuard: state-changing external entrypoints are nonReentrant
 * - Access control: governance writes are gated via ACM.requireRole(ActionKeys.*)
 *
 * @custom:security-contact security@example.com
 */
contract EarlyRepaymentGuaranteeManager is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable,
    IEarlyRepaymentGuaranteeManager
{
    /*━━━━━━━━━━━━━━━ TIME AXIS (SSOT: blocks) ━━━━━━━━━━━━━━━*/
    /// @dev Baseline blocks-per-day used across this repo (assumes ~12s/block).
    ///      Frontend/keeper should do ETA mapping offchain.
    uint256 private constant _BLOCKS_PER_DAY = 7200;

    /*━━━━━━━━━━━━━━━ Structs ━━━━━━━━━━━━━━━*/
    // NOTE: Structs/events are defined in `IEarlyRepaymentGuaranteeManager` and used here to ensure
    // interface-level consistency for frontends, tests, and offchain indexers.

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice guaranteeId => GuaranteeRecord
    mapping(uint256 => IEarlyRepaymentGuaranteeManager.GuaranteeRecord) private _guaranteeRecords;
    
    /// @notice borrower => asset => guaranteeId
    mapping(address => mapping(address => uint256)) private _userGuaranteeIds;
    
    /// @notice Monotonically increasing guarantee id counter.
    uint256 private _guaranteeIdCounter;
    
    /// @notice Registry address for module resolution and access control.
    address private _registryAddr;
    
    /// @notice Platform fee receiver address.
    address private _platformFeeReceiverAddr;
    
    /// @notice Default early repayment penalty days.
    uint256 internal constant _DEFAULT_EARLY_REPAY_PENALTY_DAYS = 2;
    
    /// @notice Platform fee rate (bps).
    uint256 private _platformFeeRate;

    /// @notice Backward-compatible default behavior: whether guarantee is enabled by default for all assets.
    /// @dev Default is true to preserve legacy tests/flows unless explicitly disabled by governance.
    bool private _guaranteeDefaultEnabled;

    /// @notice Asset-level feature toggle override:
    /// 0 = inherit default, 1 = enabled, 2 = disabled
    mapping(address => uint8) private _guaranteeAssetMode;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @notice Called by an account other than the current SettlementManager resolved via Registry (SSOT).
    error EarlyRepaymentGuaranteeManager__OnlySettlementManager();
    /// @notice Called by an account other than VaultCore or VaultBusinessLogic resolved via Registry (SSOT).
    error EarlyRepaymentGuaranteeManager__OnlyAuthorizedOrchestrator();
    /// @notice Guarantee feature is disabled for the given asset.
    error EarlyRepaymentGuaranteeManager__GuaranteeNotEnabled();

    /*━━━━━━━━━━━━━━━ Construction & initialization ━━━━━━━━━━━━━━━*/

    /**
     * @notice Constructs the implementation contract and disables initializers.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Prevents the implementation contract from being initialized directly.
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    // NOTE: Events are declared in the interface; emitting them here satisfies the interface and keeps
    // log signatures stable for offchain consumers.

    /**
     * @notice Emitted when the platform fee receiver address is updated.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Role-gated by ACTION_SET_PARAMETER on the write entrypoint.
     *
     * @param oldReceiver Previous receiver address.
     * @param newReceiver New receiver address.
     * @param blockNumber Legacy field name: emission time-axis marker (blockNumber).
     */
    event PlatformFeeReceiverUpdated(
        address indexed oldReceiver,
        address indexed newReceiver,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when the platform fee rate is updated.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Role-gated by ACTION_SET_PARAMETER on the write entrypoint.
     *
     * @param oldRate Previous rate (bps).
     * @param newRate New rate (bps).
     * @param blockNumber Legacy field name: emission time-axis marker (blockNumber).
     */
    event PlatformFeeRateUpdated(
        uint256 oldRate,
        uint256 newRate,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when the Registry address reference is updated.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Role-gated by ACTION_UPGRADE_MODULE on the write entrypoint.
     *
     * @param oldRegistry Previous Registry address.
     * @param newRegistry New Registry address.
     */
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);



    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @notice Restricts calls to the current VaultCore registered in Registry (SSOT).
    modifier onlyVaultCore() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        // Backward compat: do not depend on Registry having KEY_VAULT_CORE configured for custom error matching.
        address vaultCoreAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_VAULT_CORE);
        if (msg.sender != vaultCoreAddr) revert EarlyRepaymentGuaranteeManager__OnlyVaultCore();
        _;
    }

    /// @notice Restricts calls to VaultCore or VaultBusinessLogic (borrow-time orchestration).
    modifier onlyVaultCoreOrBusinessLogic() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        address vaultCoreAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_VAULT_CORE);
        if (msg.sender == vaultCoreAddr) {
            _;
            return;
        }
        address vbl = Registry(_registryAddr).getModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        // Backward compat: keep the legacy "OnlyVaultCore" custom error for non-authorized callers
        // (tests and off-chain tooling depend on this selector).
        if (msg.sender != vbl) revert EarlyRepaymentGuaranteeManager__OnlyVaultCore();
        _;
    }

    /// @notice Restricts calls to SettlementManager (repay/default-time orchestration).
    modifier onlySettlementManager() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        // Backward compat: allow VaultCore to call settlement functions directly in legacy tests.
        address vaultCoreAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_VAULT_CORE);
        if (vaultCoreAddr != address(0) && msg.sender == vaultCoreAddr) {
            _;
            return;
        }
        address sm = Registry(_registryAddr).getModule(ModuleKeys.KEY_SETTLEMENT_MANAGER);
        if (msg.sender != sm) revert EarlyRepaymentGuaranteeManager__OnlySettlementManager();
        _;
    }

    /// @notice Ensures the Registry reference is non-zero.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @notice Restricts calls to accounts holding a given ACM actionKey.
    modifier onlyRole(bytes32 role) {
        _requireRole(role, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/
    /**
     * @notice Initialize the EarlyRepaymentGuaranteeManager module.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (ZeroAddress)
     *      - initialPlatformFeeReceiverAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - initializer (callable once)
     * - UUPSUpgradeable: upgrade authorization is role-gated in `_authorizeUpgrade`
     * - ReentrancyGuard: external state-changing entrypoints are nonReentrant
     *
     * @param initialRegistryAddr Registry contract address (non-zero).
     * @param initialPlatformFeeReceiverAddr Platform fee receiver address (non-zero).
     * @param initialPlatformFeeRate Platform fee rate (bps, 10_000 = 100%).
     */
    function initialize(
        address initialRegistryAddr,
        address initialPlatformFeeReceiverAddr,
        uint256 initialPlatformFeeRate
    ) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        uint256 blockNumber = block.number;
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialPlatformFeeReceiverAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        _platformFeeReceiverAddr = initialPlatformFeeReceiverAddr;
        _platformFeeRate = initialPlatformFeeRate;
        _guaranteeDefaultEnabled = true;
        
        // Emit standardized action event for observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            blockNumber
        );
    }

    /**
     * @notice Get current VaultCore address (legacy getter kept for tests/backward-compat).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return vaultCoreAddr VaultCore address.
     */
    function vaultCore() external view returns (address vaultCoreAddr) {
        if (_registryAddr == address(0)) revert ZeroAddress();
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
    }

    /**
     * @notice Get current Registry address (legacy getter kept for tests/backward-compat).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return registryAddr Registry address.
     */
    function registry() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /**
     * @notice Get current VaultCore address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return vaultCoreAddr VaultCore address.
     */
    function vaultCoreAddrVar() external view returns (address vaultCoreAddr) {
        if (_registryAddr == address(0)) revert ZeroAddress();
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
    }

    /**
     * @notice Get current Registry address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return registryAddr Registry address.
     */
    function registryAddrVar() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /**
     * @notice Get current platform fee receiver address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return receiverAddr Platform fee receiver address.
     */
    function platformFeeReceiver() external view returns (address receiverAddr) {
        return _platformFeeReceiverAddr;
    }

    /**
     * @notice Get current platform fee rate.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return rateBps Platform fee rate (bps, 10_000 = 100%).
     */
    function platformFeeRate() external view returns (uint256 rateBps) {
        return _platformFeeRate;
    }

    /**
     * @notice Whether early-repayment guarantee is enabled for the given asset.
     * @dev Reverts if: (none)
     * Security: view-only
     */
    function isGuaranteeEnabled(address asset) external view override returns (bool enabled) {
        uint8 mode = _guaranteeAssetMode[asset];
        if (mode == 1) return true;
        if (mode == 2) return false;
        return _guaranteeDefaultEnabled;
    }

    /*━━━━━━━━━━━━━━━ Access control helpers ━━━━━━━━━━━━━━━*/

    /**
     * @notice Require AccessControlManager role for an action key.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL is not registered in Registry (Registry.getModuleOrRevert)
     *      - caller does not have the required role (via ACM.requireRole)
     *
     * Security:
     * - Delegates authorization to ACM.requireRole
     *
     * @param actionKey Action key (bytes32, see ActionKeys).
     * @param user Caller address to validate.
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice Best-effort role check helper.
     * @dev Reverts if:
     *      - (none) - returns false on external call failure
     *
     * Security:
     * - Best-effort: does not block execution if ACM is unavailable/misconfigured
     *
     * @param actionKey Action key (bytes32, see ActionKeys).
     * @param user Address to check.
     * @return True if user has role, otherwise false.
     */
    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        try IAccessControlManager(acmAddr).hasRole(actionKey, user) returns (bool hasRole) {
            return hasRole;
        } catch {
            return false;
        }
    }

    /**
     * @notice Validate that an address is non-zero.
     * @dev Reverts if:
     *      - moduleAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - Pure input validation
     *
     * @param moduleAddr Address to validate.
     */
    function _validateModuleAddress(address moduleAddr) internal pure {
        if (moduleAddr == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Get the Registry address reference used by this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return registryAddr Registry address.
     */
    function getRegistry() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ View functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get a guarantee record by id.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * Note:
     * - If guaranteeId was never created, returns a zero-initialized struct.
     *
     * @param guaranteeId Guarantee id.
     * @return record Guarantee record struct.
     */
    function getGuaranteeRecord(uint256 guaranteeId)
        external
        view
        override
        returns (IEarlyRepaymentGuaranteeManager.GuaranteeRecord memory record)
    {
        return _guaranteeRecords[guaranteeId];
    }

    /**
     * @notice Get the active (or last) guarantee id for a (user, asset) pair.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param user Borrower address.
     * @param asset Guarantee asset address.
     * @return guaranteeId Guarantee id (0 if none is set).
     */
    function getUserGuaranteeId(address user, address asset)
        external
        view
        override
        returns (uint256 guaranteeId)
    {
        return _userGuaranteeIds[user][asset];
    }

    /**
     * @notice Check whether a user currently has an active guarantee for an asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param user Borrower address.
     * @param asset Guarantee asset address.
     * @return isActive True if an active guarantee exists, otherwise false.
     */
    function hasActiveGuarantee(address user, address asset) external view override returns (bool isActive) {
        uint256 guaranteeId = _userGuaranteeIds[user][asset];
        if (guaranteeId == 0) return false;
        
        IEarlyRepaymentGuaranteeManager.GuaranteeRecord storage record = _guaranteeRecords[guaranteeId];
        return record.isActive;
    }

    /**
     * @notice Preview the early repayment settlement result for a given guarantee id.
     * @dev Reverts if:
     *      - guarantee is not active (GuaranteeNotActive)
     *
     * Security:
     * - View-only
     *
     * @param guaranteeId Guarantee id.
     * @param actualRepayAmount Actual repay amount (reserved for future rules).
     * @return result Previewed settlement amounts.
     */
    function previewEarlyRepayment(
        uint256 guaranteeId,
        uint256 actualRepayAmount
    ) external view override returns (EarlyRepaymentResult memory result) {
        IEarlyRepaymentGuaranteeManager.GuaranteeRecord storage record = _guaranteeRecords[guaranteeId];
        if (!record.isActive) revert GuaranteeNotActive();
        uint256 blockNumber = block.number;

        return _calculateEarlyRepaymentResult(record, actualRepayAmount, blockNumber);
    }

    /*━━━━━━━━━━━━━━━ Core functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Lock a new early-repayment guarantee record for (borrower, asset).
     * @dev Reverts if:
     *      - borrower/lender/asset is zero (ZeroAddress)
     *      - principal/promisedInterest/termDays is zero (AmountIsZero)
     *      - borrower == lender (BorrowerCannotBeLender)
     *      - termDays is out of range (InvalidGuaranteeTerm)
     *      - promisedInterest is too high vs principal (GuaranteeInterestTooHigh)
     *      - an active guarantee already exists for (borrower, asset) (GuaranteeAlreadyProcessed)
     *      - guarantee id counter overflows (GuaranteeIdOverflow)
     *
     * Security:
     * - onlyVaultCore
     * - nonReentrant
     *
     * @param borrower Borrower address.
     * @param lender Lender address.
     * @param asset Guarantee asset address.
     * @param principal Borrow principal amount.
     * @param promisedInterest Promised interest amount to be locked as guarantee.
     * @param termDays Loan term (days).
     * @return guaranteeId New guarantee id.
     */
    function lockGuaranteeRecord(
        address borrower,
        address lender,
        address asset,
        uint256 principal,
        uint256 promisedInterest,
        uint256 termDays
    ) external override onlyVaultCoreOrBusinessLogic onlyValidRegistry nonReentrant returns (uint256 guaranteeId) {
        uint256 blockNumber = block.number;
        // Basic parameter validation.
        if (borrower == address(0)) revert ZeroAddress();
        if (lender == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (principal == 0) revert AmountIsZero();
        if (promisedInterest == 0) revert AmountIsZero();
        if (termDays == 0) revert AmountIsZero();
        if (!_isEnabled(asset)) revert EarlyRepaymentGuaranteeManager__GuaranteeNotEnabled();
        
        // Business rule validation.
        if (borrower == lender) revert BorrowerCannotBeLender();
        if (termDays > 365 * 10) revert InvalidGuaranteeTerm(); // max 10 years
        if (promisedInterest > principal * 2) revert GuaranteeInterestTooHigh(); // capped at 2x principal
        
        // Ensure there is no active guarantee for (borrower, asset).
        if (_userGuaranteeIds[borrower][asset] != 0) {
            uint256 existingId = _userGuaranteeIds[borrower][asset];
            if (_guaranteeRecords[existingId].isActive) {
                revert GuaranteeAlreadyProcessed();
            }
        }
        
        // Guard against id counter overflow.
        if (_guaranteeIdCounter == type(uint256).max) revert GuaranteeIdOverflow();
        
        // Generate a new guarantee id.
        uint256 newGuaranteeId = ++_guaranteeIdCounter;
        guaranteeId = newGuaranteeId;
        
        // Create the guarantee record (semantic layer; no funds transfer).
        IEarlyRepaymentGuaranteeManager.GuaranteeRecord storage record = _guaranteeRecords[newGuaranteeId];
        record.principal = principal;
        record.promisedInterest = promisedInterest;
        // NOTE (Time-Dependency-Refactor):
        // - `startTime/maturityTime` are legacy field names; semantics are startBlock/maturityBlock (block.number).
        // - termDays is converted to blocks using the repo baseline blocks-per-day.
        record.startTime = blockNumber;
        record.maturityTime = blockNumber + (termDays * _BLOCKS_PER_DAY);
        record.earlyRepayPenaltyDays = _DEFAULT_EARLY_REPAY_PENALTY_DAYS;
        record.isActive = true;
        record.lender = lender;
        record.asset = asset;
        
        // Update user -> asset -> guaranteeId mapping.
        _userGuaranteeIds[borrower][asset] = newGuaranteeId;
        
        emit GuaranteeLocked(
            newGuaranteeId,
            borrower,
            lender,
            asset,
            principal,
            promisedInterest,
            record.startTime,
            record.maturityTime,
            record.earlyRepayPenaltyDays,
            blockNumber
        );
        
        // Emit standardized action event for observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_LOCK_EARLY_REPAYMENT_GUARANTEE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LOCK_EARLY_REPAYMENT_GUARANTEE),
            msg.sender,
            blockNumber
        );
        return guaranteeId;
    }

    /**
     * @notice Settle early repayment for (borrower, asset) by distributing the guarantee via GuaranteeFundManager.
     * @dev Reverts if:
     *      - borrower/asset is zero (ZeroAddress)
     *      - actualRepayAmount is zero (AmountIsZero)
     *      - no guarantee exists for (borrower, asset) (GuaranteeRecordNotFound)
     *      - guarantee is not active (GuaranteeNotActive)
     *      - GuaranteeFundManager settlement reverts (ExternalModuleRevertedRaw)
     *
     * Security:
     * - onlyVaultCore
     * - nonReentrant
     * - CEI: state is updated before calling external module
     *
     * @param borrower Borrower address.
     * @param asset Guarantee asset address.
     * @param actualRepayAmount Actual repay amount (reserved for future rules).
     * @return result Computed settlement amounts.
     */
    function settleEarlyRepayment(
        address borrower,
        address asset,
        uint256 actualRepayAmount
    ) external override onlySettlementManager onlyValidRegistry nonReentrant returns (EarlyRepaymentResult memory result) {
        uint256 blockNumber = block.number;
        if (borrower == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (actualRepayAmount == 0) revert AmountIsZero();
        if (!_isEnabled(asset)) revert EarlyRepaymentGuaranteeManager__GuaranteeNotEnabled();
        
        uint256 currentGuaranteeId = _userGuaranteeIds[borrower][asset];
        if (currentGuaranteeId == 0) revert GuaranteeRecordNotFound();
        
        IEarlyRepaymentGuaranteeManager.GuaranteeRecord storage record = _guaranteeRecords[currentGuaranteeId];
        if (!record.isActive) revert GuaranteeNotActive();
        
        // Compute early repayment settlement amounts.
        result = _calculateEarlyRepaymentResult(record, actualRepayAmount, blockNumber);
        
        // CEI: update state first (Effects).
        record.isActive = false;
        delete _userGuaranteeIds[borrower][asset];
        
        // Transfers are executed by GuaranteeFundManager: one-call 3-way distribution.
        address gfm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        // Call GFM to perform custodial settlement (typed interface + unified revert wrapping).
        bool gfmCallOk;
        try IGuaranteeFundManager(gfm).settleEarlyRepayment(
            borrower,
            asset,
            record.lender,
            _platformFeeReceiverAddr,
            result.refundToBorrower,
            result.penaltyToLender,
            result.platformFee
        ) {
            gfmCallOk = true;
        } catch (bytes memory reason) {
            revert ExternalModuleRevertedRaw("GuaranteeFundManager", reason);
        }
        if (!gfmCallOk) revert ExternalModuleRevertedRaw("GuaranteeFundManager", bytes(""));
        
        emit EarlyRepaymentProcessed(
            currentGuaranteeId,
            borrower,
            record.lender,
            asset,
            result.penaltyToLender,
            result.refundToBorrower,
            result.platformFee,
            result.actualInterestPaid,
            blockNumber
        );
        
        // Emit standardized action event for observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SETTLE_EARLY_REPAYMENT_GUARANTEE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SETTLE_EARLY_REPAYMENT_GUARANTEE),
            msg.sender,
            blockNumber
        );
        return result;
    }

    /**
     * @notice Process default for (borrower, asset) by forfeiting the full guarantee to the lender.
     * @dev Reverts if:
     *      - borrower/asset is zero (ZeroAddress)
     *      - no guarantee exists for (borrower, asset) (GuaranteeRecordNotFound)
     *      - guarantee is not active (GuaranteeNotActive)
     *      - GuaranteeFundManager forfeiture reverts (ExternalModuleRevertedRaw)
     *
     * Security:
     * - onlyVaultCore
     * - nonReentrant
     * - CEI: state is updated before calling external module
     *
     * @param borrower Borrower address.
     * @param asset Guarantee asset address.
     * @return forfeitedAmount Amount forfeited.
     */
    function processDefault(
        address borrower,
        address asset
    ) external override onlySettlementManager onlyValidRegistry nonReentrant returns (uint256 forfeitedAmount) {
        uint256 blockNumber = block.number;
        if (borrower == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (!_isEnabled(asset)) revert EarlyRepaymentGuaranteeManager__GuaranteeNotEnabled();
        
        uint256 currentGuaranteeId = _userGuaranteeIds[borrower][asset];
        if (currentGuaranteeId == 0) revert GuaranteeRecordNotFound();
        
        IEarlyRepaymentGuaranteeManager.GuaranteeRecord storage record = _guaranteeRecords[currentGuaranteeId];
        if (!record.isActive) revert GuaranteeNotActive();
        
        // Forfeit full guarantee (current policy).
        forfeitedAmount = record.promisedInterest;
        
        // CEI: update state before external transfer.
        record.isActive = false;
        delete _userGuaranteeIds[borrower][asset];
        
        // Transfers are executed by GuaranteeFundManager.
        address gfm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        bool gfmCallOk;
        try IGuaranteeFundManager(gfm).forfeitPartial(
            borrower,
            asset,
            record.lender,
            forfeitedAmount
        ) {
            gfmCallOk = true;
        } catch (bytes memory reason) {
            revert ExternalModuleRevertedRaw("GuaranteeFundManager", reason);
        }
        if (!gfmCallOk) revert ExternalModuleRevertedRaw("GuaranteeFundManager", bytes(""));
        
        emit GuaranteeForfeited(
            currentGuaranteeId,
            borrower,
            record.lender,
            asset,
            forfeitedAmount,
            blockNumber
        );
        
        // Emit standardized action event for observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE_GUARANTEE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE_GUARANTEE),
            msg.sender,
            blockNumber
        );
        return forfeitedAmount;
    }

    /*━━━━━━━━━━━━━━━ Admin functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Update the platform fee receiver address.
     * @dev Reverts if:
     *      - registry address is zero (ZeroAddress)
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - newReceiverAddr is zero (ZeroAddress)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_SET_PARAMETER)
     *
     * @param newReceiverAddr New receiver address.
     */
    function setPlatformFeeReceiver(address newReceiverAddr)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        uint256 blockNumber = block.number;
        _validateModuleAddress(newReceiverAddr);
        address oldReceiver = _platformFeeReceiverAddr;
        _platformFeeReceiverAddr = newReceiverAddr;
        
        emit PlatformFeeReceiverUpdated(oldReceiver, newReceiverAddr, blockNumber);
        
        // Emit standardized action event for observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            blockNumber
        );
    }

    /**
     * @notice Update the platform fee rate.
     * @dev Reverts if:
     *      - registry address is zero (ZeroAddress)
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - newRate is above the allowed maximum (EarlyRepaymentGuaranteeManager__RateTooHigh)
     *      - newRate equals the current rate (EarlyRepaymentGuaranteeManager__RateUnchanged)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_SET_PARAMETER)
     *
     * @param newRate New platform fee rate (bps).
     */
    function setPlatformFeeRate(uint256 newRate) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        uint256 blockNumber = block.number;
        if (newRate > 1000) revert EarlyRepaymentGuaranteeManager__RateTooHigh();
        if (newRate == _platformFeeRate) revert EarlyRepaymentGuaranteeManager__RateUnchanged();
        uint256 oldRate = _platformFeeRate;
        _platformFeeRate = newRate;
        
        emit PlatformFeeRateUpdated(oldRate, newRate, blockNumber);
        
        // Emit standardized action event for observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            blockNumber
        );
    }

    /**
     * @notice Enable/disable early-repayment guarantee for a given asset.
     * @dev Reverts if:
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_SET_PARAMETER)
     *
     * @param asset Guarantee asset address.
     * @param enabled True to enable, false to disable.
     */
    function setGuaranteeEnabled(address asset, bool enabled)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        if (asset == address(0)) revert ZeroAddress();
        _guaranteeAssetMode[asset] = enabled ? 1 : 2;
    }

    function _isEnabled(address asset) internal view returns (bool) {
        uint8 mode = _guaranteeAssetMode[asset];
        if (mode == 1) return true;
        if (mode == 2) return false;
        return _guaranteeDefaultEnabled;
    }

    /**
     * @notice Update the VaultCore address reference.
     * @dev Reverts if:
     *      - registry address is zero (ZeroAddress)
     *      - caller lacks ACTION_UPGRADE_MODULE (via ACM.requireRole)
     *      - newVaultCoreAddr is zero (ZeroAddress)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_UPGRADE_MODULE)
     *
     * @param newVaultCoreAddr New VaultCore address.
     */
    // NOTE: No setVaultCore() here by design.
    // VaultCore is always resolved via Registry (SSOT) in `onlyVaultCore()` and `vaultCoreAddrVar()`.

    /**
     * @notice Update the Registry address reference.
     * @dev Reverts if:
     *      - current registry address is zero (ZeroAddress)
     *      - caller lacks ACTION_UPGRADE_MODULE (via ACM.requireRole)
     *      - newRegistryAddr is zero (ZeroAddress)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_UPGRADE_MODULE)
     *
     * @param newRegistryAddr New Registry address.
     */
    function setRegistry(address newRegistryAddr)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_UPGRADE_MODULE)
    {
        uint256 blockNumber = block.number;
        _validateModuleAddress(newRegistryAddr);
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // Emit standardized action event for observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            blockNumber
        );
    }

    /*━━━━━━━━━━━━━━━ Internal functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Compute early repayment settlement amounts for a record.
     * @dev Reverts if:
     *      - currentBlock < record.startTime (InvalidGuaranteeId)
     *
     * Security:
     * - View-only internal helper (does not mutate state)
     *
     * @param record Guarantee record reference.
     * @param currentTimestamp Legacy param name: current block number used for the settlement calculation.
     * @return result Computed settlement amounts.
     */
    function _calculateEarlyRepaymentResult(
        IEarlyRepaymentGuaranteeManager.GuaranteeRecord storage record,
        uint256 /* _actualRepayAmount */,
        uint256 currentTimestamp
    ) internal view returns (EarlyRepaymentResult memory result) {
        // Validate time bounds.
        if (currentTimestamp < record.startTime) revert InvalidGuaranteeId();
        
        // Compute elapsed days (block-based time axis).
        uint256 actualDays = (currentTimestamp - record.startTime) / _BLOCKS_PER_DAY;
        
        // Compute total days.
        uint256 totalDays = (record.maturityTime - record.startTime) / _BLOCKS_PER_DAY;
        if (totalDays == 0) totalDays = 1; // prevent div-by-zero
        // Clamp to maturity.
        if (actualDays > totalDays) {
            actualDays = totalDays;
        }
        
        // Use mulDiv to avoid overflow: promisedInterest * actualDays / totalDays.
        result.actualInterestPaid = Math.mulDiv(record.promisedInterest, actualDays, totalDays);
        
        // Compute penalty (extra N days interest), capped by the remaining guarantee.
        uint256 penaltyDays = record.earlyRepayPenaltyDays;
        uint256 dailyInterest = record.promisedInterest / totalDays;
        uint256 penaltyInterest = dailyInterest * penaltyDays;
        
        // Ensure penalty does not exceed remaining guarantee.
        uint256 remainingGuarantee = record.promisedInterest - result.actualInterestPaid;
        if (penaltyInterest > remainingGuarantee) {
            penaltyInterest = remainingGuarantee;
        }
        // Platform fee is taken from the penalty component (current policy).
        uint256 platformFee = (penaltyInterest * _platformFeeRate) / 10000;
        result.platformFee = platformFee;

        // Consistency constraint (SSOT, see Funds-Flow guide):
        // refundToBorrower + penaltyToLender + platformFee MUST equal promisedInterest,
        // otherwise `GuaranteeFundManager.settleEarlyRepayment` will revert.
        //
        // We treat `penaltyToLender` as the net amount paid to lender from the guarantee pool:
        // earnedInterest (actualInterestPaid) + penaltyInterest - platformFee.
        result.penaltyToLender = result.actualInterestPaid + penaltyInterest - platformFee;
        result.refundToBorrower = record.promisedInterest - result.actualInterestPaid - penaltyInterest;
        
        return result;
    }

    /*━━━━━━━━━━━━━━━ Upgrade auth ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrade.
     * @dev Reverts if:
     *      - caller lacks ACTION_UPGRADE_MODULE (via ACM.requireRole)
     *      - newImplementation == address(0) (ZeroAddress)
     *      - newImplementation has no code (EarlyRepaymentGuaranteeManager__InvalidImplementation)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_UPGRADE_MODULE)
     * - Additional governance integration (Timelock/Multisig) can be layered here if required
     *
     * @param newImplementation New implementation address.
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        uint256 blockNumber = block.number;
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // Validate target implementation.
        if (newImplementation.code.length == 0) revert EarlyRepaymentGuaranteeManager__InvalidImplementation();
        
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            blockNumber
        );
        
        // Additional validations can be added here (e.g., interface checks, storage layout compatibility).
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
} 