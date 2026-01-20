// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../constants/DataPushTypes.sol";
import { IFeeRouter } from "../interfaces/IFeeRouter.sol";
import { SystemEvents } from "../Vault/SystemEvents.sol";
import { VaultMath } from "../Vault/VaultMath.sol";
import { IVaultCoreMinimal } from "../interfaces/IVaultCoreMinimal.sol";
import { IFeeRouterView } from "../interfaces/IFeeRouterView.sol";
import { 
    AmountIsZero, 
    FeeRouter__ZeroAddress,
    NotAContract
} from "../errors/StandardErrors.sol";

/**
 * @title FeeRouter
 * @notice Routes fee funds and distributes them to the configured treasuries.
 * @dev The write-side SSOT for fee routing; the view-side mirror is updated best-effort via
 *      VaultCore.viewContractAddrVar().
 * @custom:security-contact security@example.com
 */
contract FeeRouter is 
    Initializable, 
    PausableUpgradeable, 
    UUPSUpgradeable,
    IFeeRouter
{
    using SafeERC20 for IERC20;

    /*━━━━━━━━━━━━━━━ STATE ━━━━━━━━━━━━━━━*/
    /// @notice Registry contract address.
    address private _registryAddr;
    
    /// @notice Platform treasury address.
    address private _platformTreasury;
    
    /// @notice Ecosystem vault address.
    address private _ecosystemVault;

    /// @notice Platform fee rate (bps; 50 = 0.50%).
    uint256 private _platformFeeBps;
    
    /// @notice Ecosystem fee rate (bps; 20 = 0.20%).
    uint256 private _ecosystemFeeBps;

    /// @notice Fee cache: token => feeType => cachedAmount.
    mapping(address => mapping(bytes32 => uint256)) private _feeCache;
    
    /// @notice Dynamic fee config: token => feeType => feeBps.
    mapping(address => mapping(bytes32 => uint256)) private _dynamicFees;
    
    /// @notice Supported token list.
    address[] private _supportedTokens;
    
    /// @notice Supported token flags.
    mapping(address => bool) private _isSupportedToken;
    
    /// @notice Fee statistics: token => feeType => totalAmount.
    mapping(address => mapping(bytes32 => uint256)) private _feeStatistics;

    /// @notice Operation statistics.
    uint256 private _totalDistributions;
    uint256 private _totalAmountDistributed;
    
    // NOTE: This contract intentionally avoids caching ACM locally; permissions are resolved via Registry.

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    /**
     * @notice Invalid configuration (e.g., fee bps sum constraints).
     * @dev Reverts if:
     *      - N/A (error selector only)
     *
     * Security:
     * - Input/config validation guard
     */
    error FeeRouter__InvalidConfig();
    
    /**
     * @notice Token is not supported.
     * @dev Reverts if:
     *      - N/A (error selector only)
     *
     * Security:
     * - Prevents routing/distribution for unconfigured tokens
     */
    error FeeRouter__TokenNotSupported();
    
    /**
     * @notice Invalid fee type (no dynamic fee configured).
     * @dev Reverts if:
     *      - N/A (error selector only)
     *
     * Security:
     * - Prevents using unconfigured fee types
     */
    error FeeRouter__InvalidFeeType();

    /**
     * @notice Invalid batch size (arrays mismatch or exceed max size).
     * @dev Reverts if:
     *      - N/A (error selector only)
     *
     * Security:
     * - DoS/gas guard for batch operations
     */
    error FeeRouter__InvalidBatchSize();

    /*━━━━━━━━━━━━━━━ Best-effort View Push Observability ━━━━━━━━━━━━━━━*/
    /// @notice Emitted when a best-effort FeeRouterView push fails (must not revert main flow).
    /// @param kind Push kind identifier.
    /// @param payer User address when applicable; address(0) for system/global-only pushes.
    /// @param token Token address when applicable; address(0) for system config pushes.
    /// @param feeType Fee type when applicable; bytes32(0) otherwise.
    /// @param viewAddr Target view address (may be zero if unresolved/misconfigured).
    /// @param reason Raw revert data or an encoded failure reason.
    event FeeRouterViewPushFailed(
        bytes32 indexed kind,
        address indexed payer,
        address indexed token,
        bytes32 feeType,
        address viewAddr,
        bytes reason
    );

    bytes32 private constant _PUSH_KIND_SYSTEM_CONFIG = keccak256("FEE_ROUTER_VIEW_PUSH_SYSTEM_CONFIG");
    bytes32 private constant _PUSH_KIND_GLOBAL_STATS  = keccak256("FEE_ROUTER_VIEW_PUSH_GLOBAL_STATS");
    bytes32 private constant _PUSH_KIND_USER_FEE       = keccak256("FEE_ROUTER_VIEW_PUSH_USER_FEE");
    bytes32 private constant _PUSH_KIND_GLOBAL_FEE     = keccak256("FEE_ROUTER_VIEW_PUSH_GLOBAL_FEE_STAT");

    /*━━━━━━━━━━━━━━━ MODIFIERS ━━━━━━━━━━━━━━━*/
    
    /// @notice Ensures the registry address is non-zero and contains code.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert FeeRouter__ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @notice Resolves permissions via ACM (Registry.KEY_ACCESS_CONTROL) and enforces the given actionKey.
    modifier onlyRole(bytes32 actionKey) {
        _requireRole(actionKey, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ INITIALIZER ━━━━━━━━━━━━━━━*/

    /**
     * @notice Initialize the FeeRouter.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0)
     *      - platformTreasury == address(0)
     *      - ecosystemVault == address(0)
     *      - platformFeeBps + ecosystemFeeBps >= 10_000
     *
     * Security:
     * - Callable only once (initializer).
     *
     * @param initialRegistryAddr Registry contract address.
     * @param platformTreasury Platform treasury address.
     * @param ecosystemVault Ecosystem vault address.
     * @param platformFeeBps Platform fee rate in bps (10_000 = 100%).
     * @param ecosystemFeeBps Ecosystem fee rate in bps (10_000 = 100%).
     */
    function initialize(
        address initialRegistryAddr,
        address platformTreasury,
        address ecosystemVault,
        uint256 platformFeeBps,
        uint256 ecosystemFeeBps
    ) external initializer {
        // Validate inputs.
        if (initialRegistryAddr == address(0) || platformTreasury == address(0) || ecosystemVault == address(0)) {
            revert FeeRouter__ZeroAddress();
        }
        if (platformFeeBps + ecosystemFeeBps >= 1e4) {
            revert FeeRouter__InvalidConfig();
        }

        __UUPSUpgradeable_init();
        __Pausable_init();

        _registryAddr = initialRegistryAddr;
        _platformTreasury = platformTreasury;
        _ecosystemVault = ecosystemVault;
        _platformFeeBps = platformFeeBps;
        _ecosystemFeeBps = ecosystemFeeBps;
        
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ EXTERNAL FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Distribute fees using the fixed (platform + ecosystem) fee configuration.
     * @dev Reverts if:
     *      - amount == 0 (AmountIsZero)
     *      - token is not supported (FeeRouter__TokenNotSupported)
     *      - system is paused (Pausable)
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_DEPOSIT role (ACM)
     *      - ERC20 transferFrom/transfer fails
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_DEPOSIT).
     *
     * @param token ERC20 token address (must be supported).
     * @param amount Total amount pulled from msg.sender (token decimals).
     */
    function distributeNormal(address token, uint256 amount)
        external
        override
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_DEPOSIT)
    {
        if (amount == 0) revert AmountIsZero();
        if (!_isSupportedToken[token]) revert FeeRouter__TokenNotSupported();
        
        _distribute(token, amount, ActionKeys.ACTION_DEPOSIT);
        _updateStats(1, amount);
        _emitActionExecuted(ActionKeys.ACTION_DEPOSIT);
    }

    /**
     * @notice Distribute multiple fee items in a single transaction (gas-optimized).
     * @dev Reverts if:
     *      - token is not supported (FeeRouter__TokenNotSupported)
     *      - amounts.length != feeTypes.length (FeeRouter__InvalidBatchSize)
     *      - amounts.length > 50 (FeeRouter__InvalidBatchSize)
     *      - system is paused (Pausable)
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_DEPOSIT role (ACM)
     *      - ERC20 transferFrom/transfer fails
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_DEPOSIT).
     *
     * @param token ERC20 token address (must be supported).
     * @param amounts Per-item total amounts pulled from msg.sender (token decimals). Zero amounts are skipped.
     * @param feeTypes Per-item feeType identifiers.
     */
    function batchDistribute(
        address token,
        uint256[] calldata amounts,
        bytes32[] calldata feeTypes
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_DEPOSIT) {
        if (!_isSupportedToken[token]) revert FeeRouter__TokenNotSupported();
        
        uint256 length = amounts.length;
        if (length != feeTypes.length || length > 50) revert FeeRouter__InvalidBatchSize();
        
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < length; i++) {
            if (amounts[i] == 0) continue;
            _distribute(token, amounts[i], feeTypes[i]);
            totalAmount += amounts[i];
        }
        
        // NOTE: distributions count uses the input length (even if some items are zero and skipped).
        _updateStats(length, totalAmount);
        emit BatchFeeDistributed(token, totalAmount, length);
        _emitActionExecuted(ActionKeys.ACTION_DEPOSIT);

        // Unified data push (batch distribution summary).
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BATCH_FEE_DISTRIBUTED,
            abi.encode(token, totalAmount, length, msg.sender, ts)
        );
    }

    /**
     * @notice Distribute fees using a dynamic fee configuration (token, feeType).
     * @dev Reverts if:
     *      - amount == 0 (AmountIsZero)
     *      - token is not supported (FeeRouter__TokenNotSupported)
     *      - dynamic fee is not configured for (token, feeType) (FeeRouter__InvalidFeeType)
     *      - system is paused (Pausable)
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_DEPOSIT role (ACM)
     *      - ERC20 transferFrom/transfer fails
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_DEPOSIT).
     *
     * @param token ERC20 token address (must be supported).
     * @param amount Total amount pulled from msg.sender (token decimals).
     * @param feeType Fee type identifier.
     */
    function distributeDynamic(address token, uint256 amount, bytes32 feeType)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_DEPOSIT)
    {
        if (amount == 0) revert AmountIsZero();
        if (!_isSupportedToken[token]) revert FeeRouter__TokenNotSupported();
        if (_dynamicFees[token][feeType] == 0) revert FeeRouter__InvalidFeeType();
        
        _distributeDynamic(token, amount, feeType);
        _updateStats(1, amount);
        _emitActionExecuted(ActionKeys.ACTION_DEPOSIT);
    }

    /*━━━━━━━━━━━━━━━ VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Return whether a token is supported for fee routing.
     * @param token ERC20 token address.
     * @return True if supported.
     */
    function isTokenSupported(address token) external view returns (bool) {
        return _isSupportedToken[token];
    }

    /**
     * @notice Return the total fixed fee rate.
     * @return Total fee rate in bps (10_000 = 100%).
     */
    function getFeeRate() external view override returns (uint256) {
        return _platformFeeBps + _ecosystemFeeBps;
    }

    /**
     * @notice Quote the deposit fee for an amount under the fixed fee configuration.
     * @dev This is a pure quote; the contract does not pull funds here.
     * @param user User address (reserved for future personalization).
     * @param amount Amount to quote on (token decimals).
     * @return fee Fee amount (token decimals).
     */
    function chargeDepositFee(address user, uint256 amount) external view override returns (uint256 fee) {
        user; // reserved for future personalization
        return _calculateFee(amount);
    }

    /**
     * @notice Quote the borrow fee for an amount under the fixed fee configuration.
     * @dev This is a pure quote; the contract does not pull funds here.
     * @param user User address (reserved for future personalization).
     * @param amount Amount to quote on (token decimals).
     * @return fee Fee amount (token decimals).
     */
    function chargeBorrowFee(address user, uint256 amount) external view override returns (uint256 fee) {
        user; // reserved for future personalization
        return _calculateFee(amount);
    }

    /*━━━━━━━━━━━━━━━ Safe getters ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Return the configured Registry address.
     * @return registry Registry address.
     */
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }
    
    /**
     * @notice Return the platform treasury address.
     * @return treasury Platform treasury address.
     */
    function getPlatformTreasury() external view returns (address treasury) {
        return _platformTreasury;
    }
    
    /**
     * @notice Return the ecosystem vault address.
     * @return vault Ecosystem vault address.
     */
    function getEcosystemVault() external view returns (address vault) {
        return _ecosystemVault;
    }
    
    /**
     * @notice Return the platform fee rate.
     * @return feeBps Platform fee rate in bps.
     */
    function getPlatformFeeBps() external view returns (uint256 feeBps) {
        return _platformFeeBps;
    }
    
    /**
     * @notice Return the ecosystem fee rate.
     * @return feeBps Ecosystem fee rate in bps.
     */
    function getEcosystemFeeBps() external view returns (uint256 feeBps) {
        return _ecosystemFeeBps;
    }
    
    /**
     * @notice Return the total number of distributions recorded by this contract.
     * @return distributions Total distribution count.
     */
    function getTotalDistributions() external view returns (uint256 distributions) {
        return _totalDistributions;
    }
    
    /**
     * @notice Return the total distributed amount recorded by this contract.
     * @return amount Total distributed amount (token decimals aggregated by input amounts).
     */
    function getTotalAmountDistributed() external view returns (uint256 amount) {
        return _totalAmountDistributed;
    }

    /*━━━━━━━━━━━━━━━ Direct state views ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Return the supported token list.
     * @return Supported ERC20 token addresses.
     */
    function getSupportedTokens() external view returns (address[] memory) {
        return _supportedTokens;
    }

    /**
     * @notice Return the accumulated fee statistics for a (token, feeType).
     * @param token ERC20 token address.
     * @param feeType Fee type identifier.
     * @return Total amount recorded for (token, feeType) (token decimals).
     */
    function getFeeStatistics(address token, bytes32 feeType) external view returns (uint256) {
        return _feeStatistics[token][feeType];
    }

    /**
     * @notice Return the configured dynamic fee bps for (token, feeType).
     * @param token ERC20 token address.
     * @param feeType Fee type identifier.
     * @return Dynamic fee rate in bps.
     */
    function getDynamicFee(address token, bytes32 feeType) external view returns (uint256) {
        return _dynamicFees[token][feeType];
    }

    /**
     * @notice Return the fee cache value for (token, feeType).
     * @param token ERC20 token address.
     * @param feeType Fee type identifier.
     * @return Cached amount (token decimals).
     */
    function getFeeCache(address token, bytes32 feeType) external view returns (uint256) {
        return _feeCache[token][feeType];
    }

    /**
     * @notice Return operation statistics in a single call.
     * @return distributions Total distribution count.
     * @return totalAmount Total distributed amount.
     */
    function getOperationStats() external view returns (uint256 distributions, uint256 totalAmount) {
        return (_totalDistributions, _totalAmountDistributed);
    }

    /**
     * @notice Set the fixed fee configuration (platform + ecosystem).
     * @dev Reverts if:
     *      - platformBps + ecosystemBps >= 10_000 (FeeRouter__InvalidConfig)
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_SET_PARAMETER role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     *
     * @param platformBps Platform fee rate in bps.
     * @param ecosystemBps Ecosystem fee rate in bps.
     */
    function setFeeConfig(uint256 platformBps, uint256 ecosystemBps)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        if (platformBps + ecosystemBps >= 1e4) revert FeeRouter__InvalidConfig();
        
        _platformFeeBps = platformBps;
        _ecosystemFeeBps = ecosystemBps;
        
        emit FeeConfigUpdated(platformBps, ecosystemBps);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_CONFIG_UPDATED,
            abi.encode(platformBps, ecosystemBps, msg.sender, ts)
        );
    }

    /**
     * @notice Set treasury recipient addresses.
     * @dev Reverts if:
     *      - platformTreasury == address(0) (FeeRouter__ZeroAddress)
     *      - ecosystemVault == address(0) (FeeRouter__ZeroAddress)
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_SET_PARAMETER role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     *
     * @param platformTreasury Platform treasury address.
     * @param ecosystemVault Ecosystem vault address.
     */
    function setTreasury(address platformTreasury, address ecosystemVault)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        if (platformTreasury == address(0) || ecosystemVault == address(0)) revert FeeRouter__ZeroAddress();
        
        address oldPlatformTreasury = _platformTreasury;
        address oldEcosystemVault = _ecosystemVault;
        
        _platformTreasury = platformTreasury;
        _ecosystemVault = ecosystemVault;
        
        emit PlatformTreasuryUpdated(oldPlatformTreasury, platformTreasury);
        emit EcosystemVaultUpdated(oldEcosystemVault, ecosystemVault);
        // Interface/ABI compatibility: aggregated event (in addition to the granular updates above).
        emit TreasuryUpdated(platformTreasury, ecosystemVault);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_TREASURY_UPDATED,
            abi.encode(oldPlatformTreasury, platformTreasury, oldEcosystemVault, ecosystemVault, msg.sender, ts)
        );
    }

    /**
     * @notice Set dynamic fee bps for (token, feeType).
     * @dev Reverts if:
     *      - token == address(0) (FeeRouter__ZeroAddress)
     *      - feeBps >= 10_000 (FeeRouter__InvalidConfig)
     *      - feeBps + (feeBps / 2) >= 10_000 (FeeRouter__InvalidConfig)
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_SET_PARAMETER role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     *
     * @param token ERC20 token address.
     * @param feeType Fee type identifier.
     * @param feeBps Dynamic fee rate in bps.
     */
    function setDynamicFee(address token, bytes32 feeType, uint256 feeBps)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        if (token == address(0)) revert FeeRouter__ZeroAddress();
        if (feeBps >= 1e4) revert FeeRouter__InvalidConfig();
        // Constraint: dynamic fee + ecosystem share (50% of dynamic) must be < 100%.
        if (feeBps + (feeBps / 2) >= 1e4) revert FeeRouter__InvalidConfig();
        
        uint256 oldFee = _dynamicFees[token][feeType];
        _dynamicFees[token][feeType] = feeBps;
        
        emit DynamicFeeUpdated(token, feeType, oldFee, feeBps);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_DYNAMIC_FEE_UPDATED,
            abi.encode(token, feeType, oldFee, feeBps, msg.sender, ts)
        );
    }

    /**
     * @notice Add a supported token.
     * @dev Reverts if:
     *      - token == address(0) (FeeRouter__ZeroAddress)
     *      - token is already supported (FeeRouter__InvalidConfig)
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_SET_PARAMETER role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     *
     * @param token ERC20 token address.
     */
    function addSupportedToken(address token) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (token == address(0)) revert FeeRouter__ZeroAddress();
        if (_isSupportedToken[token]) revert FeeRouter__InvalidConfig();
        
        _isSupportedToken[token] = true;
        _supportedTokens.push(token);
        
        emit TokenSupported(token, true);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_TOKEN_SUPPORTED,
            abi.encode(token, true, msg.sender, ts)
        );
    }

    /**
     * @notice Remove a supported token.
     * @dev Reverts if:
     *      - token is not supported (FeeRouter__InvalidConfig)
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_SET_PARAMETER role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     *
     * @param token ERC20 token address.
     */
    function removeSupportedToken(address token) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (!_isSupportedToken[token]) revert FeeRouter__InvalidConfig();
        
        _isSupportedToken[token] = false;
        
        // Remove from the list (swap & pop).
        for (uint256 i = 0; i < _supportedTokens.length; i++) {
            if (_supportedTokens[i] == token) {
                _supportedTokens[i] = _supportedTokens[_supportedTokens.length - 1];
                _supportedTokens.pop();
                break;
            }
        }
        
        emit TokenSupported(token, false);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_TOKEN_SUPPORTED,
            abi.encode(token, false, msg.sender, ts)
        );
    }

    /**
     * @notice Clear fee cache for (token, feeType).
     * @dev Reverts if:
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_SET_PARAMETER role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_SET_PARAMETER).
     *
     * @param token ERC20 token address.
     * @param feeType Fee type identifier.
     */
    function clearFeeCache(address token, bytes32 feeType)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        delete _feeCache[token][feeType];
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);

        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_CACHE_CLEARED,
            abi.encode(token, feeType, msg.sender, ts)
        );
    }

    /**
     * @notice Pause fee distributions.
     * @dev Reverts if:
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_PAUSE_SYSTEM role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_PAUSE_SYSTEM).
     */
    function pause() external onlyValidRegistry onlyRole(ActionKeys.ACTION_PAUSE_SYSTEM) {
        _pause();
        _emitActionExecuted(ActionKeys.ACTION_PAUSE_SYSTEM);

        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_PAUSE_STATUS_UPDATED, abi.encode(true, msg.sender, ts));
    }

    /**
     * @notice Unpause fee distributions.
     * @dev Reverts if:
     *      - registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_UNPAUSE_SYSTEM role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_UNPAUSE_SYSTEM).
     */
    function unpause() external onlyValidRegistry onlyRole(ActionKeys.ACTION_UNPAUSE_SYSTEM) {
        _unpause();
        _emitActionExecuted(ActionKeys.ACTION_UNPAUSE_SYSTEM);

        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_PAUSE_STATUS_UPDATED, abi.encode(false, msg.sender, ts));
    }
    
    /**
     * @notice Update the Registry address (upgrade/migration hook).
     * @dev Reverts if:
     *      - newRegistryAddr == address(0) (FeeRouter__ZeroAddress)
     *      - current registry is invalid (FeeRouter__ZeroAddress)
     *      - caller lacks ACTION_UPGRADE_MODULE role (ACM)
     *
     * Security:
     * - Role-gated via ACM.requireRole(ACTION_UPGRADE_MODULE).
     *
     * @param newRegistryAddr New Registry contract address.
     */
    function updateRegistry(address newRegistryAddr)
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_UPGRADE_MODULE)
    {
        if (newRegistryAddr == address(0)) revert FeeRouter__ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        _emitActionExecuted(ActionKeys.ACTION_UPGRADE_MODULE);
        
        // Emit module address update event.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        emit SystemEvents.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_FR),
            oldRegistry,
            newRegistryAddr,
            ts
        );

        // Unified data push.
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REGISTRY_UPDATED,
            abi.encode(oldRegistry, newRegistryAddr, msg.sender, ts)
        );

        // Sync new view (best-effort) to avoid stale view state.
        _pushSystemConfigToView();
        _pushGlobalStatsToView();
    }

    /*━━━━━━━━━━━━━━━ Common helpers ━━━━━━━━━━━━━━━*
    
    /**
     * @notice Emit a normalized ActionExecuted system event.
     * @param actionKey Action key.
     */
    function _emitActionExecuted(bytes32 actionKey) internal {
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        emit SystemEvents.ActionExecuted(
            actionKey,
            ActionKeys.getActionKeyString(actionKey),
            msg.sender,
            ts
        );
    }
    
    /**
     * @notice Update stats and push global stats to view (best-effort).
     * @param distributions Distribution count delta.
     * @param amount Amount delta (token decimals).
     */
    function _updateStats(uint256 distributions, uint256 amount) internal {
        _totalDistributions += distributions;
        _totalAmountDistributed += amount;
        _pushGlobalStatsToView();
    }

    /**
     * @notice Enforce role via ACM (resolved from Registry).
     * @param actionKey Action key.
     * @param user Caller address.
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice Compute fee amount for a given base amount using fixed fee bps.
     * @param amount Base amount (token decimals).
     * @return fee Fee amount (token decimals).
     */
    function _calculateFee(uint256 amount) internal view returns (uint256 fee) {
        uint256 totalFeeBps = _platformFeeBps + _ecosystemFeeBps;
        return VaultMath.calculateFee(amount, totalFeeBps);
    }

    /**
     * @notice Internal fee distribution using fixed bps.
     * @param token ERC20 token address.
     * @param amount Total amount (token decimals).
     * @param feeType Fee type identifier.
     */
    function _distribute(address token, uint256 amount, bytes32 feeType) internal whenNotPaused {
        uint256 platformBps = _platformFeeBps;
        uint256 ecoBps = _ecosystemFeeBps;
        (uint256 platformAmt, uint256 ecoAmt, uint256 remaining) = _calculateDistribution(amount, platformBps, ecoBps);
        _executeFeeDistribution(
            token,
            platformAmt,
            ecoAmt,
            remaining,
            feeType,
            amount,
            msg.sender,
            platformBps + ecoBps
        );
    }

    /**
     * @notice Internal fee distribution using dynamic bps.
     * @param token ERC20 token address.
     * @param amount Total amount (token decimals).
     * @param feeType Fee type identifier.
     */
    function _distributeDynamic(address token, uint256 amount, bytes32 feeType) internal whenNotPaused {
        uint256 dynamicFeeBps = _dynamicFees[token][feeType];
        uint256 halfDynamicFee = dynamicFeeBps / 2; // ecosystem share = half of dynamic fee
        
        (uint256 platformAmt, uint256 ecoAmt, uint256 remaining) =
            _calculateDistribution(amount, dynamicFeeBps, halfDynamicFee);
        _executeFeeDistribution(
            token,
            platformAmt,
            ecoAmt,
            remaining,
            feeType,
            amount,
            msg.sender,
            dynamicFeeBps + halfDynamicFee
        );
    }

    /**
     * @notice Compute distribution amounts (platform, ecosystem, remaining).
     * @param amount Total amount (token decimals).
     * @param platformBps Platform fee rate in bps.
     * @param ecoBps Ecosystem fee rate in bps.
     * @return platformAmt Platform fee amount.
     * @return ecoAmt Ecosystem fee amount.
     * @return remaining Remaining amount refunded to msg.sender.
     */
    function _calculateDistribution(uint256 amount, uint256 platformBps, uint256 ecoBps) 
        internal 
        pure 
        returns (uint256 platformAmt, uint256 ecoAmt, uint256 remaining) 
    {
        platformAmt = VaultMath.calculateFee(amount, platformBps);
        ecoAmt = VaultMath.calculateFee(amount, ecoBps);
        remaining = amount - platformAmt - ecoAmt;
    }

    /**
     * @notice Resolve the current view contract address (best-effort).
     * @dev SSOT: resolved via VaultCore.viewContractAddrVar(). No registry-key fallbacks to avoid drift.
     */
    function _resolveFeeRouterViewAddr() internal view returns (address) {
        address registryAddr = _registryAddr;
        if (registryAddr == address(0) || registryAddr.code.length == 0) return address(0);

        // SSOT (Architecture-Guide): view address is resolved via VaultCore.viewContractAddrVar().
        // NOTE: Do NOT add alternative Registry keys as fallbacks here, to avoid multi-source drift.
        try IRegistry(registryAddr).getModule(ModuleKeys.KEY_VAULT_CORE) returns (address vaultCore) {
            if (vaultCore != address(0)) {
                try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (address viewAddr) {
                    if (viewAddr != address(0)) return viewAddr;
                } catch {
                    _noop();
                }
            }
        } catch {
            _noop();
        }

        return address(0);
    }

    /**
     * @notice Push system config to the view (best-effort).
     */
    function _pushSystemConfigToView() internal {
        address viewAddr = _resolveFeeRouterViewAddr();
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            emit FeeRouterViewPushFailed(
                _PUSH_KIND_SYSTEM_CONFIG,
                address(0),
                address(0),
                bytes32(0),
                viewAddr,
                bytes("view unavailable")
            );
            return;
        }

        address[] memory tokens = _copySupportedTokens();
        try IFeeRouterView(viewAddr).pushSystemConfigUpdate(
            _platformTreasury,
            _ecosystemVault,
            _platformFeeBps,
            _ecosystemFeeBps,
            tokens
        ) {
            _noop();
        } catch (bytes memory reason) {
            emit FeeRouterViewPushFailed(
                _PUSH_KIND_SYSTEM_CONFIG,
                address(0),
                address(0),
                bytes32(0),
                viewAddr,
                reason
            );
        }
    }

    /**
     * @notice Push global stats to the view (best-effort).
     */
    function _pushGlobalStatsToView() internal {
        address viewAddr = _resolveFeeRouterViewAddr();
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            emit FeeRouterViewPushFailed(
                _PUSH_KIND_GLOBAL_STATS,
                address(0),
                address(0),
                bytes32(0),
                viewAddr,
                bytes("view unavailable")
            );
            return;
        }

        try IFeeRouterView(viewAddr).pushGlobalStatsUpdate(_totalDistributions, _totalAmountDistributed) {
            _noop();
        } catch (bytes memory reason) {
            emit FeeRouterViewPushFailed(
                _PUSH_KIND_GLOBAL_STATS,
                address(0),
                address(0),
                bytes32(0),
                viewAddr,
                reason
            );
        }
    }

    /**
     * @notice After distribution, push user/global fee stats to the view (best-effort).
     */
    function _pushFeeRouterViewAfterDistribution(
        address payer,
        address token,
        bytes32 feeType,
        uint256 totalAmount,
        uint256 appliedFeeBps
    ) internal {
        address viewAddr = _resolveFeeRouterViewAddr();
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            emit FeeRouterViewPushFailed(_PUSH_KIND_USER_FEE, payer, token, feeType, viewAddr, bytes("view unavailable"));
            return;
        }

        try IFeeRouterView(viewAddr).pushUserFeeUpdate(payer, feeType, totalAmount, appliedFeeBps) {
            _noop();
        } catch (bytes memory reason) {
            emit FeeRouterViewPushFailed(_PUSH_KIND_USER_FEE, payer, token, feeType, viewAddr, reason);
        }

        try IFeeRouterView(viewAddr).pushGlobalFeeStatistic(token, feeType, _feeStatistics[token][feeType]) {
            _noop();
        } catch (bytes memory reason) {
            emit FeeRouterViewPushFailed(_PUSH_KIND_GLOBAL_FEE, payer, token, feeType, viewAddr, reason);
        }
    }

    /**
     * @notice No-op helper used to satisfy solhint's no-empty-blocks rule for try/catch blocks.
     */
    function _noop() private pure {
        return;
    }

    /**
     * @notice Copy supported token list into memory.
     */
    function _copySupportedTokens() internal view returns (address[] memory tokens) {
        uint256 len = _supportedTokens.length;
        tokens = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            tokens[i] = _supportedTokens[i];
        }
    }

    /**
     * @notice Execute fee distribution (pull funds, pay recipients, refund remainder) and update stats/cache.
     * @param token ERC20 token address.
     * @param platformAmt Platform amount.
     * @param ecoAmt Ecosystem amount.
     * @param remaining Amount refunded to msg.sender.
     * @param feeType Fee type identifier.
     * @param totalAmount Total amount pulled (for stats).
     */
    function _executeFeeDistribution(
        address token,
        uint256 platformAmt,
        uint256 ecoAmt,
        uint256 remaining,
        bytes32 feeType,
        uint256 totalAmount,
        address payer,
        uint256 appliedFeeBps
    ) internal {
        // Pull total amount from msg.sender (caller must approve this contract).
        if (totalAmount > 0) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);
        }

        // Distribute fees.
        if (platformAmt > 0) {
            IERC20(token).safeTransfer(_platformTreasury, platformAmt);
        }
        if (ecoAmt > 0) {
            IERC20(token).safeTransfer(_ecosystemVault, ecoAmt);
        }
        if (remaining > 0) {
            // Refund remainder to msg.sender (usually an orchestrator contract).
            IERC20(token).safeTransfer(msg.sender, remaining);
        }

        // Update stats and cache.
        _feeStatistics[token][feeType] += totalAmount;
        _feeCache[token][feeType] += totalAmount;
        _pushFeeRouterViewAfterDistribution(payer, token, feeType, totalAmount, appliedFeeBps);

        emit FeeDistributed(token, platformAmt, ecoAmt);
        emit FeeStatisticsUpdated(token, feeType, _feeStatistics[token][feeType]);
        // Unified data push.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_DISTRIBUTED,
            abi.encode(token, platformAmt, ecoAmt, remaining, feeType, totalAmount, msg.sender, ts)
        );
    }



    /**
     * @notice Authorize UUPS upgrade.
     * @dev Reverts if caller lacks ACTION_UPGRADE_MODULE role (ACM).
     * @param newImpl New implementation address.
     */
    function _authorizeUpgrade(address newImpl) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        _emitActionExecuted(ActionKeys.ACTION_UPGRADE_MODULE);
        newImpl; // silence unused parameter
    }

    /*━━━━━━━━━━━━━━━ GAP ━━━━━━━━━━━━━━━*/
    uint256[32] private __gap; // Storage gap for upgrade-safe state layout changes.
}



 
 