// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILiquidationRiskManager } from "../interfaces/ILiquidationRiskManager.sol";

/// @notice Minimal mock for LiquidationRiskManager used in view-layer tests
contract MockLiquidationRiskManager is ILiquidationRiskManager {
    mapping(address => bool) private _liquidatable;
    mapping(address => uint256) private _riskScore;
    mapping(address => uint256) private _healthFactor;
    mapping(address => uint256) private _riskLevel;
    mapping(address => uint256) private _safetyMargin;
    mapping(address => uint256) private _hfTimestamp;
    mapping(address => uint256) private _hfCache;

    uint256 private _liquidationThreshold;
    uint256 private _minHealthFactor;

    // ===== Setter helpers for tests =====
    function setLiquidatable(address user, bool flag) external {
        _liquidatable[user] = flag;
    }

    function setRiskScore(address user, uint256 score) external {
        _riskScore[user] = score;
    }

    function setHealthFactor(address user, uint256 hf) external {
        _healthFactor[user] = hf;
    }

    function setRiskAssessment(
        address user,
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 riskLevel,
        uint256 safetyMargin
    ) external {
        _liquidatable[user] = liquidatable;
        _riskScore[user] = riskScore;
        _healthFactor[user] = healthFactor;
        _riskLevel[user] = riskLevel;
        _safetyMargin[user] = safetyMargin;
    }

    function setHealthFactorCache(address user, uint256 healthFactor, uint256 timestamp) external {
        _hfCache[user] = healthFactor;
        _hfTimestamp[user] = timestamp;
    }

    function setLiquidationThreshold(uint256 threshold) external {
        _liquidationThreshold = threshold;
    }

    function setMinHealthFactor(uint256 minHf) external {
        _minHealthFactor = minHf;
    }

    // ===== Interface implementations =====
    function isLiquidatable(address user) external view override returns (bool liquidatable) {
        return _liquidatable[user];
    }

    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address /* asset */
    ) external view override returns (bool liquidatable) {
        // fallback to map if set, otherwise simple collateral/debt check
        if (_liquidatable[user]) return true;
        if (debt == 0) return false;
        return collateral < debt;
    }

    function getLiquidationRiskScore(address user) external view override returns (uint256 riskScore) {
        return _riskScore[user];
    }

    function calculateLiquidationRiskScore(uint256 collateral, uint256 debt) external pure override returns (uint256 riskScore) {
        if (debt == 0) return 0;
        // simple proportional risk score: higher debt vs collateral -> higher score
        riskScore = collateral >= debt ? 0 : ((debt - collateral) * 100) / debt;
        if (riskScore > 100) riskScore = 100;
    }

    function getUserHealthFactor(address user) external view override returns (uint256 healthFactor) {
        return _healthFactor[user];
    }

    function calculateHealthFactor(uint256 collateral, uint256 debt) external pure override returns (uint256 healthFactor) {
        if (debt == 0) return type(uint256).max;
        return (collateral * 1e4) / debt;
    }

    function getUserRiskAssessment(address user) external view override returns (
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 riskLevel,
        uint256 safetyMargin
    ) {
        liquidatable = _liquidatable[user];
        riskScore = _riskScore[user];
        healthFactor = _healthFactor[user];
        riskLevel = _riskLevel[user];
        safetyMargin = _safetyMargin[user];
    }

    function getLiquidationThreshold() external view override returns (uint256 threshold) {
        return _liquidationThreshold;
    }

    function updateLiquidationThreshold(uint256 newThreshold) external override {
        _liquidationThreshold = newThreshold;
    }

    function getMinHealthFactor() external view override returns (uint256 minHealthFactor) {
        return _minHealthFactor;
    }

    function updateMinHealthFactor(uint256 newMinHealthFactor) external override {
        _minHealthFactor = newMinHealthFactor;
    }

    function updateHealthFactorCache(address user, uint256 healthFactor) external override {
        _hfCache[user] = healthFactor;
        _hfTimestamp[user] = block.timestamp;
    }

    function getHealthFactorCache(address user) external view override returns (uint256 healthFactor, uint256 timestamp) {
        return (_hfCache[user], _hfTimestamp[user]);
    }

    function clearHealthFactorCache(address user) external override {
        delete _hfCache[user];
        delete _hfTimestamp[user];
    }

    function batchUpdateHealthFactorCache(
        address[] calldata users,
        uint256[] calldata healthFactors
    ) external override {
        uint256 len = users.length;
        for (uint256 i; i < len; ++i) {
            _hfCache[users[i]] = healthFactors[i];
            _hfTimestamp[users[i]] = block.timestamp;
        }
    }

    function batchIsLiquidatable(address[] calldata users) external view override returns (bool[] memory liquidatableFlags) {
        uint256 len = users.length;
        liquidatableFlags = new bool[](len);
        for (uint256 i; i < len; ++i) {
            liquidatableFlags[i] = _liquidatable[users[i]];
        }
    }

    function batchGetUserHealthFactors(address[] calldata users) external view override returns (uint256[] memory healthFactors) {
        uint256 len = users.length;
        healthFactors = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            healthFactors[i] = _healthFactor[users[i]];
        }
    }

    function batchGetLiquidationRiskScores(address[] calldata users) external view override returns (uint256[] memory riskScores) {
        uint256 len = users.length;
        riskScores = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            riskScores[i] = _riskScore[users[i]];
        }
    }
}








