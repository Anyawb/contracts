// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";

/// @title MockLendingEngineBasic
/// @notice 借贷引擎的Mock实现，用于测试
contract MockLendingEngineBasic is ILendingEngineBasic {
    // 用户债务映射
    mapping(address => mapping(address => uint256)) private _userDebt;
    mapping(address => uint256) private _totalByAsset;
    mapping(address => uint256) private _userTotalValue;
    uint256 private _totalValue;
    mapping(address => address[]) private _userDebtAssets;
    mapping(address => mapping(address => uint256)) private _userDebtAssetIndexPlusOne;
    
    // 测试控制标志
    bool public mockSuccess = true;
    
    // 事件
    event BorrowRecorded(address indexed user, address indexed asset, uint256 amount);
    event RepayRecorded(address indexed user, address indexed asset, uint256 amount);
    
    /// @notice 记录借款
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 借款金额
    /// @param collateralAdded 抵押物增加量
    /// @param termDays 借款期限
    function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external override {
        if (!mockSuccess) revert("MockLendingEngine: borrow failed");
        // 注意：collateralAdded和termDays参数在此Mock实现中未使用，但保留以符合接口规范
        collateralAdded; termDays;
        if (_userDebt[user][asset] == 0) {
            _addDebtAsset(user, asset);
        }
        _userDebt[user][asset] += amount;
        _totalByAsset[asset] += amount;
        _userTotalValue[user] += amount;
        _totalValue += amount;
        emit BorrowRecorded(user, asset, amount);
    }
    
    /// @notice 记录还款
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 还款金额
    function repay(address user, address asset, uint256 amount) external override {
        if (!mockSuccess) revert("MockLendingEngine: repay failed");
        require(_userDebt[user][asset] >= amount, "Insufficient debt");
        _userDebt[user][asset] -= amount;
        if (_userDebt[user][asset] == 0) {
            _removeDebtAsset(user, asset);
        }
        _totalByAsset[asset] = _totalByAsset[asset] >= amount ? _totalByAsset[asset] - amount : 0;
        _userTotalValue[user] = _userTotalValue[user] > amount ? _userTotalValue[user] - amount : 0;
        _totalValue = _totalValue > amount ? _totalValue - amount : 0;
        emit RepayRecorded(user, asset, amount);
    }
    
    /// @notice 强制减少债务
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 减少金额
    function forceReduceDebt(address user, address asset, uint256 amount) external override {
        uint256 currentDebt = _userDebt[user][asset];
        // For liquidation, insufficient debt should revert (matches typical engine behavior and helps test atomicity)
        require(currentDebt >= amount, "Insufficient debt");
        _userDebt[user][asset] = currentDebt - amount;
        if (_userDebt[user][asset] == 0) {
            _removeDebtAsset(user, asset);
        }
        _totalByAsset[asset] -= amount;
        _userTotalValue[user] = _userTotalValue[user] > amount ? _userTotalValue[user] - amount : 0;
        _totalValue = _totalValue > amount ? _totalValue - amount : 0;
        emit RepayRecorded(user, asset, amount);
    }
    
    /// @notice 获取债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 债务数量
    function getDebt(address user, address asset) external view override returns (uint256) {
        if (!mockSuccess) revert("MLE: get debt fail");
        return _userDebt[user][asset];
    }
    
    /// @notice 获取资产总债务数量
    /// @param asset 资产地址
    /// @return 总债务数量
    function getTotalDebtByAsset(address asset) external view override returns (uint256) {
        return _totalByAsset[asset];
    }
    
    /// @notice 测试辅助：直接设置资产总债务
    function setTotalDebtByAsset(address asset, uint256 amount) external {
        _totalByAsset[asset] = amount;
    }
    
    /// @notice 获取用户总债务价值
    /// @param user 用户地址
    /// @return 总债务价值
    function getUserTotalDebtValue(address user) external view override returns (uint256) {
        return _userTotalValue[user];
    }

    function getUserTotalDebtValueBestEffort(address user) external view override returns (uint256) {
        return _userTotalValue[user];
    }

    function getUserTotalDebtValueStrict(address user) external view override returns (uint256) {
        return _userTotalValue[user];
    }
    
    /// @notice 获取总债务价值
    /// @return 总债务价值
    function getTotalDebtValue() external view override returns (uint256) {
        return _totalValue;
    }
    
    /// @notice 获取用户债务资产列表
    /// @param user 用户地址
    /// @return 资产地址数组
    function getUserDebtAssets(address user) external view override returns (address[] memory) {
        address[] memory assets = _userDebtAssets[user];
        return assets;
    }
    
    /// @notice 计算预期利息
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 金额
    /// @return 预期利息
    function calculateExpectedInterest(address user, address asset, uint256 amount) external pure override returns (uint256) {
        // Mock实现：返回0
        // 注意：user、asset、amount参数在此Mock实现中未使用，但保留以符合接口规范
        user; asset; amount;
        return 0;
    }
    
    /// @notice 获取可减少债务金额
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 可减少金额
    function getReducibleDebtAmount(address user, address asset) external view override returns (uint256) {
        return _userDebt[user][asset];
    }
    
    /// @notice 计算债务价值
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 债务价值
    function calculateDebtValue(address user, address asset) external view virtual override returns (uint256) {
        return _userDebt[user][asset];
    }

    function calculateDebtValueBestEffort(address user, address asset) external view virtual override returns (uint256) {
        return _userDebt[user][asset];
    }

    function calculateDebtValueStrict(address user, address asset) external view virtual override returns (uint256) {
        return _userDebt[user][asset];
    }
    
    /// @notice 获取用户债务数量（兼容性方法）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 债务数量
    function getUserDebt(address user, address asset) external view returns (uint256) {
        return _userDebt[user][asset];
    }
    
    /// @notice 检查用户是否有债务
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return 是否有债务
    function hasDebt(address user, address asset) external view returns (bool) {
        return _userDebt[user][asset] > 0;
    }
    
    /// @notice 设置用户债务数量（用于测试）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 债务数量
    function setUserDebt(address user, address asset, uint256 amount) external {
        // Keep derived totals consistent with _userDebt, since production paths
        // rely on getUserTotalDebtValue() for collateral release decisions.
        uint256 prev = _userDebt[user][asset];
        if (prev == 0 && amount > 0) {
            _addDebtAsset(user, asset);
        } else if (prev > 0 && amount == 0) {
            _removeDebtAsset(user, asset);
        }
        _userDebt[user][asset] = amount;

        if (amount >= prev) {
            uint256 delta = amount - prev;
            _totalByAsset[asset] += delta;
            _userTotalValue[user] += delta;
            _totalValue += delta;
        } else {
            uint256 delta = prev - amount;
            _totalByAsset[asset] = _totalByAsset[asset] >= delta ? _totalByAsset[asset] - delta : 0;
            _userTotalValue[user] = _userTotalValue[user] >= delta ? _userTotalValue[user] - delta : 0;
            _totalValue = _totalValue >= delta ? _totalValue - delta : 0;
        }
    }

    /// @notice 设置用户总债务价值缓存（用于测试估值缓存陈旧场景）
    function setUserTotalDebtValue(address user, uint256 amount) external {
        uint256 prev = _userTotalValue[user];
        _userTotalValue[user] = amount;
        if (amount >= prev) {
            _totalValue += (amount - prev);
        } else {
            _totalValue -= (prev - amount);
        }
    }

    /// @notice 强制减少债务（清算时使用）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 减少金额
    /// @param liquidator 清算人地址
    /// @return reducedAmount 实际减少金额
    function forceReduceDebtWithLiquidator(address user, address asset, uint256 amount, address liquidator) external returns (uint256 reducedAmount) {
        require(user != address(0), "Invalid user address");
        require(asset != address(0), "Invalid asset address");
        require(amount > 0, "Invalid amount");
        require(liquidator != address(0), "Invalid liquidator address");
        
        uint256 currentDebt = _userDebt[user][asset];
        reducedAmount = amount > currentDebt ? currentDebt : amount;
        
        if (reducedAmount > 0) {
            _userDebt[user][asset] -= reducedAmount;
            _totalByAsset[asset] -= reducedAmount;
            _userTotalValue[user] = _userTotalValue[user] > reducedAmount ? _userTotalValue[user] - reducedAmount : 0;
            _totalValue = _totalValue > reducedAmount ? _totalValue - reducedAmount : 0;
            
            // 发出债务减少事件
            emit DebtReduced(liquidator, user, asset, reducedAmount, block.number);
        }
        
        return reducedAmount;
    }

    // 事件
    event DebtReduced(
        address indexed liquidator,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /// @notice 设置成功标志（测试用）
    /// @param success 是否成功
    function setMockSuccess(bool success) external {
        mockSuccess = success;
    }

    function _addDebtAsset(address user, address asset) internal {
        if (_userDebtAssetIndexPlusOne[user][asset] != 0) {
            return;
        }
        _userDebtAssets[user].push(asset);
        _userDebtAssetIndexPlusOne[user][asset] = _userDebtAssets[user].length;
    }

    function _removeDebtAsset(address user, address asset) internal {
        uint256 indexPlusOne = _userDebtAssetIndexPlusOne[user][asset];
        if (indexPlusOne == 0) {
            return;
        }
        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _userDebtAssets[user].length - 1;
        if (index != lastIndex) {
            address lastAsset = _userDebtAssets[user][lastIndex];
            _userDebtAssets[user][index] = lastAsset;
            _userDebtAssetIndexPlusOne[user][lastAsset] = index + 1;
        }
        _userDebtAssets[user].pop();
        delete _userDebtAssetIndexPlusOne[user][asset];
    }
}