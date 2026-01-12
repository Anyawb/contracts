// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";

/// @title MockPriceOracle
/// @notice 简易可写入的价格预言机，用于测试
/// @dev 实现 IPriceOracle 接口的所有方法
contract MockPriceOracle is Ownable, IPriceOracle {
    mapping(address => uint256) private _prices;
    mapping(address => uint256) private _timestamps;
    mapping(address => uint256) private _decimals;
    mapping(address => string) private _coingeckoIds;
    mapping(address => bool) private _isActive;
    mapping(address => uint256) private _maxPriceAge;
    address[] private _supportedAssets;

    bool public shouldFail; // flag to simulate failure path in tests

    error MockFailure();

    constructor() Ownable(msg.sender) {}

    function setShouldFail(bool flag) external {
        shouldFail = flag;
    }

    /// @notice 设置价格（仅测试合约，无权限控制）
    /// @notice 设置价格（含时间戳）
    function setPrice(address token, uint256 price, uint256 timestamp, uint256 decimals) external onlyOwner {
        _setPrice(token, price, timestamp, decimals);
    }

    function _setPrice(address token, uint256 price, uint256 timestamp, uint256 decimals) internal {
        if (shouldFail) revert MockFailure();
        _prices[token] = price;
        _timestamps[token] = timestamp;
        _decimals[token] = decimals;
    }

    function getPrice(address token) external view override returns (uint256 price, uint256 timestamp, uint256 decimals) {
        if (shouldFail) revert MockFailure();
        price = _prices[token];
        timestamp = _timestamps[token];
        decimals = _decimals[token];
    }

    function getPriceData(address token) external view override returns (PriceData memory priceData) {
        if (shouldFail) revert MockFailure();
        priceData = PriceData({
            price: _prices[token],
            timestamp: _timestamps[token],
            decimals: _decimals[token],
            isValid: _prices[token] > 0
        });
    }

    function getPrices(address[] calldata tokens) external view override returns (
        uint256[] memory prices,
        uint256[] memory timestamps,
        uint256[] memory decimalsArray
    ) {
        if (shouldFail) revert MockFailure();
        uint256 length = tokens.length;
        prices = new uint256[](length);
        timestamps = new uint256[](length);
        decimalsArray = new uint256[](length);
        
        for (uint256 i = 0; i < length; i++) {
            prices[i] = _prices[tokens[i]];
            timestamps[i] = _timestamps[tokens[i]];
            decimalsArray[i] = _decimals[tokens[i]];
        }
    }

    function isPriceValid(address token) external view override returns (bool isValid) {
        if (shouldFail) revert MockFailure();
        return _prices[token] > 0;
    }

    function getAssetCoingeckoId(address token) external view override returns (string memory coingeckoId) {
        if (shouldFail) revert MockFailure();
        return _coingeckoIds[token];
    }

    function getAssetConfig(address token) external view override returns (AssetConfig memory config) {
        if (shouldFail) revert MockFailure();
        config = AssetConfig({
            coingeckoId: _coingeckoIds[token],
            decimals: _decimals[token],
            isActive: _isActive[token],
            maxPriceAge: _maxPriceAge[token]
        });
    }

    function getSupportedAssets() external view override returns (address[] memory assets) {
        if (shouldFail) revert MockFailure();
        return _supportedAssets;
    }

    function getAssetCount() external view override returns (uint256 count) {
        if (shouldFail) revert MockFailure();
        return _supportedAssets.length;
    }

    function updatePrice(address asset, uint256 price, uint256 timestamp) external override onlyOwner {
        if (shouldFail) revert MockFailure();
        _prices[asset] = price;
        _timestamps[asset] = timestamp;
    }

    function updatePrices(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata timestamps
    ) external override onlyOwner {
        if (shouldFail) revert MockFailure();
        uint256 length = assets.length;
        for (uint256 i = 0; i < length; i++) {
            _prices[assets[i]] = prices[i];
            _timestamps[assets[i]] = timestamps[i];
        }
    }

    function configureAsset(
        address asset,
        string calldata coingeckoId,
        uint256 decimals,
        uint256 maxPriceAge
    ) external override onlyOwner {
        if (shouldFail) revert MockFailure();
        _coingeckoIds[asset] = coingeckoId;
        _decimals[asset] = decimals;
        _maxPriceAge[asset] = maxPriceAge;
        _isActive[asset] = true;
        
        // 添加到支持资产列表
        bool exists = false;
        for (uint256 i = 0; i < _supportedAssets.length; i++) {
            if (_supportedAssets[i] == asset) {
                exists = true;
                break;
            }
        }
        if (!exists) {
            _supportedAssets.push(asset);
        }
    }

    function setAssetActive(address asset, bool isActive) external override onlyOwner {
        if (shouldFail) revert MockFailure();
        _isActive[asset] = isActive;
    }

    // --- Health check helpers to satisfy legacy callers ---
    function checkPriceOracleHealth(address asset) external view returns (bool isHealthy, string memory details) {
        if (shouldFail) revert MockFailure();
        if (asset == address(0)) return (false, "Zero address");
        if (!_isActive[asset]) return (false, "Asset not supported");
        if (_prices[asset] == 0) return (false, "No price");
        return (true, "Healthy");
    }

    function batchCheckPriceOracleHealth(address[] calldata assets) external view returns (bool[] memory healthStatus) {
        if (shouldFail) revert MockFailure();
        uint256 length = assets.length;
        healthStatus = new bool[](length);
        for (uint256 i = 0; i < length; i++) {
            address a = assets[i];
            healthStatus[i] = (a != address(0) && _isActive[a] && _prices[a] > 0);
        }
    }
}
