// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardSlimUpgradeable } from "../utils/ReentrancyGuardSlimUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title RewardPoints (Upgradeable & Pausable)
/// @notice 平台积分代币，可升级、可暂停、支持 EIP-2612 Permit
/// @dev 这是一个可升级的 ERC20 代币，支持积分铸造、销毁和暂停功能
contract RewardPoints is
    Initializable,
    ERC20PermitUpgradeable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardSlimUpgradeable,
    UUPSUpgradeable
{
    // =================== 角色 & 常量 ===================
    /// @notice 铸造者角色，拥有铸造积分的权限
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // =================== 自定义错误 ===================
    /// @dev 地址无效时抛出的错误
    /// @param addr 无效的地址
    error RewardPoints__InvalidAddress(address addr);
    
    /// @dev 金额为零时抛出的错误
    error RewardPoints__ZeroAmount();

    // =================== 事件 ===================
    /// @notice 积分铸造事件
    /// @param to 接收地址
    /// @param amount 铸造金额
    event PointsMinted(address indexed to, uint256 amount);
    
    /// @notice 积分销毁事件
    /// @param from 销毁地址
    /// @param amount 销毁金额
    event PointsBurned(address indexed from, uint256 amount);
    
    /// @notice 暂停状态变更事件
    /// @param paused 是否暂停
    /// @param timestamp 时间戳
    event PauseStatusChanged(bool paused, uint256 timestamp);

    // =================== 初始化 ===================
    /// @notice 初始化 – 仅可调用一次
    /// @param admin 管理员地址，拥有 DEFAULT_ADMIN_ROLE & MINTER_ROLE
    function initialize(address admin) external initializer {
        if (admin == address(0)) revert RewardPoints__InvalidAddress(admin);

        __ERC20_init("RWA Lending Points", "RLP");
        __ERC20Permit_init("RWA Lending Points");
        __AccessControlEnumerable_init();
        __Pausable_init();
        __ReentrancyGuardSlim_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @dev 禁用实现合约初始化
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // =================== 铸造 & 销毁 ===================
    /// @notice 铸造积分给指定地址
    /// @dev 仅 MINTER_ROLE 可调用，合约未暂停时可用
    /// @param to 接收积分的地址
    /// @param amount 铸造的积分数量
    function mintPoints(address to, uint256 amount) external whenNotPaused onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert RewardPoints__InvalidAddress(to);
        if (amount == 0) revert RewardPoints__ZeroAmount();
        _mint(to, amount);
        emit PointsMinted(to, amount);
    }

    /// @notice 兼容旧版接口（直接铸币，避免外部再次调用）
    /// @dev 仅 MINTER_ROLE 可调用，合约未暂停时可用
    /// @param to 接收积分的地址
    /// @param amount 铸造的积分数量
    function awardPoints(address to, uint256 amount) external whenNotPaused onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert RewardPoints__InvalidAddress(to);
        if (amount == 0) revert RewardPoints__ZeroAmount();
        _mint(to, amount);
        emit PointsMinted(to, amount);
    }

    /// @notice 销毁指定地址的积分
    /// @dev 仅 MINTER_ROLE 可调用，合约未暂停时可用
    /// @param from 销毁积分的地址
    /// @param amount 销毁的积分数量
    function burnPoints(address from, uint256 amount) external whenNotPaused onlyRole(MINTER_ROLE) {
        if (from == address(0)) revert RewardPoints__InvalidAddress(from);
        if (amount == 0) revert RewardPoints__ZeroAmount();
        _burn(from, amount);
        emit PointsBurned(from, amount);
    }

    // =================== Pausable ===================
    /// @notice 暂停合约功能
    /// @dev 仅 DEFAULT_ADMIN_ROLE 可调用
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
        emit PauseStatusChanged(true, block.timestamp);
    }

    /// @notice 恢复合约功能
    /// @dev 仅 DEFAULT_ADMIN_ROLE 可调用
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
        emit PauseStatusChanged(false, block.timestamp);
    }

    // =================== Metadata ===================
    /// @notice 返回代币的小数位数
    /// @return 代币小数位数（18）
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    // =================== Upgrades ===================
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {
        // 升级逻辑由 UUPSUpgradeable 处理
    }

    // =================== Storage Gap ===================
    uint256[45] private __gap;
}
