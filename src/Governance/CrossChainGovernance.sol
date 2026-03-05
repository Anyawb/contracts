// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IVotes } from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IRegistry } from "../interfaces/IRegistry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ZeroAddress, NotAContract } from "../errors/StandardErrors.sol";

error CrossChainGovernance__InvalidProposal();
error CrossChainGovernance__ProposalNotActive();
error CrossChainGovernance__AlreadyVoted();
error CrossChainGovernance__InvalidChainId();
error CrossChainGovernance__ExecutionFailed();
error CrossChainGovernance__InsufficientVotes();
error CrossChainGovernance__InvalidExecutor();
error CrossChainGovernance__InvalidGovernanceToken(address token);
error CrossChainGovernance__GovernanceTokenOutOfSync(address cached, address expected);
error CrossChainGovernance__ProposalCanceled();
error CrossChainGovernance__GovernanceGateRejected(bytes32 reason);
error CrossChainGovernance__GuardianNotSet();
error CrossChainGovernance__NotGuardian(address caller, address guardian);
error CrossChainGovernance__RegistryNotSet();

interface IGovernanceGateRead {
    function isEligibleToVote(address user, uint256 snapshotBlock, address votesToken)
        external
        view
        returns (bool ok, bytes32 reason);

    function isEligibleToPropose(address user, uint256 snapshotBlock, address votesToken)
        external
        view
        returns (bool ok, bytes32 reason);
}

/// @title CrossChainGovernance - 跨链治理投票系统
/// @notice 支持多链投票、提案管理、跨链执行的治理系统
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
contract CrossChainGovernance is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    
    /// @notice 治理角色
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    /// @notice 执行者角色
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @notice 提案参数默认值（显式 blocks；避免任何链上 days/seconds 换算）
    /// @dev 这些值是默认配置；治理可通过 `updateGovernanceParameters` 覆盖（SSOT：block.number 轴）。
    uint256 private constant _DEFAULT_MIN_PROPOSAL_BLOCKS = 43_200;
    uint256 private constant _DEFAULT_MAX_PROPOSAL_BLOCKS = 1_296_000;
    uint256 private constant _DEFAULT_EXECUTION_DELAY_BLOCKS = 86_400;
    
    /// @notice 提案状态枚举
    enum ProposalState {
        Pending,    // 待投票
        Active,     // 投票中
        Succeeded,  // 投票成功
        Executed,   // 已执行
        Defeated,   // 投票失败
        Expired     // 已过期
    }
    
    /// @notice 投票选项枚举
    enum VoteOption {
        Against,    // 反对
        For,        // 赞成
        Abstain     // 弃权
    }
    
    /// @notice 提案结构
    struct Proposal {
        uint256 proposalId;
        address proposer;
        string description;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 startBlock; // block.number (Time-Dependency-Refactor)
        uint256 endBlock; // block.number (Time-Dependency-Refactor)
        uint256 executionBlock; // block.number (Time-Dependency-Refactor)
        bool executed;
        bool canceled;
        ProposalState state;
        uint256 quorum;
        uint256 chainId;
        bytes[] actions;
        address[] targets;
    }
    
    /// @notice 投票记录结构
    struct Vote {
        VoteOption option;
        uint256 weight;
        uint256 voteBlock; // block.number (Time-Dependency-Refactor)
        bool hasVoted;
    }
    
    /// @notice 跨链投票记录
    struct CrossChainVote {
        uint256 chainId;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 totalWeight;
        bool isVerified;
    }
    
    /// @notice 提案映射
    mapping(uint256 => Proposal) public proposals;
    
    /// @notice 用户投票记录
    mapping(uint256 => mapping(address => Vote)) public votes;
    
    /// @notice 跨链投票记录
    mapping(uint256 => mapping(uint256 => CrossChainVote)) public crossChainVotes;
    
    /// @notice 支持的链ID
    mapping(uint256 => bool) public supportedChains;
    
    /// @notice 提案计数器
    uint256 public proposalCount;

    /// @notice Governance voting token (IVotes).
    /// @dev Scheme B (cached + strong invariant):
    ///      - `governanceToken` is cached for gas efficiency and ABI convenience.
    ///      - ALL security/consensus-relevant paths MUST enforce:
    ///        governanceToken == Registry[KEY_EASY_STAKING]
    ///      - Use `syncGovernanceTokenFromRegistry()` to refresh the cache after Registry updates.
    ///
    /// IMPORTANT (ERC20Votes):
    /// - Users must delegate (usually self-delegate) to activate checkpoints.
    ///   Otherwise `getPastVotes` can return 0 even when balance > 0.
    address public governanceToken;

    /// @notice Registry address (module-address SSOT).
    /// @dev Required. Used as SSOT for:
    ///      - governanceToken: Registry[KEY_EASY_STAKING]
    ///      - gate: Registry[KEY_GOVERNANCE_GATE]
    ///      - guardian (veto): Registry[KEY_GOVERNANCE_GUARDIAN]
    address public registry;
    
    /// @notice 最小提案时间（区块）
    uint256 public minProposalBlocks;
    
    /// @notice 最大提案时间（区块）
    uint256 public maxProposalBlocks;
    
    /// @notice 执行延迟时间（区块）
    uint256 public executionDelayBlocks;
    
    /// @notice 法定人数比例 (BPS)
    uint256 public quorumBPS;
    
    /// @notice 投票阈值比例 (BPS)
    uint256 public voteThresholdBPS;
    
    /// @notice 跨链验证器
    mapping(address => bool) public crossChainValidators;
    
    /// @notice 跨链消息哈希验证
    mapping(bytes32 => bool) public executedCrossChainMessages;

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string description, uint256 startBlock, uint256 endBlock);
    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteOption option, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event CrossChainVoteReceived(uint256 indexed proposalId, uint256 indexed chainId, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes);
    event CrossChainExecution(uint256 indexed proposalId, uint256 indexed chainId, bytes32 messageHash);
    event GovernanceParametersUpdated(uint256 minProposalBlocks, uint256 maxProposalBlocks, uint256 executionDelayBlocks, uint256 quorumBPS, uint256 voteThresholdBPS);
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry, uint256 blockNumber);
    event ProposalVetoed(uint256 indexed proposalId, address indexed guardian, uint256 blockNumber);
    event GovernanceTokenSynced(address indexed oldToken, address indexed newToken, address indexed registry, uint256 blockNumber);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param admin 管理员地址
    /// @param registry_ Registry address (SSOT).
    function initialize(address admin, address registry_) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, admin);

        // Registry is REQUIRED (SSOT). Used for governanceToken + gate + guardian.
        if (registry_ == address(0)) revert CrossChainGovernance__RegistryNotSet();
        if (registry_.code.length == 0) revert NotAContract(registry_);
        registry = registry_;
        emit RegistryUpdated(address(0), registry_, block.number);

    // OZ UUPS upgrade-safety: never rely on inline initialization for storage vars.
    // Set governance parameter defaults explicitly in initializer.
    minProposalBlocks = _DEFAULT_MIN_PROPOSAL_BLOCKS;
    maxProposalBlocks = _DEFAULT_MAX_PROPOSAL_BLOCKS;
    executionDelayBlocks = _DEFAULT_EXECUTION_DELAY_BLOCKS;
    quorumBPS = 4000; // 40%
    voteThresholdBPS = 6000; // 60%

        // Initialize cached governance token from Registry SSOT.
        // NOTE: deployment order can bind KEY_EASY_STAKING after this module is deployed.
        // We keep the invariant enforcement in security-critical paths, but we don't want
        // initializer to hard-revert just because the key isn't registered yet.
        address expected = IRegistry(registry_).getModule(ModuleKeys.KEY_EASY_STAKING);
        if (expected != address(0) && expected.code.length != 0) {
            governanceToken = expected;
            emit GovernanceTokenSynced(address(0), expected, registry, block.number);
        }
        
        // 初始化支持的链
        supportedChains[1] = true;    // Ethereum
        supportedChains[42161] = true; // Arbitrum
        supportedChains[137] = true;   // Polygon
        supportedChains[56] = true;    // BSC
    }

    /// @notice Sets (or replaces) Registry address (SSOT for gate + guardian).
    function setRegistry(address registry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry_ == address(0)) revert ZeroAddress();
        if (registry_.code.length == 0) revert NotAContract(registry_);
        address old = registry;
        registry = registry_;
        emit RegistryUpdated(old, registry_, block.number);
        // Keep token cache in sync with new registry SSOT.
        _syncGovernanceTokenFromRegistry();
    }

    /// @notice Syncs cached governanceToken from Registry[KEY_EASY_STAKING].
    /// @dev Admin-only. This is Scheme B's explicit "cache refresh" hook.
    ///      Any Registry update to KEY_EASY_STAKING should be followed by calling this.
    function syncGovernanceTokenFromRegistry() external onlyRole(DEFAULT_ADMIN_ROLE) returns (address expected, bool changed) {
        (expected, changed) = _syncGovernanceTokenFromRegistry();
    }

    /// @notice 创建提案
    /// @param description 提案描述
    /// @param actions 执行动作数组
    /// @param targets 目标合约数组
    /// @param votingPeriod 投票周期（区块）
    function createProposal(
        string calldata description,
        bytes[] calldata actions,
        address[] calldata targets,
        uint256 votingPeriod
    ) external returns (uint256 proposalId) {
        _requireGovernanceTokenInSync();
        // Backward-compatible: if GovernanceGate is not configured, keep legacy role gating.
        address gate = _getGovernanceGate();
        if (gate == address(0)) {
            _checkRole(GOVERNANCE_ROLE, msg.sender);
        } else {
            _requireGateEligibleToPropose(gate, msg.sender);
        }
        if (votingPeriod < minProposalBlocks || votingPeriod > maxProposalBlocks) {
            revert CrossChainGovernance__InvalidProposal();
        }
        
        proposalId = ++proposalCount;
        
        uint256 startBlock = block.number;
        uint256 endBlock = startBlock + votingPeriod;
        uint256 quorum = _calculateQuorum();
        
        proposals[proposalId] = Proposal({
            proposalId: proposalId,
            proposer: msg.sender,
            description: description,
            forVotes: 0,
            againstVotes: 0,
            abstainVotes: 0,
            startBlock: startBlock,
            endBlock: endBlock,
            executionBlock: 0,
            executed: false,
            canceled: false,
            state: ProposalState.Active,
            quorum: quorum,
            chainId: block.chainid,
            actions: actions,
            targets: targets
        });
        
        emit ProposalCreated(proposalId, msg.sender, description, startBlock, endBlock);
    }

    /// @notice 投票
    /// @param proposalId 提案ID
    /// @param option 投票选项
    function vote(uint256 proposalId, VoteOption option) external {
        _requireGovernanceTokenInSync();
        Proposal storage proposal = proposals[proposalId];
        
        if (proposal.state != ProposalState.Active) {
            revert CrossChainGovernance__ProposalNotActive();
        }

        if (proposal.canceled) revert CrossChainGovernance__ProposalCanceled();
        
        if (block.number < proposal.startBlock || block.number > proposal.endBlock) {
            revert CrossChainGovernance__ProposalNotActive();
        }
        
        Vote storage userVote = votes[proposalId][msg.sender];
        if (userVote.hasVoted) {
            revert CrossChainGovernance__AlreadyVoted();
        }
        
        // Snapshot voting power at (startBlock - 1) to avoid `getPastVotes` restrictions in the same block.
        uint256 snapshotBlock = proposal.startBlock == 0 ? 0 : proposal.startBlock - 1;

        // GovernanceGate SSOT check (if configured).
        address gate = _getGovernanceGate();
        if (gate != address(0)) {
            _requireGateEligibleToVote(gate, msg.sender, snapshotBlock);
        }

        uint256 weight = IVotes(governanceToken).getPastVotes(msg.sender, snapshotBlock);
        if (weight == 0) {
            revert CrossChainGovernance__InsufficientVotes();
        }
        
        userVote.option = option;
        userVote.weight = weight;
        userVote.voteBlock = block.number;
        userVote.hasVoted = true;
        
        if (option == VoteOption.For) {
            proposal.forVotes += weight;
        } else if (option == VoteOption.Against) {
            proposal.againstVotes += weight;
        } else if (option == VoteOption.Abstain) {
            proposal.abstainVotes += weight;
        }
        
        emit VoteCast(proposalId, msg.sender, option, weight);
    }

    /// @notice 执行提案
    /// @param proposalId 提案ID
    function executeProposal(uint256 proposalId) external onlyRole(EXECUTOR_ROLE) nonReentrant {
        Proposal storage proposal = proposals[proposalId];
        
        if (proposal.executed) {
            revert CrossChainGovernance__ExecutionFailed();
        }

        if (proposal.canceled) revert CrossChainGovernance__ExecutionFailed();
        
        if (_computeProposalState(proposal) != ProposalState.Succeeded) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        
        if (block.number < proposal.endBlock + executionDelayBlocks) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        
        proposal.executed = true;
        proposal.executionBlock = block.number;
        proposal.state = ProposalState.Executed;
        
        // 执行提案动作
        for (uint256 i = 0; i < proposal.actions.length; i++) {
            (bool success, ) = proposal.targets[i].call(proposal.actions[i]);
            if (!success) {
                revert CrossChainGovernance__ExecutionFailed();
            }
        }
        
        emit ProposalExecuted(proposalId, msg.sender);
    }

    /// @notice 接收跨链投票
    /// @param proposalId 提案ID
    /// @param chainId 源链ID
    /// @param forVotes 赞成票数
    /// @param againstVotes 反对票数
    /// @param abstainVotes 弃权票数
    /// @param totalWeight 总权重
    /// @param validator 验证器地址
    function receiveCrossChainVote(
        uint256 proposalId,
        uint256 chainId,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 totalWeight,
        address validator,
        bytes calldata /* signature */
    ) external onlyRole(EXECUTOR_ROLE) nonReentrant {
        if (!supportedChains[chainId]) {
            revert CrossChainGovernance__InvalidChainId();
        }
        
        if (!crossChainValidators[validator]) {
            revert CrossChainGovernance__InvalidExecutor();
        }
        
        // 验证签名 (简化版本，实际需要完整的签名验证)
        // bytes32 messageHash = keccak256(abi.encodePacked(
        //     proposalId,
        //     chainId,
        //     forVotes,
        //     againstVotes,
        //     abstainVotes,
        //     totalWeight
        // ));
        
        CrossChainVote storage crossChainVote = crossChainVotes[proposalId][chainId];
        crossChainVote.forVotes = forVotes;
        crossChainVote.againstVotes = againstVotes;
        crossChainVote.abstainVotes = abstainVotes;
        crossChainVote.totalWeight = totalWeight;
        crossChainVote.isVerified = true;
        
        // 更新主提案的投票数
        Proposal storage proposal = proposals[proposalId];
        proposal.forVotes += forVotes;
        proposal.againstVotes += againstVotes;
        proposal.abstainVotes += abstainVotes;
        
        emit CrossChainVoteReceived(proposalId, chainId, forVotes, againstVotes, abstainVotes);
    }

    /// @notice 跨链执行提案
    /// @param proposalId 提案ID
    /// @param targetChainId 目标链ID
    /// @param targetContract 目标合约地址
    /// @param action 执行动作
    function executeCrossChainProposal(
        uint256 proposalId,
        uint256 targetChainId,
        address targetContract,
        bytes calldata action
    ) external onlyRole(EXECUTOR_ROLE) nonReentrant {
        if (!supportedChains[targetChainId]) {
            revert CrossChainGovernance__InvalidChainId();
        }
        
        Proposal storage proposal = proposals[proposalId];
        if (!proposal.executed) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        if (proposal.canceled) revert CrossChainGovernance__ExecutionFailed();
        
        bytes32 crossChainMessageHash = keccak256(abi.encodePacked(
            proposalId,
            targetChainId,
            targetContract,
            action
        ));
        
        if (executedCrossChainMessages[crossChainMessageHash]) {
            revert CrossChainGovernance__ExecutionFailed();
        }
        
        executedCrossChainMessages[crossChainMessageHash] = true;
        
        emit CrossChainExecution(proposalId, targetChainId, crossChainMessageHash);
    }

    /// @notice 更新治理参数
    /// @param minBlocks 最小提案时间（区块）
    /// @param maxBlocks 最大提案时间（区块）
    /// @param delayBlocks 执行延迟（区块）
    /// @param quorum 法定人数比例
    /// @param threshold 投票阈值比例
    function updateGovernanceParameters(
        uint256 minBlocks,
        uint256 maxBlocks,
        uint256 delayBlocks,
        uint256 quorum,
        uint256 threshold
    ) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        minProposalBlocks = minBlocks;
        maxProposalBlocks = maxBlocks;
        executionDelayBlocks = delayBlocks;
        quorumBPS = quorum;
        voteThresholdBPS = threshold;
        
        emit GovernanceParametersUpdated(minBlocks, maxBlocks, delayBlocks, quorum, threshold);
    }

    /// @notice 添加跨链验证器
    /// @param validator 验证器地址
    function addCrossChainValidator(address validator) external onlyRole(GOVERNANCE_ROLE) {
        crossChainValidators[validator] = true;
    }

    /// @notice 移除跨链验证器
    /// @param validator 验证器地址
    function removeCrossChainValidator(address validator) external onlyRole(GOVERNANCE_ROLE) {
        crossChainValidators[validator] = false;
    }

    /// @notice 添加支持的链
    /// @param chainId 链ID
    function addSupportedChain(uint256 chainId) external onlyRole(GOVERNANCE_ROLE) {
        supportedChains[chainId] = true;
    }

    /// @notice 移除支持的链
    /// @param chainId 链ID
    function removeSupportedChain(uint256 chainId) external onlyRole(GOVERNANCE_ROLE) {
        supportedChains[chainId] = false;
    }

    /// @notice 获取提案状态
    /// @param proposalId 提案ID
    /// @return state 提案状态
    function getProposalState(uint256 proposalId) external view returns (ProposalState state) {
        Proposal storage proposal = proposals[proposalId];
        return _computeProposalState(proposal);
    }

    /// @notice Foundation veto (guardian) cancels a proposal before execution.
    /// @dev Guardian address is resolved from Registry[KEY_GOVERNANCE_GUARDIAN].
    function vetoProposal(uint256 proposalId) external nonReentrant {
        if (registry == address(0)) revert CrossChainGovernance__RegistryNotSet();
        address guardian = IRegistry(registry).getModule(ModuleKeys.KEY_GOVERNANCE_GUARDIAN);
        if (guardian == address(0)) revert CrossChainGovernance__GuardianNotSet();
        if (msg.sender != guardian) revert CrossChainGovernance__NotGuardian(msg.sender, guardian);

        Proposal storage proposal = proposals[proposalId];
        if (proposal.proposalId == 0) revert CrossChainGovernance__InvalidProposal();
        if (proposal.executed) revert CrossChainGovernance__ExecutionFailed();

        proposal.canceled = true;
        emit ProposalVetoed(proposalId, guardian, block.number);
    }

    // ============ Gate helpers ============

    function _getGovernanceGate() internal view returns (address) {
        if (registry == address(0)) return address(0);
        return IRegistry(registry).getModule(ModuleKeys.KEY_GOVERNANCE_GATE);
    }

    function _requireGateEligibleToPropose(address gate, address proposer) internal view {
        uint256 snapshotBlock = block.number - 1;
        (bool ok, bytes32 reason) = IGovernanceGateRead(gate).isEligibleToPropose(proposer, snapshotBlock, governanceToken);
        if (!ok) revert CrossChainGovernance__GovernanceGateRejected(reason);
    }

    function _requireGateEligibleToVote(address gate, address voter, uint256 snapshotBlock) internal view {
        (bool ok, bytes32 reason) = IGovernanceGateRead(gate).isEligibleToVote(voter, snapshotBlock, governanceToken);
        if (!ok) revert CrossChainGovernance__GovernanceGateRejected(reason);
    }

    // ============ Proposal state ============

    function _computeProposalState(Proposal storage proposal) internal view returns (ProposalState) {
        if (proposal.executed) return ProposalState.Executed;
        if (proposal.canceled) return ProposalState.Defeated;
        if (block.number < proposal.startBlock) return ProposalState.Pending;
        if (block.number > proposal.endBlock) {
            uint256 totalVotes = proposal.forVotes + proposal.againstVotes + proposal.abstainVotes;
            if (totalVotes >= proposal.quorum && proposal.forVotes > proposal.againstVotes) {
                return ProposalState.Succeeded;
            } else {
                return ProposalState.Defeated;
            }
        }
        return ProposalState.Active;
    }

    /// @notice 获取用户投票信息
    /// @param proposalId 提案ID
    /// @param voter 投票者地址
    /// @return option 投票选项
    /// @return weight 投票权重
    /// @return voteBlock 投票区块号（blockNumber）
    /// @return hasVoted 是否已投票
    function getUserVote(uint256 proposalId, address voter) external view returns (
        VoteOption option,
        uint256 weight,
        uint256 voteBlock,
        bool hasVoted
    ) {
        Vote storage userVote = votes[proposalId][voter];
        return (userVote.option, userVote.weight, userVote.voteBlock, userVote.hasVoted);
    }

    /// @notice 获取跨链投票信息
    /// @param proposalId 提案ID
    /// @param chainId 链ID
    /// @return forVotes 赞成票数
    /// @return againstVotes 反对票数
    /// @return abstainVotes 弃权票数
    /// @return totalWeight 总权重
    /// @return isVerified 是否已验证
    function getCrossChainVote(uint256 proposalId, uint256 chainId) external view returns (
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 totalWeight,
        bool isVerified
    ) {
        CrossChainVote storage crossChainVote = crossChainVotes[proposalId][chainId];
        return (crossChainVote.forVotes, crossChainVote.againstVotes, crossChainVote.abstainVotes, crossChainVote.totalWeight, crossChainVote.isVerified);
    }

    // ============ Scheme B: governance token invariant (Registry SSOT) ============

    /// @notice Returns the expected governanceToken address from Registry SSOT.
    /// @dev Reverts if Registry is unset or KEY_EASY_STAKING is missing.
    function expectedGovernanceToken() external view returns (address) {
        return _expectedGovernanceTokenFromRegistry();
    }

    function _expectedGovernanceTokenFromRegistry() internal view returns (address expected) {
        if (registry == address(0)) revert CrossChainGovernance__RegistryNotSet();
        expected = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_EASY_STAKING);
        if (expected.code.length == 0) revert CrossChainGovernance__InvalidGovernanceToken(expected);
        return expected;
    }

    function _requireGovernanceTokenInSync() internal view {
        address expected = _expectedGovernanceTokenFromRegistry();
        if (governanceToken != expected) {
            revert CrossChainGovernance__GovernanceTokenOutOfSync(governanceToken, expected);
        }
    }

    function _syncGovernanceTokenFromRegistry() internal returns (address expected, bool changed) {
        expected = _expectedGovernanceTokenFromRegistry();
        address old = governanceToken;
        if (old == expected) return (expected, false);
        governanceToken = expected;
        emit GovernanceTokenSynced(old, expected, registry, block.number);
        return (expected, true);
    }

    /// @notice 计算法定人数
    /// @return quorum 法定人数
    function _calculateQuorum() internal view returns (uint256 quorum) {
        if (quorumBPS == 0) return 0;

        uint256 snapshotBlock = block.number > 0 ? block.number - 1 : 0;
        uint256 baseSupply = IVotes(governanceToken).getPastTotalSupply(snapshotBlock);
        return Math.mulDiv(baseSupply, quorumBPS, 10000);
    }

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {
        // 防御式校验：避免升级到 EOA/零地址
        require(newImplementation.code.length > 0, "Invalid implementation");
    }

    // ============ Storage Gap ============
    uint256[49] private __gap;
} 