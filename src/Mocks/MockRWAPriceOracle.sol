// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IRWAPriceOracle } from "../interfaces/IRWAPriceOracle.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";

/// @title MockRWAPriceOracle
/// @notice 简易可写入的价格预言机，用于测试 / 本地开发
/// @dev 实现 IRWAPriceOracle 接口的所有方法
contract MockRWAPriceOracle is Ownable, IRWAPriceOracle {
    uint8 public immutable decimalsVar;
    mapping(address => uint256) private _prices;
    mapping(address => uint256) private _timestamps;
    mapping(address => bool) private _isValid;
    mapping(address => RWAAssetConfig) private _assetConfigs;
    address[] private _supportedAssets;

    constructor(uint8 _decimals) Ownable(msg.sender) {
        decimalsVar = _decimals;
    }

    /// @notice 设置价格（仅测试合约，无权限控制）
    function setPrice(address token, uint256 price) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (price == 0) revert("Invalid price");
        _prices[token] = price;
        _timestamps[token] = block.timestamp;
        _isValid[token] = true;
        emit PriceUpdated(token, price, block.timestamp);
    }

    function getPriceUSD(address token) external view override returns (uint256 price, uint8 _decimals) {
        if (token == address(0)) revert ZeroAddress();
        price = _prices[token];
        _decimals = decimalsVar;
    }

    function getPriceData(address token) external view override returns (RWAPriceData memory priceData) {
        if (token == address(0)) revert ZeroAddress();
        priceData = RWAPriceData({
            price: _prices[token],
            timestamp: _timestamps[token],
            decimals: decimalsVar,
            isValid: _isValid[token],
            assetType: _assetConfigs[token].assetType
        });
    }

    function getPricesUSD(address[] calldata tokens) external view override returns (
        uint256[] memory prices,
        uint8[] memory decimalsArray
    ) {
        uint256 length = tokens.length;
        prices = new uint256[](length);
        decimalsArray = new uint8[](length);
        
        for (uint256 i = 0; i < length; i++) {
            prices[i] = _prices[tokens[i]];
            decimalsArray[i] = decimalsVar;
        }
    }

    function isPriceValid(address token) external view override returns (bool isValid) {
        if (token == address(0)) return false;
        return _isValid[token] && _prices[token] > 0;
    }

    function getAssetConfig(address token) external view override returns (RWAAssetConfig memory config) {
        if (token == address(0)) revert ZeroAddress();
        config = _assetConfigs[token];
    }

    function getSupportedAssets() external view override returns (address[] memory tokens) {
        return _supportedAssets;
    }

    function getAssetCount() external view override returns (uint256 count) {
        return _supportedAssets.length;
    }

    function updatePrice(address token, uint256 price, uint256 timestamp) external override onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (price == 0) revert("Invalid price");
        
        _prices[token] = price;
        _timestamps[token] = timestamp;
        _isValid[token] = true;
        
        emit PriceUpdated(token, price, timestamp);
    }

    function updatePrices(
        address[] calldata tokens,
        uint256[] calldata prices,
        uint256[] calldata timestamps
    ) external override onlyOwner {
        uint256 length = tokens.length;
        if (length != prices.length || length != timestamps.length) revert("Array length mismatch");
        
        for (uint256 i = 0; i < length; i++) {
            address token = tokens[i];
            uint256 price = prices[i];
            uint256 timestamp = timestamps[i];
            
            if (token == address(0)) continue;
            if (price == 0) continue;
            
            _prices[token] = price;
            _timestamps[token] = timestamp;
            _isValid[token] = true;
            
            emit PriceUpdated(token, price, timestamp);
        }
    }

    function configureAsset(
        address token,
        string calldata assetType,
        uint8 _decimals,
        uint256 maxPriceAge,
        string calldata description
    ) external override onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        
        bool isNewAsset = bytes(_assetConfigs[token].assetType).length == 0;
        
        _assetConfigs[token] = RWAAssetConfig({
            assetType: assetType,
            decimals: _decimals,
            isActive: true,
            maxPriceAge: maxPriceAge,
            description: description
        });
        
        if (isNewAsset) {
            _supportedAssets.push(token);
        }
        
        emit RWAAssetConfigUpdated(token, true, maxPriceAge);
    }

    function setAssetActive(address token, bool isActive) external override onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        
        _assetConfigs[token].isActive = isActive;
        
        emit RWAAssetConfigUpdated(token, isActive, _assetConfigs[token].maxPriceAge);
    }

    function updateParameter(string calldata paramName, uint256 newValue) external override onlyOwner {
        // Mock implementation - just emit event
        emit RWAParameterUpdated(paramName, 0, newValue);
    }
} 