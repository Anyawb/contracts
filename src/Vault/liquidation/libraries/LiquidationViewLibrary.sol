// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LiquidationValidationLibrary.sol";

import "./LiquidationCoreOperations.sol";
import "./ModuleCache.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { VaultMath } from "../../VaultMath.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";

/**
 * @title Liquidation View Library
 * @author RWA Lending Platform
 * @notice Provides liquidation query-related functionality, integrates all repeated query logic from liquidation modules
 * @dev Provides standardized query functions to ensure consistency and maintainability
 * @dev Uses ModuleCache according to ModuleCache_Usage_Guide.md specifications
 */
library LiquidationViewLibrary {
    using LiquidationValidationLibrary for *;


    using ModuleCache for ModuleCache.ModuleCacheStorage;
    using VaultMath for uint256;
    using LiquidationBase for *;

    /* ============ Custom Errors ============ */
    
    /// @notice Invalid user address error
    /// @param user Invalid user address
    error LiquidationViewLibrary__InvalidUserAddress(address user);
    
    /// @notice Invalid asset address error
    /// @param asset Invalid asset address
    error LiquidationViewLibrary__InvalidAssetAddress(address asset);
    
    /// @notice Too many batch operations error
    /// @param count Actual batch operation count
    /// @param maxCount Maximum allowed batch operation count
    error LiquidationViewLibrary__TooManyBatchOperations(uint256 count, uint256 maxCount);
    
    /// @notice Array length mismatch error
    /// @param length1 First array length
    /// @param length2 Second array length
    error LiquidationViewLibrary__ArrayLengthMismatch(uint256 length1, uint256 length2);
    
    /// @notice Module call failed error
    /// @param moduleKey Module key
    /// @param moduleAddress Module address
    error LiquidationViewLibrary__ModuleCallFailed(bytes32 moduleKey, address moduleAddress);

    /* ============ Constants ============ */
    
    /// @notice Maximum batch operation count
    uint256 public constant MAX_BATCH_OPERATIONS = 50;
    
    /// @notice Default cache expiration duration (in seconds)
    uint256 public constant DEFAULT_CACHE_DURATION = 300; // 5 minutes
    
    /// @notice Default module cache maximum validity period (in seconds)
    uint256 public constant DEFAULT_CACHE_MAX_AGE = 1 days;

    /* ============ Health Factor Query Functions ============ */
    
    /**
     * @notice Get user health factor
     * @param targetUserAddr User address
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return healthFactor Health factor
     */
    function getUserHealthFactor(
        address targetUserAddr,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        mapping(address => uint256) storage /* healthFactorCache */
    ) internal view returns (uint256 healthFactor) {
        // Get user's total collateral value and debt value
        (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValues(targetUserAddr, baseStorage, moduleCache);
        
        // Get liquidation threshold
        uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
        
        // Calculate health factor
        healthFactor = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
    }
    




    /* ============ Collateral Query Functions ============ */
    
    /**
     * @notice Get user seizable collateral amount
     * @dev Reverts if:
     *      - targetUserAddr is zero address
     *      - targetAssetAddr is zero address
     *      - CollateralManager module is not registered
     *
     * @param targetUserAddr User address
     * @param targetAssetAddr Asset address
     * @param moduleCache Module cache storage
     * @return seizableAmount Seizable collateral amount
     */
    function getSeizableCollateralAmount(
        address targetUserAddr,
        address targetAssetAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 seizableAmount) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        if (targetAssetAddr == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(targetAssetAddr);
        
        address collateralManagerAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManagerAddr == address(0)) {
            revert LiquidationViewLibrary__ModuleCallFailed(ModuleKeys.KEY_CM, collateralManagerAddr);
        }
        seizableAmount = ICollateralManager(collateralManagerAddr).getCollateral(targetUserAddr, targetAssetAddr);
    }
    
    /**
     * @notice Get user all seizable collaterals
     * @dev Reverts if:
     *      - targetUserAddr is zero address
     *      - CollateralManager module is not registered
     *
     * @param targetUserAddr User address
     * @param moduleCache Module cache storage
     * @return assets Array of asset addresses
     * @return amounts Array of collateral amounts
     */
    function getSeizableCollaterals(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (address[] memory assets, uint256[] memory amounts) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        
        address collateralManagerAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManagerAddr == address(0)) {
            revert LiquidationViewLibrary__ModuleCallFailed(ModuleKeys.KEY_CM, collateralManagerAddr);
        }
        assets = ICollateralManager(collateralManagerAddr).getUserCollateralAssets(targetUserAddr);
        amounts = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            try ICollateralManager(collateralManagerAddr).getCollateral(targetUserAddr, assets[i]) returns (uint256 amt) {
                amounts[i] = amt;
            } catch {
                amounts[i] = 0;
            }
        }
    }

    /* ============ Debt Query Functions ============ */
    
    /**
     * @notice Get user reducible debt amount
     * @dev Reverts if:
     *      - targetUserAddr is zero address
     *      - targetAssetAddr is zero address
     *      - LendingEngine module is not registered
     *
     * @param targetUserAddr User address
     * @param targetAssetAddr Asset address
     * @param moduleCache Module cache storage
     * @return reducibleAmount Reducible debt amount
     */
    function getReducibleDebtAmount(
        address targetUserAddr,
        address targetAssetAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 reducibleAmount) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        if (targetAssetAddr == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(targetAssetAddr);

        // Query reducible debt through LendingEngine using KEY_LE
        address lendingEngineAddr = ModuleCache.get(
            moduleCache,
            ModuleKeys.KEY_LE,
            DEFAULT_CACHE_MAX_AGE
        );
        if (lendingEngineAddr == address(0)) {
            revert LiquidationViewLibrary__ModuleCallFailed(ModuleKeys.KEY_LE, lendingEngineAddr);
        }
        try ILendingEngineBasic(lendingEngineAddr).getReducibleDebtAmount(targetUserAddr, targetAssetAddr) returns (uint256 amount) {
            return amount;
        } catch {
            return 0;
        }
    }
    
    /**
     * @notice Get user all reducible debts
     * @dev Reverts if:
     *      - targetUserAddr is zero address
     *      - LendingEngine module is not registered
     *
     * @param targetUserAddr User address
     * @param moduleCache Module cache storage
     * @return assets Array of asset addresses
     * @return amounts Array of reducible debt amounts
     */
    function getReducibleDebts(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (address[] memory assets, uint256[] memory amounts) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        
        // Get module address using ModuleCache specification
        address lendingEngineAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_LE, DEFAULT_CACHE_MAX_AGE);
        if (lendingEngineAddr == address(0)) {
            revert LiquidationViewLibrary__ModuleCallFailed(ModuleKeys.KEY_LE, lendingEngineAddr);
        }
        assets = new address[](0);
        amounts = new uint256[](0);
    }

    /* ============ Preview Functions ============ */
    
    /**
     * @notice Preview liquidation effect
     * @dev Reverts if:
     *      - targetUserAddr is zero address
     *      - collateralAssetAddr is zero address
     *      - debtAssetAddr is zero address
     *
     * @param targetUserAddr User address
     * @param collateralAssetAddr Collateral asset address
     * @param debtAssetAddr Debt asset address
     * @param collateralAmount Amount of collateral to liquidate
     * @param debtAmount Amount of debt to liquidate
     * @param simulateFlashLoan Whether to simulate Flash Loan impact
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return bonus Liquidation bonus
     * @return newHealthFactor New health factor after liquidation
     * @return newRiskScore New risk score after liquidation
     * @return slippageImpact Slippage impact (Flash Loan impact)
     */
    function previewLiquidation(
        address targetUserAddr,
        address collateralAssetAddr,
        address debtAssetAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        bool simulateFlashLoan,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (
        uint256 bonus,
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 slippageImpact
    ) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        if (collateralAssetAddr == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(collateralAssetAddr);
        if (debtAssetAddr == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(debtAssetAddr);
        
        // Calculate liquidation bonus (simplified version)
        bonus = (collateralAmount + debtAmount) * 50 / 10000; // 0.5% base bonus
        
        // Calculate new health factor
        newHealthFactor = _calculatePreviewHealthFactor(
            targetUserAddr,
            collateralAmount,
            debtAmount,
            baseStorage,
            moduleCache
        );
        
        // Calculate new risk score
        newRiskScore = _calculatePreviewRiskScore(
            targetUserAddr,
            collateralAmount,
            debtAmount,
            baseStorage,
            moduleCache
        );
        
        // Calculate Flash Loan impact
        if (simulateFlashLoan) {
            slippageImpact = _calculateFlashLoanImpact(
                collateralAssetAddr,
                debtAssetAddr,
                collateralAmount,
                debtAmount,
                baseStorage
            );
            bonus = bonus > slippageImpact ? bonus - slippageImpact : 0;
        } else {
            slippageImpact = 0;
        }
        
        return (bonus, newHealthFactor, newRiskScore, slippageImpact);
    }

    /* ============ Internal Helper Functions ============ */
    
    /**
     * @notice Get user values (collateral and debt)
     * @param targetUserAddr User address
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return collateralValue Total collateral value
     * @return debtValue Total debt value
     */
    function _getUserValues(
        address targetUserAddr,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 collateralValue, uint256 debtValue) {
        baseStorage; // silence unused (valuation is centralized elsewhere)
        address collateralManagerAddr = ModuleCache.get(
            moduleCache,
            ModuleKeys.KEY_CM,
            DEFAULT_CACHE_MAX_AGE
        );
        if (collateralManagerAddr != address(0)) {
            try ICollateralManager(collateralManagerAddr).getUserTotalCollateralValue(targetUserAddr) returns (uint256 cv) {
                collateralValue = cv;
            } catch {
                collateralValue = 0;
            }
        }

        address lendingEngineAddr = ModuleCache.get(
            moduleCache,
            ModuleKeys.KEY_LE,
            DEFAULT_CACHE_MAX_AGE
        );
        if (lendingEngineAddr != address(0)) {
            try ILendingEngineBasic(lendingEngineAddr).getUserTotalDebtValue(targetUserAddr) returns (uint256 dv) {
                debtValue = dv;
            } catch {
                debtValue = 0;
            }
        }
    }

    /**
     * @notice Get user values (simplified version, no BaseStorage required)
     * @param targetUserAddr User address
     * @param moduleCache Module cache storage
     * @return collateralValue Total collateral value
     * @return debtValue Total debt value
     */
    function _getUserValuesSimple(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 collateralValue, uint256 debtValue) {
        address collateralManagerAddr = ModuleCache.get(
            moduleCache,
            ModuleKeys.KEY_CM,
            DEFAULT_CACHE_MAX_AGE
        );
        if (collateralManagerAddr != address(0)) {
            try ICollateralManager(collateralManagerAddr).getUserTotalCollateralValue(targetUserAddr) returns (uint256 cv) {
                collateralValue = cv;
            } catch {
                collateralValue = 0;
            }
        }

        address lendingEngineAddr = ModuleCache.get(
            moduleCache,
            ModuleKeys.KEY_LE,
            DEFAULT_CACHE_MAX_AGE
        );
        if (lendingEngineAddr != address(0)) {
            try ILendingEngineBasic(lendingEngineAddr).getUserTotalDebtValue(targetUserAddr) returns (uint256 dv) {
                debtValue = dv;
            } catch {
                debtValue = 0;
            }
        }
    }
    
    /**
     * @notice Get liquidation threshold
     * @param baseStorage Base storage structure
     * @return threshold Liquidation threshold
     */
    function _getLiquidationThreshold(
        LiquidationBase.BaseStorage storage baseStorage
    ) internal pure returns (uint256 threshold) {
        baseStorage; // silence unused
        // Simplified version, uses default liquidation threshold
        threshold = 1e18; // Default 100%
    }
    
    /**
     * @notice Calculate preview health factor
     * @param targetUserAddr User address
     * @param collateralAmount Amount of collateral to liquidate
     * @param debtAmount Amount of debt to liquidate
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return newHealthFactor New health factor after liquidation
     */
    function _calculatePreviewHealthFactor(
        address targetUserAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 newHealthFactor) {
        (uint256 currentCollateralValue, uint256 currentDebtValue) = _getUserValues(targetUserAddr, baseStorage, moduleCache);
        
        // Calculate new values
        uint256 newCollateralValue = currentCollateralValue > collateralAmount ? currentCollateralValue - collateralAmount : 0;
        uint256 newDebtValue = currentDebtValue > debtAmount ? currentDebtValue - debtAmount : 0;
        
        // Calculate new health factor
        uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
        newHealthFactor = calculateHealthFactor(newCollateralValue, newDebtValue, liquidationThreshold);
    }
    
    /**
     * @notice Calculate preview risk score
     * @param targetUserAddr User address
     * @param collateralAmount Amount of collateral to liquidate
     * @param debtAmount Amount of debt to liquidate
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return newRiskScore New risk score after liquidation
     */
    function _calculatePreviewRiskScore(
        address targetUserAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 newRiskScore) {
        (uint256 currentCollateralValue, uint256 currentDebtValue) = _getUserValues(targetUserAddr, baseStorage, moduleCache);
        
        // Calculate new values
        uint256 newCollateralValue = currentCollateralValue > collateralAmount ? currentCollateralValue - collateralAmount : 0;
        uint256 newDebtValue = currentDebtValue > debtAmount ? currentDebtValue - debtAmount : 0;
        
        // Calculate new risk score
        uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
        uint256 newHealthFactor = calculateHealthFactor(newCollateralValue, newDebtValue, liquidationThreshold);
        newRiskScore = calculateRiskScore(newHealthFactor, 1e18); // Simplified version, uses default value
    }
    
    /**
     * @notice Calculate Flash Loan impact (no oracle access)
     * @param collateralAssetAddr Collateral asset address
     * @param debtAssetAddr Debt asset address
     * @param collateralAmount Amount of collateral
     * @param debtAmount Amount of debt
     * @param baseStorage Base storage structure
     * @return impact Flash Loan impact
     */
    function _calculateFlashLoanImpact(
        address collateralAssetAddr,
        address debtAssetAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        LiquidationBase.BaseStorage storage baseStorage
    ) internal pure returns (uint256 impact) {
        // NOTE:
        // - Architecture requires oracle access + graceful degradation to be centralized in LendingEngine.
        // - This library intentionally avoids any oracle access, so slippage here is an amount-based approximation.
        // - Upstream callers that need value-accurate impact should compute values in LE and pass them in via
        //   a dedicated function (not provided here to avoid duplicating valuation logic).
        baseStorage; // silence unused
        collateralAssetAddr;
        debtAssetAddr;
        uint256 marketImpactBps = _calculateMarketImpactBps(collateralAmount, debtAmount);
        uint256 totalAmount = collateralAmount + debtAmount;
        impact = (totalAmount * marketImpactBps) / 10000;
    }
    
    /**
     * @notice Calculate market impact
     * @param collateralAmount Amount of collateral
     * @param debtAmount Amount of debt
     * @return impact Market impact (in basis points)
     */
    function _calculateMarketImpactBps(
        uint256 collateralAmount,
        uint256 debtAmount
    ) internal pure returns (uint256 impact) {
        // Simplified: constant baseline impact (50 bps = 0.5%).
        if (collateralAmount + debtAmount == 0) return 0;
        return 50;
    }

    /* ============ Calculation Functions ============ */
    
    /**
     * @notice Calculate health factor
     * @param totalCollateralValueInput Total collateral value
     * @param totalDebtValueInput Total debt value
     * @param liquidationThresholdValue Liquidation threshold
     * @return healthFactor Health factor
     */
    function calculateHealthFactor(
        uint256 totalCollateralValueInput,
        uint256 totalDebtValueInput,
        uint256 liquidationThresholdValue
    ) internal pure returns (uint256 healthFactor) {
        if (totalDebtValueInput == 0) {
            return 1e20; // MAX_HEALTH_FACTOR
        }
        
        // Health factor = (Total collateral value * liquidation threshold) / Total debt value
        healthFactor = (totalCollateralValueInput * liquidationThresholdValue) / totalDebtValueInput;
        
        // Limit to valid range
        if (healthFactor > 1e20) {
            healthFactor = 1e20;
        } else if (healthFactor < 1e15) {
            healthFactor = 1e15;
        }
    }

    /**
     * @notice Calculate risk score
     * @param healthFactor Health factor
     * @param collateralDiversity Collateral diversity
     * @return riskScore Risk score
     */
    function calculateRiskScore(
        uint256 healthFactor,
        uint256 collateralDiversity
    ) internal pure returns (uint256 riskScore) {
        // Calculate base risk score based on health factor
        if (healthFactor >= 1e20) {
            riskScore = 0; // MIN_RISK_SCORE
        } else if (healthFactor <= 1e15) {
            riskScore = 1000; // MAX_RISK_SCORE
        } else {
            // Linear interpolation to calculate risk score
            riskScore = 1000 - ((healthFactor - 1e15) * 1000) / (1e20 - 1e15);
        }
        
        // Adjust risk score based on collateral diversity
        if (collateralDiversity > 3) {
            riskScore = riskScore * 80 / 100; // Good diversity, reduce risk by 20%
        } else if (collateralDiversity == 1) {
            riskScore = riskScore * 120 / 100; // Single collateral, increase risk by 20%
        }
        
        // Limit to valid range
        if (riskScore > 1000) {
            riskScore = 1000;
        } else if (riskScore < 0) {
            riskScore = 0;
        }
    }

    /**
     * @notice Get user risk score
     * @param targetUserAddr User address
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return riskScore Risk score
     */
    function getUserRiskScore(
        address targetUserAddr,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 riskScore) {
        // Get user health factor - directly call internal function
        (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValues(targetUserAddr, baseStorage, moduleCache);
        uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
        uint256 healthFactor = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
        
        // Get collateral diversity
        uint256 collateralDiversity = _getCollateralDiversity(targetUserAddr, moduleCache);
        
        // Calculate risk score
        riskScore = calculateRiskScore(healthFactor, collateralDiversity);
    }

    /**
     * @notice Get liquidation risk score
     * @param targetUserAddr User address
     * @param moduleCache Module cache storage
     * @return riskScore Risk score
     */
    function getLiquidationRiskScore(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 riskScore) {
        // Get user health factor - simplified version
        (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValuesSimple(targetUserAddr, moduleCache);
        uint256 liquidationThreshold = 1e18; // Default 100%
        uint256 healthFactor = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
        
        // Get collateral diversity
        uint256 collateralDiversity = _getCollateralDiversity(targetUserAddr, moduleCache);
        
        // Calculate risk score
        riskScore = calculateRiskScore(healthFactor, collateralDiversity);
    }

    /**
     * @notice Get cached health factor
     * @param user User address
     * @param cache Health factor cache mapping
     * @return healthFactor Cached health factor (0 if not cached)
     */
    function getCachedHealthFactor(
        address user,
        mapping(address => uint256) storage cache
    ) internal view returns (uint256 healthFactor) {
        healthFactor = cache[user];
        if (healthFactor == 0) {
            return 0;
        }
        return healthFactor;
    }

    /**
     * @notice Get collateral diversity
     * @param targetUserAddr User address
     * @param moduleCache Module cache storage
     * @return diversity Collateral diversity
     */
    function _getCollateralDiversity(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal pure returns (uint256 diversity) {
        targetUserAddr;
        moduleCache;
        // Simplified version, return default value
        return 1e18; // Default diversity value
    }

    /* ============ Bonus Calculation Functions ============ */
    
    /**
     * @notice Calculate liquidation bonus
     * @param seizedAmount Amount of seized collateral
     * @param reducedAmount Amount of reduced debt (unused in this implementation)
     * @param bonusRate Bonus rate (in standard precision, 1e18 = 100%)
     * @return bonus Liquidation bonus amount
     */
    function calculateLiquidationBonus(
        uint256 seizedAmount,
        uint256 reducedAmount,
        uint256 bonusRate
    ) internal pure returns (uint256 bonus) {
        reducedAmount; // unused in this implementation
        // Calculate bonus: seized amount * bonus rate
        bonus = (seizedAmount * bonusRate) / 1e18; // Use standard precision
    }

    /**
     * @notice Calculate liquidation bonus from config storage
     * @param seizedAmount Amount of seized collateral
     * @param reducedAmount Amount of reduced debt
     * @param liquidationConfigStorage Liquidation configuration storage mapping
     * @return bonus Liquidation bonus amount
     */
    function calculateLiquidationBonus(
        uint256 seizedAmount,
        uint256 reducedAmount,
        mapping(bytes32 => uint256) storage liquidationConfigStorage
    ) internal view returns (uint256 bonus) {
        uint256 bonusRate = liquidationConfigStorage[keccak256("LIQUIDATION_BONUS_RATE")];
        bonus = calculateLiquidationBonus(seizedAmount, reducedAmount, bonusRate);
    }

    /* ============ Batch Query Functions ============ */
    
    /**
     * @notice Batch get reducible amounts
     * @param userAddresses Array of user addresses
     * @param assetAddresses Array of asset addresses
     * @param lendingEngine Lending engine address
     * @return reducibleAmounts Array of reducible debt amounts
     */
    function batchGetReducibleAmounts(
        address[] calldata userAddresses,
        address[] calldata assetAddresses,
        address lendingEngine
    ) internal view returns (uint256[] memory reducibleAmounts) {
        uint256 length = userAddresses.length;
        reducibleAmounts = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            if (lendingEngine != address(0)) {
                try ILendingEngineBasic(lendingEngine).getReducibleDebtAmount(userAddresses[i], assetAddresses[i]) returns (uint256 amount) {
                    reducibleAmounts[i] = amount;
                } catch {
                    reducibleAmounts[i] = 0;
                }
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch calculate debt values
     * @param userAddresses Array of user addresses
     * @param assetAddresses Array of asset addresses
     * @param lendingEngine Lending engine address
     * @return debtValues Array of debt values
     */
    function batchCalculateDebtValues(
        address[] calldata userAddresses,
        address[] calldata assetAddresses,
        address lendingEngine
    ) internal view returns (uint256[] memory debtValues) {
        uint256 length = userAddresses.length;
        debtValues = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            if (lendingEngine != address(0)) {
                try ILendingEngineBasic(lendingEngine).calculateDebtValue(userAddresses[i], assetAddresses[i]) returns (uint256 value) {
                    debtValues[i] = value;
                } catch {
                    debtValues[i] = 0;
                }
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch get user health factors
     * @param userAddresses Array of user addresses
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return healthFactors Array of health factors
     */
    function batchGetUserHealthFactors(
        address[] calldata userAddresses,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory healthFactors) {
        uint256 length = userAddresses.length;
        healthFactors = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            // Directly call internal calculation function, avoid cache parameter
            (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValues(userAddresses[i], baseStorage, moduleCache);
            uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
            healthFactors[i] = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch get user risk scores
     * @param userAddresses Array of user addresses
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return riskScores Array of risk scores
     */
    function batchGetUserRiskScores(
        address[] calldata userAddresses,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory riskScores) {
        uint256 length = userAddresses.length;
        riskScores = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            riskScores[i] = getUserRiskScore(userAddresses[i], baseStorage, moduleCache);
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch preview liquidation effects
     * @param targetUsers Array of user addresses
     * @param collateralAssets Array of collateral asset addresses
     * @param debtAssets Array of debt asset addresses
     * @param collateralAmounts Array of collateral amounts to liquidate
     * @param debtAmounts Array of debt amounts to liquidate
     * @param simulateFlashLoan Array of flags indicating whether to simulate Flash Loan impact
     * @param baseStorage Base storage structure
     * @param moduleCache Module cache storage
     * @return bonuses Array of liquidation bonuses
     * @return newHealthFactors Array of new health factors after liquidation
     * @return newRiskScores Array of new risk scores after liquidation
     * @return slippageImpacts Array of Flash Loan impacts
     */
    function batchPreviewLiquidation(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        bool[] calldata simulateFlashLoan,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (
        uint256[] memory bonuses,
        uint256[] memory newHealthFactors,
        uint256[] memory newRiskScores,
        uint256[] memory slippageImpacts
    ) {
        uint256 length = targetUsers.length;
        bonuses = new uint256[](length);
        newHealthFactors = new uint256[](length);
        newRiskScores = new uint256[](length);
        slippageImpacts = new uint256[](length);

        for (uint256 i = 0; i < length;) {
            (
                bonuses[i],
                newHealthFactors[i],
                newRiskScores[i],
                slippageImpacts[i]
            ) = previewLiquidation(
                targetUsers[i],
                collateralAssets[i],
                debtAssets[i],
                collateralAmounts[i],
                debtAmounts[i],
                simulateFlashLoan[i],
                baseStorage,
                moduleCache
            );
            unchecked { ++i; }
        }
    }

    /* ============ Collateral Batch Query Functions ============ */
    
    /**
     * @notice Batch get seizable collateral amounts
     * @dev Reverts if:
     *      - targetUsers.length != targetAssets.length
     *      - targetUsers.length > MAX_BATCH_OPERATIONS
     *
     * @param targetUsers Array of user addresses
     * @param targetAssets Array of asset addresses
     * @param moduleCache Module cache storage
     * @return seizableAmounts Array of seizable collateral amounts
     */
    function batchGetSeizableAmounts(
        address[] calldata targetUsers,
        address[] calldata targetAssets,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory seizableAmounts) {
        if (targetUsers.length != targetAssets.length) revert LiquidationViewLibrary__ArrayLengthMismatch(targetUsers.length, targetAssets.length);
        if (targetUsers.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(targetUsers.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = targetUsers.length;
        seizableAmounts = new uint256[](length);
        
        // Get module address using ModuleCache specification
        address collateralManagerAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManagerAddr == address(0)) {
            return seizableAmounts;
        }
        for (uint256 i = 0; i < length;) {
            if (targetUsers[i] != address(0) && targetAssets[i] != address(0)) {
                try ICollateralManager(collateralManagerAddr).getCollateral(targetUsers[i], targetAssets[i]) returns (uint256 amount) {
                    seizableAmounts[i] = amount;
                } catch {
                    seizableAmounts[i] = 0;
                }
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch calculate collateral values
     * @dev Reverts if:
     *      - targetAssets.length != targetAmounts.length
     *      - targetAssets.length > MAX_BATCH_OPERATIONS
     *
     * @param targetAssets Array of asset addresses
     * @param targetAmounts Array of asset amounts
     * @param moduleCache Module cache storage
     * @return values Array of collateral values
     */
    function batchCalculateCollateralValues(
        address[] calldata targetAssets,
        uint256[] calldata targetAmounts,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory values) {
        if (targetAssets.length != targetAmounts.length) revert LiquidationViewLibrary__ArrayLengthMismatch(targetAssets.length, targetAmounts.length);
        if (targetAssets.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(targetAssets.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = targetAssets.length;
        values = new uint256[](length);
        
        // Get module address using ModuleCache specification
        address collateralManagerAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManagerAddr == address(0)) {
            return values;
        }
        for (uint256 i = 0; i < length;) {
            if (targetAssets[i] != address(0)) {
                try ICollateralManager(collateralManagerAddr).getAssetValue(targetAssets[i], targetAmounts[i]) returns (uint256 value) {
                    values[i] = value;
                } catch {
                    values[i] = 0;
                }
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch get user total collateral values
     * @dev Reverts if:
     *      - targetUsers.length > MAX_BATCH_OPERATIONS
     *
     * @param targetUsers Array of user addresses
     * @param moduleCache Module cache storage
     * @return totalValues Array of total collateral values
     */
    function batchGetUserTotalCollateralValues(
        address[] calldata targetUsers,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory totalValues) {
        if (targetUsers.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(targetUsers.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = targetUsers.length;
        totalValues = new uint256[](length);
        
        // Get module address using ModuleCache specification
        address collateralManagerAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManagerAddr == address(0)) {
            return totalValues;
        }
        for (uint256 i = 0; i < length;) {
            if (targetUsers[i] != address(0)) {
                try ICollateralManager(collateralManagerAddr).getUserTotalCollateralValue(targetUsers[i]) returns (uint256 value) {
                    totalValues[i] = value;
                } catch {
                    totalValues[i] = 0;
                }
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch preview liquidation collateral states
     * @dev Reverts if:
     *      - Array lengths do not match
     *      - targetUsers.length > MAX_BATCH_OPERATIONS
     *
     * @param targetUsers Array of user addresses
     * @param targetAssets Array of asset addresses
     * @param seizeAmounts Array of seize amounts
     * @param moduleCache Module cache storage
     * @return newCollateralAmounts Array of new collateral amounts after liquidation
     * @return newTotalValues Array of new total collateral values after liquidation
     */
    function batchPreviewLiquidationCollateralStates(
        address[] calldata targetUsers,
        address[] calldata targetAssets,
        uint256[] calldata seizeAmounts,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (
        uint256[] memory newCollateralAmounts,
        uint256[] memory newTotalValues
    ) {
        if (targetUsers.length != targetAssets.length || targetUsers.length != seizeAmounts.length) {
            revert LiquidationViewLibrary__ArrayLengthMismatch(targetUsers.length, targetAssets.length);
        }
        if (targetUsers.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(targetUsers.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = targetUsers.length;
        newCollateralAmounts = new uint256[](length);
        newTotalValues = new uint256[](length);
        
        // Get module address using ModuleCache specification
        address collateralManagerAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManagerAddr == address(0)) {
            return (newCollateralAmounts, newTotalValues);
        }
        for (uint256 i = 0; i < length;) {
            if (targetUsers[i] != address(0) && targetAssets[i] != address(0)) {
                // Preview: optimistic arithmetic assuming full seize, using current ledger values.
                try ICollateralManager(collateralManagerAddr).getCollateral(targetUsers[i], targetAssets[i]) returns (uint256 curr) {
                    uint256 newAmt = curr > seizeAmounts[i] ? curr - seizeAmounts[i] : 0;
                    newCollateralAmounts[i] = newAmt;
                } catch {
                    newCollateralAmounts[i] = 0;
                }
                try ICollateralManager(collateralManagerAddr).getUserTotalCollateralValue(targetUsers[i]) returns (uint256 totalVal) {
                    newTotalValues[i] = totalVal;
                } catch {
                    newTotalValues[i] = 0;
                }
            }
            unchecked { ++i; }
        }
    }

    /* ============ Debt Record Batch Query Functions ============ */
    
    /**
     * @notice Batch get liquidation debt records (deprecated, returns zeros)
     * @dev Reverts if:
     *      - users.length != assets.length
     *      - users.length > MAX_BATCH_OPERATIONS
     *
     * @param users Array of user addresses
     * @param assets Array of asset addresses
     * @param moduleCache Module cache storage
     * @return reducedAmounts Array of reduced debt amounts (all zeros, deprecated)
     * @return lastReducedTimes Array of last reduction timestamps (all zeros, deprecated)
     */
    function batchGetLiquidationDebtRecords(
        address[] calldata users,
        address[] calldata assets,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal pure returns (
        uint256[] memory reducedAmounts,
        uint256[] memory lastReducedTimes
    ) {
        moduleCache; // deprecated path; keep signature for compatibility
        if (users.length != assets.length) revert LiquidationViewLibrary__ArrayLengthMismatch(users.length, assets.length);
        if (users.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(users.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = users.length;
        reducedAmounts = new uint256[](length);
        lastReducedTimes = new uint256[](length);
        
        // Debt records are no longer stored on-chain per Architecture-Guide; return zeroed arrays.
    }

    /* ============ Risk Management Batch Query Functions ============ */
    
    /**
     * @notice Batch get liquidation risk scores
     * @dev Reverts if:
     *      - users.length > MAX_BATCH_OPERATIONS
     *
     * @param users Array of user addresses
     * @param moduleCache Module cache storage
     * @return riskScores Array of risk scores
     */
    function batchGetLiquidationRiskScores(
        address[] calldata users,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory riskScores) {
        if (users.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(users.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = users.length;
        riskScores = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            riskScores[i] = getLiquidationRiskScore(users[i], moduleCache);
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch get user health factors (simplified version)
     * @dev Reverts if:
     *      - users.length > MAX_BATCH_OPERATIONS
     *
     * @param users Array of user addresses
     * @param moduleCache Module cache storage
     * @return healthFactors Array of health factors
     */
    function batchGetUserHealthFactorsSimple(
        address[] calldata users,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory healthFactors) {
        if (users.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(users.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = users.length;
        healthFactors = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValuesSimple(users[i], moduleCache);
            uint256 liquidationThreshold = 1e18; // Default 100%
            healthFactors[i] = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
            unchecked { ++i; }
        }
    }

    /* ============ Advanced Query Functions ============ */
    
    /**
     * @notice Calculate optimal liquidation combination (placeholder, ledger-side interface removed)
     * @param targetUser User address (unused)
     * @param maxDebtReduction Maximum debt reduction (unused)
     * @param maxCollateralReduction Maximum collateral reduction (unused)
     * @param lendingEngine Lending engine address (unused)
     * @return optimalDebtReduction Optimal debt reduction (always 0, deprecated)
     * @return optimalCollateralReduction Optimal collateral reduction (always 0, deprecated)
     * @return healthFactor Health factor (always 0, deprecated)
     */
    function calculateOptimalLiquidationCombination(
        address targetUser,
        uint256 maxDebtReduction,
        uint256 maxCollateralReduction,
        address lendingEngine
    ) internal pure returns (
        uint256 optimalDebtReduction,
        uint256 optimalCollateralReduction,
        uint256 healthFactor
    ) {
        targetUser;
        maxDebtReduction;
        maxCollateralReduction;
        lendingEngine;
        optimalDebtReduction = 0;
        optimalCollateralReduction = 0;
        healthFactor = 0;
    }

    /**
     * @notice Preview liquidation debt state (placeholder, ledger-side interface removed)
     * @param targetUser User address (unused)
     * @param debtReduction Debt reduction amount (unused)
     * @param collateralReduction Collateral reduction amount (unused)
     * @param lendingEngine Lending engine address (unused)
     * @return newHealthFactor New health factor (always 0, deprecated)
     * @return newRiskScore New risk score (always 0, deprecated)
     * @return newRiskLevel New risk level (always 0, deprecated)
     */
    function previewLiquidationDebtState(
        address targetUser,
        uint256 debtReduction,
        uint256 collateralReduction,
        address lendingEngine
    ) internal pure returns (
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 newRiskLevel
    ) {
        targetUser;
        debtReduction;
        collateralReduction;
        lendingEngine;
        newHealthFactor = 0;
        newRiskScore = 0;
        newRiskLevel = 0;
    }

    /**
     * @notice Get high risk user list (placeholder, ledger-side interface removed)
     * @param riskThreshold Risk threshold (unused)
     * @param limit Maximum number of users to return (unused)
     * @param lendingEngine Lending engine address (unused)
     * @return users Array of user addresses (always empty, deprecated)
     * @return riskScores Array of risk scores (always empty, deprecated)
     */
    function getHighRiskUserList(
        uint256 riskThreshold,
        uint256 limit,
        address lendingEngine
    ) internal pure returns (
        address[] memory users,
        uint256[] memory riskScores
    ) {
        riskThreshold;
        limit;
        lendingEngine;
        users = new address[](0);
        riskScores = new uint256[](0);
    }

    /**
     * @notice Get liquidatable user list (placeholder, ledger-side interface removed)
     * @param healthFactorThreshold Health factor threshold (unused)
     * @param limit Maximum number of users to return (unused)
     * @param lendingEngine Lending engine address (unused)
     * @return users Array of user addresses (always empty, deprecated)
     * @return healthFactors Array of health factors (always empty, deprecated)
     */
    function getLiquidatableUserList(
        uint256 healthFactorThreshold,
        uint256 limit,
        address lendingEngine
    ) internal pure returns (
        address[] memory users,
        uint256[] memory healthFactors
    ) {
        healthFactorThreshold;
        limit;
        lendingEngine;
        users = new address[](0);
        healthFactors = new uint256[](0);
    }

    /**
     * @notice Calculate optimal liquidation path (placeholder, ledger-side interface removed)
     * @param targetUser User address (unused)
     * @param targetHealthFactor Target health factor (unused)
     * @param lendingEngine Lending engine address (unused)
     * @return liquidationSteps Array of liquidation steps (always empty, deprecated)
     * @return totalDebtReduction Total debt reduction (always 0, deprecated)
     * @return totalCollateralReduction Total collateral reduction (always 0, deprecated)
     */
    function calculateOptimalLiquidationPath(
        address targetUser,
        uint256 targetHealthFactor,
        address lendingEngine
    ) internal pure returns (
        address[] memory liquidationSteps,
        uint256 totalDebtReduction,
        uint256 totalCollateralReduction
    ) {
        targetUser;
        targetHealthFactor;
        lendingEngine;
        liquidationSteps = new address[](0);
        totalDebtReduction = 0;
        totalCollateralReduction = 0;
    }

    /**
     * @notice Batch optimize liquidation strategies (placeholder, ledger-side interface removed)
     * @param userAddresses Array of user addresses
     * @param targetHealthFactors Array of target health factors (unused)
     * @param lendingEngine Lending engine address (unused)
     * @return strategies Array of strategies (always empty, deprecated)
     */
    function batchOptimizeLiquidationStrategies(
        address[] calldata userAddresses,
        uint256[] calldata targetHealthFactors,
        address lendingEngine
    ) internal pure returns (bytes[] memory strategies) {
        targetHealthFactors;
        lendingEngine;
        uint256 length = userAddresses.length;
        strategies = new bytes[](length);
        for (uint256 i = 0; i < length;) {
            strategies[i] = "";
            unchecked { ++i; }
        }
    }

    // NOTE: Any oracle access + graceful degradation belongs to LendingEngine valuation.
    // This library intentionally stops here to avoid duplicating valuation logic and creating SSOT drift.
} 