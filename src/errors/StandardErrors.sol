// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Project-wide custom errors collected here for consistency and easier decoding.

/*━━━━━━━━━━━━━━━ Basic Errors ━━━━━━━━━━━━━━━*/
error AmountIsZero();
error AmountMismatch();
error InsufficientBalance();
error InsufficientLiquidity();
error InsufficientCollateral();
error HealthFactorTooLow();
error InvalidHealthFactor();
error InvalidLTV();
error CapIsZero();
error InvalidAmounts();
error RepayAmountZero();
error PausedSystem();
error ZeroAddress();
error MissingRole();
error NotEnoughDebt();
error Overpay();
error DivisionByZero();
error InvalidCaller();
error VaultCapExceeded();
error StatsNotFound();
error InvalidStatsData();
/// @notice Batch size exceeds a global max.
/// @dev Standardized across view/aggregator modules: `BatchTooLarge(actual, max)`.
error BatchTooLarge(uint256 length, uint256 max);

/*━━━━━━━━━━━━━━━ Registry Errors ━━━━━━━━━━━━━━━*/
error MismatchedArrayLengths(uint256 keysLength, uint256 addressesLength);
error ModuleAlreadyRegistered(bytes32 key);
error ModuleNotRegistered(bytes32 key);
error ModuleUpgradeNotReady(
    bytes32 key,
    uint256 executeAfter,
    uint256 currentTime
);
error ModuleUpgradeNotFound(bytes32 key);
error ModuleUpgradeAlreadyExists(bytes32 key);
error ModuleUpgradeDuplicate(bytes32 key, address oldAddr, address newAddr);
error ModuleAlreadyExists(bytes32 key);
error DelayTooLong(uint256 delay, uint256 maxDelay);
error DelayTooShort(uint256 delay, uint256 minDelay);
error InvalidDelayValue(uint256 delay);
error UpgradeNotAuthorized(address caller, address requiredAdmin);
error EmergencyAdminNotAuthorized(address caller, address emergencyAdmin);
error InvalidPendingAdmin(address pendingAdmin);
error NotPendingAdmin(address caller, address pendingAdmin);
error InvalidUpgradeAdmin(address upgradeAdmin);
error InvalidEmergencyAdmin(address emergencyAdmin);

/*━━━━━━━━━━━━━━━ Signature Errors ━━━━━━━━━━━━━━━*/
error SignatureExpired(uint256 deadline, uint256 currentTime);
error InvalidSigner(address signer);
error InvalidNonce(
    address signer,
    uint256 expectedNonce,
    uint256 providedNonce
);
error InvalidSignature(address recoveredSigner, address expectedSigner);
error SignatureZeroAddress();

/*━━━━━━━━━━━━━━━ Contract Validation Errors ━━━━━━━━━━━━━━━*/
error NotAContract(address addr);

/*━━━━━━━━━━━━━━━ Index And Array Errors ━━━━━━━━━━━━━━━*/
error IndexOutOfBounds(uint256 index, uint256 length);
error EmptyArray();
error ArrayLengthMismatch(uint256 length1, uint256 length2);

/*━━━━━━━━━━━━━━━ Storage And Initialization Errors ━━━━━━━━━━━━━━━*/
error AlreadyInitialized();
error NotInitialized();
error StorageVersionMismatch(uint256 expected, uint256 actual);
error InvalidStorageVersion(uint256 version);
error MinDelayTooLarge(uint256 delay, uint256 maxDelay);
error MinDelayOverflow(uint256 delay);

/*━━━━━━━━━━━━━━━ Module Errors ━━━━━━━━━━━━━━━*/
error ModuleCapExceeded(uint256 count, uint256 maxCount);

/*━━━━━━━━━━━━━━━ Permission Errors ━━━━━━━━━━━━━━━*/
error NotGovernance();
error NotKeeper();
error NotWhitelisted();
error AssetNotAllowed();

/*━━━━━━━━━━━━━━━ PriceOracle Errors ━━━━━━━━━━━━━━━*/
error PriceOracle__AssetAlreadySupported();
error PriceOracle__AssetNotSupported();
error PriceOracle__StalePrice();
error PriceOracle__InvalidPrice();
error PriceOracle__Unauthorized();

/*━━━━━━━━━━━━━━━ FeeRouter Errors ━━━━━━━━━━━━━━━*/
error FeeRouter__ZeroAddress();
error FeeRouter__InvalidFeeRate();
error FeeRouter__InvalidRecipient();

/*━━━━━━━━━━━━━━━ LendingEngine Errors ━━━━━━━━━━━━━━━*/
error LendingEngine__ZeroAddress();
error LendingEngine__InvalidLoan();
error LendingEngine__InsufficientLiquidity();

/*━━━━━━━━━━━━━━━ Registry Module Errors ━━━━━━━━━━━━━━━*/
error Registry__ZeroAddress();
error Registry__ModuleNotFound();
error Registry__ModuleAlreadyExists();

/*━━━━━━━━━━━━━━━ Reward Errors ━━━━━━━━━━━━━━━*/
error RewardManager__ZeroAddress();
error RewardManager__MissingMinterRole();
error RewardManagerCore__ZeroAddress();

/*━━━━━━━━━━━━━━━ Access Control Errors ━━━━━━━━━━━━━━━*/
error AccessControlManager__ZeroAddress();
error AccessControlManager__MissingRole(bytes32 role, address account);
error AccessControlManager__MissingEitherRole(
    bytes32 role1,
    bytes32 role2,
    address account
);

/// @dev Reverts when an RWA lending asset is not authorized by policy.
error RWAAssetNotAllowed(address token);

/*━━━━━━━━━━━━━━━ Guarantee Errors ━━━━━━━━━━━━━━━*/
error GuaranteeNotPaid();
error GuaranteeAlreadyReleased();
error InvalidGuaranteeAmount();
error NotEnoughGuarantee();
error GuaranteeNotActive();
error InvalidGuaranteeId();
error GuaranteeAlreadyProcessed();
error GuaranteeRecordNotFound();
error GuaranteeIdOverflow();
error InvalidGuaranteeTerm();
error GuaranteeInterestTooHigh();
error BorrowerCannotBeLender();

/*━━━━━━━━━━━━━━━ Early Repayment Guarantee Errors ━━━━━━━━━━━━━━━*/
error EarlyRepaymentGuaranteeManager__OnlyVaultCore();
error EarlyRepaymentGuaranteeManager__InvalidImplementation();
error EarlyRepaymentGuaranteeManager__RateTooHigh();
error EarlyRepaymentGuaranteeManager__RateUnchanged();

/// @dev Re-throws a caught external module revert with a readable module label and raw revert data payload.
error ExternalModuleRevertedRaw(string module, bytes data);
