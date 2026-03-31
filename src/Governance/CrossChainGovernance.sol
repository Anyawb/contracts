// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IRegistry} from "../interfaces/IRegistry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ZeroAddress, NotAContract} from "../errors/StandardErrors.sol";

error CrossChainGovernance__InvalidProposal();
error CrossChainGovernance__ProposalNotActive();
error CrossChainGovernance__AlreadyVoted();
error CrossChainGovernance__InvalidChainId();
error CrossChainGovernance__ExecutionFailed();
error CrossChainGovernance__InsufficientVotes();
error CrossChainGovernance__InvalidExecutor();
error CrossChainGovernance__InvalidGovernanceToken(address token);
error CrossChainGovernance__GovernanceTokenOutOfSync(
    address cached,
    address expected
);
error CrossChainGovernance__ProposalCanceled();
error CrossChainGovernance__GovernanceGateRejected(bytes32 reason);
error CrossChainGovernance__GuardianNotSet();
error CrossChainGovernance__NotGuardian(address caller, address guardian);
error CrossChainGovernance__RegistryNotSet();
error CrossChainGovernance__InvalidImplementation(address newImplementation);

/// @title IGovernanceGateRead
/// @notice Minimal read interface for GovernanceGate eligibility checks.
/// @dev Used by {CrossChainGovernance} to validate proposer and voter
///      eligibility without importing the full GovernanceGate
///      implementation.
interface IGovernanceGateRead {
    /// @notice Returns whether a user may vote for the given snapshot block.
    function isEligibleToVote(
        address user,
        uint256 snapshotBlock,
        address votesToken
    ) external view returns (bool ok, bytes32 reason);

    /// @notice Returns whether a user may create proposals for the given snapshot block.
    function isEligibleToPropose(
        address user,
        uint256 snapshotBlock,
        address votesToken
    ) external view returns (bool ok, bytes32 reason);
}

/// @title CrossChainGovernance
/// @notice Manages proposal creation, voting, veto, and cross-chain execution metadata for governance flows.
/// @dev Registry is the SSOT for governance token, governance gate, and guardian resolution.
contract CrossChainGovernance is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using Address for address;

    /// @notice Role allowed to manage governance configuration and validator/chains lists.
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    /// @notice Role allowed to execute proposals and submit cross-chain vote payloads.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @notice Default proposal timing parameters expressed in blocks.
    /// @dev These defaults can be overridden by governance through {updateGovernanceParameters}.
    uint256 private constant _DEFAULT_MIN_PROPOSAL_BLOCKS = 43_200;
    uint256 private constant _DEFAULT_MAX_PROPOSAL_BLOCKS = 1_296_000;
    uint256 private constant _DEFAULT_EXECUTION_DELAY_BLOCKS = 86_400;

    /// @notice Proposal lifecycle states.
    enum ProposalState {
        Pending,
        Active,
        Succeeded,
        Executed,
        Defeated,
        Expired
    }

    /// @notice Vote options supported by the governance system.
    enum VoteOption {
        Against,
        For,
        Abstain
    }

    /// @notice Proposal state tracked on the local chain.
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

    /// @notice Per-user vote record for a proposal.
    struct Vote {
        VoteOption option;
        uint256 weight;
        uint256 voteBlock; // block.number (Time-Dependency-Refactor)
        bool hasVoted;
    }

    /// @notice Cross-chain vote totals imported from another chain.
    struct CrossChainVote {
        uint256 chainId;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 totalWeight;
        bool isVerified;
    }

    /// @notice Proposal storage keyed by proposal id.
    mapping(uint256 => Proposal) public proposals;

    /// @notice User vote records keyed by proposal id and voter.
    mapping(uint256 => mapping(address => Vote)) public votes;

    /// @notice Imported cross-chain vote payloads keyed by proposal id and source chain id.
    mapping(uint256 => mapping(uint256 => CrossChainVote))
        public crossChainVotes;

    /// @notice Supported remote chain ids for cross-chain vote/execution flows.
    mapping(uint256 => bool) public supportedChains;

    /// @notice Monotonic proposal id counter.
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

    /// @notice Minimum voting window length, in blocks.
    uint256 public minProposalBlocks;

    /// @notice Maximum voting window length, in blocks.
    uint256 public maxProposalBlocks;

    /// @notice Delay between proposal end and execution eligibility, in blocks.
    uint256 public executionDelayBlocks;

    /// @notice Quorum threshold in basis points of historical total supply.
    uint256 public quorumBPS;

    /// @notice Voting threshold parameter reserved for policy use.
    uint256 public voteThresholdBPS;

    /// @notice Allowed validator set for imported cross-chain votes.
    mapping(address => bool) public crossChainValidators;

    /// @notice Tracks processed cross-chain execution message hashes.
    mapping(bytes32 => bool) public executedCrossChainMessages;

    /// @notice Emitted when a proposal is created.
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        string description,
        uint256 startBlock,
        uint256 endBlock
    );
    /// @notice Emitted when a user casts a vote.
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        VoteOption option,
        uint256 weight
    );
    /// @notice Emitted when a proposal is executed on the local chain.
    event ProposalExecuted(
        uint256 indexed proposalId,
        address indexed executor
    );
    /// @notice Emitted when verified cross-chain votes are imported.
    event CrossChainVoteReceived(
        uint256 indexed proposalId,
        uint256 indexed chainId,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes
    );
    /// @notice Emitted when a cross-chain execution message is marked as processed.
    event CrossChainExecution(
        uint256 indexed proposalId,
        uint256 indexed chainId,
        bytes32 messageHash
    );
    /// @notice Emitted when governance timing or quorum parameters are updated.
    event GovernanceParametersUpdated(
        uint256 minProposalBlocks,
        uint256 maxProposalBlocks,
        uint256 executionDelayBlocks,
        uint256 quorumBPS,
        uint256 voteThresholdBPS
    );
    /// @notice Emitted when the Registry address is updated.
    event RegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry,
        uint256 blockNumber
    );
    /// @notice Emitted when the guardian vetoes a proposal.
    event ProposalVetoed(
        uint256 indexed proposalId,
        address indexed guardian,
        uint256 blockNumber
    );
    /// @notice Emitted when the cached governance token is synchronized from Registry SSOT.
    event GovernanceTokenSynced(
        address indexed oldToken,
        address indexed newToken,
        address indexed registry,
        uint256 blockNumber
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes governance roles, Registry binding, defaults, and cached governance token.
     * @dev Reverts if:
     *      - `registry_` is zero (see {CrossChainGovernance__RegistryNotSet})
     *      - `registry_` has no code (see {NotAContract})
     *
     * Security:
     * - `admin` receives default admin, governance, and executor roles
     * - Registry is the SSOT for governance token, governance gate, and guardian resolution
     *
     * @param admin Initial admin/operator address.
     * @param registry_ Registry address.
     */
    function initialize(address admin, address registry_) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, admin);

        // Registry is REQUIRED (SSOT). Used for governanceToken + gate + guardian.
        if (registry_ == address(0))
            revert CrossChainGovernance__RegistryNotSet();
        if (registry_.code.length == 0) revert NotAContract(registry_);
        registry = registry_;
        emit RegistryUpdated(address(0), registry_, block.number);

        // OZ UUPS upgrade-safety: never rely on inline initialization for storage vars.
        // Set governance parameter defaults explicitly in the initializer.
        minProposalBlocks = _DEFAULT_MIN_PROPOSAL_BLOCKS;
        maxProposalBlocks = _DEFAULT_MAX_PROPOSAL_BLOCKS;
        executionDelayBlocks = _DEFAULT_EXECUTION_DELAY_BLOCKS;
        quorumBPS = 4000; // 40%
        voteThresholdBPS = 6000; // 60%

        // Initialize cached governance token from Registry SSOT.
        // NOTE: deployment order can bind KEY_EASY_STAKING after this module is deployed.
        // We keep the invariant enforcement in security-critical paths, but we don't want
        // initializer to hard-revert just because the key isn't registered yet.
        address expected = IRegistry(registry_).getModule(
            ModuleKeys.KEY_EASY_STAKING
        );
        if (expected != address(0) && expected.code.length != 0) {
            governanceToken = expected;
            emit GovernanceTokenSynced(
                address(0),
                expected,
                registry,
                block.number
            );
        }

        // Initialize default supported chains.
        supportedChains[1] = true; // Ethereum
        supportedChains[42161] = true; // Arbitrum
        supportedChains[137] = true; // Polygon
        supportedChains[56] = true; // BSC
    }

    /**
     * @notice Updates the Registry address used as governance SSOT.
     * @dev Reverts if:
     *      - caller lacks `DEFAULT_ADMIN_ROLE`
     *      - `registry_` is zero (see {ZeroAddress})
     *      - `registry_` has no code (see {NotAContract})
     *
     * Security:
     * - Refreshes the cached governance token after the Registry rotation
     *
     * @param registry_ New Registry address.
     */
    function setRegistry(
        address registry_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry_ == address(0)) revert ZeroAddress();
        if (registry_.code.length == 0) revert NotAContract(registry_);
        address old = registry;
        registry = registry_;
        emit RegistryUpdated(old, registry_, block.number);
        // Keep token cache in sync with new registry SSOT.
        _syncGovernanceTokenFromRegistry();
    }

    /**
     * @notice Synchronizes the cached governance token from `Registry[KEY_EASY_STAKING]`.
     * @dev Reverts if Registry is unset, missing the module, or the resolved address has no code.
     *
     * Security:
     * - Admin-only cache refresh hook for Scheme B invariant enforcement
     *
     * @return expected Expected governance token address from Registry.
     * @return changed Whether the cached address changed.
     */
    function syncGovernanceTokenFromRegistry()
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (address expected, bool changed)
    {
        (expected, changed) = _syncGovernanceTokenFromRegistry();
    }

    /**
     * @notice Creates a new proposal on the local chain.
     * @dev Reverts if:
     *      - cached governance token is out of sync with Registry SSOT
     *      - GovernanceGate rejects the proposer when the gate is configured
     *      - caller lacks `GOVERNANCE_ROLE` when the gate is not configured
     *      - `votingPeriod` is outside `[minProposalBlocks, maxProposalBlocks]`
     *
     * Security:
     * - Uses `block.number` as the SSOT time axis
     * - GovernanceGate is preferred over legacy role gating when configured
     *
     * @param description Proposal description.
     * @param actions Calldata payloads to execute if the proposal succeeds.
     * @param targets Target contracts aligned with `actions`.
     * @param votingPeriod Voting duration in blocks.
     * @return proposalId Newly created proposal id.
     */
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
        if (
            votingPeriod < minProposalBlocks || votingPeriod > maxProposalBlocks
        ) {
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

        emit ProposalCreated(
            proposalId,
            msg.sender,
            description,
            startBlock,
            endBlock
        );
    }

    /**
     * @notice Casts a vote on an active proposal using historical voting power.
     * @dev Reverts if:
     *      - cached governance token is out of sync with Registry SSOT
     *      - proposal is not active or is canceled
     *      - caller already voted on the proposal
     *      - GovernanceGate rejects the voter when the gate is configured
     *      - caller has zero voting power at `proposal.startBlock - 1`
     *
     * Security:
     * - Snapshot voting uses `startBlock - 1` to satisfy `IVotes.getPastVotes`
     * - Vote weights are immutable once cast because `hasVoted` is latched
     *
     * @param proposalId Proposal id.
     * @param option Vote option.
     */
    function vote(uint256 proposalId, VoteOption option) external {
        _requireGovernanceTokenInSync();
        Proposal storage proposal = proposals[proposalId];

        if (proposal.state != ProposalState.Active) {
            revert CrossChainGovernance__ProposalNotActive();
        }

        if (proposal.canceled) revert CrossChainGovernance__ProposalCanceled();

        if (
            block.number < proposal.startBlock ||
            block.number > proposal.endBlock
        ) {
            revert CrossChainGovernance__ProposalNotActive();
        }

        Vote storage userVote = votes[proposalId][msg.sender];
        if (userVote.hasVoted) {
            revert CrossChainGovernance__AlreadyVoted();
        }

        // Snapshot voting power at (startBlock - 1) to avoid `getPastVotes` restrictions in the same block.
        uint256 snapshotBlock = proposal.startBlock == 0
            ? 0
            : proposal.startBlock - 1;

        // GovernanceGate SSOT check (if configured).
        address gate = _getGovernanceGate();
        if (gate != address(0)) {
            _requireGateEligibleToVote(gate, msg.sender, snapshotBlock);
        }

        uint256 weight = IVotes(governanceToken).getPastVotes(
            msg.sender,
            snapshotBlock
        );
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

    /**
     * @notice Executes a succeeded proposal after the execution delay has elapsed.
     * @dev Reverts if:
     *      - caller lacks `EXECUTOR_ROLE`
     *      - proposal is already executed or canceled
     *      - proposal state is not `Succeeded`
     *      - execution delay has not elapsed
     *      - any target call fails
     *
     * Security:
     * - Non-reentrant around the full execution loop
     * - Uses raw target calls; governance payload authors must validate targets/calldata offchain
     *
     * @param proposalId Proposal id.
     */
    function executeProposal(
        uint256 proposalId
    ) external onlyRole(EXECUTOR_ROLE) nonReentrant {
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

        // Execute proposal actions sequentially.
        for (uint256 i = 0; i < proposal.actions.length; i++) {
            proposal.targets[i].functionCall(proposal.actions[i]);
        }

        emit ProposalExecuted(proposalId, msg.sender);
    }

    /**
     * @notice Imports a verified cross-chain vote payload for a proposal.
     * @dev Reverts if:
     *      - caller lacks `EXECUTOR_ROLE`
     *      - `chainId` is not supported
     *      - `validator` is not in the validator set
     *
     * Security:
     * - Signature verification is intentionally stubbed and must be completed before production use
     * - Imported totals are added directly to the local proposal tallies
     *
     * @param proposalId Proposal id.
     * @param chainId Source chain id.
     * @param forVotes Imported for votes.
     * @param againstVotes Imported against votes.
     * @param abstainVotes Imported abstain votes.
     * @param totalWeight Imported total voting weight.
     * @param validator Validator address associated with the payload.
     */
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

        // Signature verification is intentionally omitted in this simplified implementation.
        // bytes32 messageHash = keccak256(abi.encodePacked(
        //     proposalId,
        //     chainId,
        //     forVotes,
        //     againstVotes,
        //     abstainVotes,
        //     totalWeight
        // ));

        CrossChainVote storage crossChainVote = crossChainVotes[proposalId][
            chainId
        ];
        crossChainVote.forVotes = forVotes;
        crossChainVote.againstVotes = againstVotes;
        crossChainVote.abstainVotes = abstainVotes;
        crossChainVote.totalWeight = totalWeight;
        crossChainVote.isVerified = true;

        // Merge imported votes into the local proposal totals.
        Proposal storage proposal = proposals[proposalId];
        proposal.forVotes += forVotes;
        proposal.againstVotes += againstVotes;
        proposal.abstainVotes += abstainVotes;

        emit CrossChainVoteReceived(
            proposalId,
            chainId,
            forVotes,
            againstVotes,
            abstainVotes
        );
    }

    /**
     * @notice Marks a cross-chain execution message as processed for a previously executed proposal.
     * @dev Reverts if:
     *      - caller lacks `EXECUTOR_ROLE`
     *      - `targetChainId` is not supported
     *      - proposal has not been executed locally or has been canceled
     *      - the message hash was already processed
     *
     * Security:
     * - This function records message hashes only; it does not perform the remote execution itself
     *
     * @param proposalId Proposal id.
     * @param targetChainId Target chain id.
     * @param targetContract Target contract on the remote chain.
     * @param action Encoded remote action payload.
     */
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

        bytes32 crossChainMessageHash = keccak256(
            abi.encodePacked(proposalId, targetChainId, targetContract, action)
        );

        if (executedCrossChainMessages[crossChainMessageHash]) {
            revert CrossChainGovernance__ExecutionFailed();
        }

        executedCrossChainMessages[crossChainMessageHash] = true;

        emit CrossChainExecution(
            proposalId,
            targetChainId,
            crossChainMessageHash
        );
    }

    /**
     * @notice Updates proposal timing and quorum parameters.
     * @dev Reverts if caller lacks `GOVERNANCE_ROLE`.
     *
     * Security:
     * - Uses direct governance role gating; callers are responsible for providing sane values
     *
     * @param minBlocks Minimum voting duration in blocks.
     * @param maxBlocks Maximum voting duration in blocks.
     * @param delayBlocks Execution delay in blocks.
     * @param quorum Quorum threshold in basis points.
     * @param threshold Vote threshold parameter in basis points.
     */
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

        emit GovernanceParametersUpdated(
            minBlocks,
            maxBlocks,
            delayBlocks,
            quorum,
            threshold
        );
    }

    /// @notice Adds `validator` to the cross-chain validator set.
    function addCrossChainValidator(
        address validator
    ) external onlyRole(GOVERNANCE_ROLE) {
        crossChainValidators[validator] = true;
    }

    /// @notice Removes `validator` from the cross-chain validator set.
    function removeCrossChainValidator(
        address validator
    ) external onlyRole(GOVERNANCE_ROLE) {
        crossChainValidators[validator] = false;
    }

    /// @notice Marks `chainId` as supported for cross-chain governance flows.
    function addSupportedChain(
        uint256 chainId
    ) external onlyRole(GOVERNANCE_ROLE) {
        supportedChains[chainId] = true;
    }

    /// @notice Removes `chainId` from the supported cross-chain set.
    function removeSupportedChain(
        uint256 chainId
    ) external onlyRole(GOVERNANCE_ROLE) {
        supportedChains[chainId] = false;
    }

    /// @notice Returns the computed state for `proposalId`.
    function getProposalState(
        uint256 proposalId
    ) external view returns (ProposalState state) {
        Proposal storage proposal = proposals[proposalId];
        return _computeProposalState(proposal);
    }

    /// @notice Foundation veto (guardian) cancels a proposal before execution.
    /// @dev Guardian address is resolved from Registry[KEY_GOVERNANCE_GUARDIAN].
    function vetoProposal(uint256 proposalId) external nonReentrant {
        if (registry == address(0))
            revert CrossChainGovernance__RegistryNotSet();
        address guardian = IRegistry(registry).getModule(
            ModuleKeys.KEY_GOVERNANCE_GUARDIAN
        );
        if (guardian == address(0))
            revert CrossChainGovernance__GuardianNotSet();
        if (msg.sender != guardian)
            revert CrossChainGovernance__NotGuardian(msg.sender, guardian);

        Proposal storage proposal = proposals[proposalId];
        if (proposal.proposalId == 0)
            revert CrossChainGovernance__InvalidProposal();
        if (proposal.executed) revert CrossChainGovernance__ExecutionFailed();

        proposal.canceled = true;
        emit ProposalVetoed(proposalId, guardian, block.number);
    }

    /*━━━━━━━━━━━━━━━ Gate Helpers ━━━━━━━━━━━━━━━*/

    function _getGovernanceGate() internal view returns (address) {
        if (registry == address(0)) return address(0);
        return IRegistry(registry).getModule(ModuleKeys.KEY_GOVERNANCE_GATE);
    }

    function _requireGateEligibleToPropose(
        address gate,
        address proposer
    ) internal view {
        uint256 snapshotBlock = block.number - 1;
        (bool ok, bytes32 reason) = IGovernanceGateRead(gate)
            .isEligibleToPropose(proposer, snapshotBlock, governanceToken);
        if (!ok) revert CrossChainGovernance__GovernanceGateRejected(reason);
    }

    function _requireGateEligibleToVote(
        address gate,
        address voter,
        uint256 snapshotBlock
    ) internal view {
        (bool ok, bytes32 reason) = IGovernanceGateRead(gate).isEligibleToVote(
            voter,
            snapshotBlock,
            governanceToken
        );
        if (!ok) revert CrossChainGovernance__GovernanceGateRejected(reason);
    }

    /*━━━━━━━━━━━━━━━ Proposal State ━━━━━━━━━━━━━━━*/

    function _computeProposalState(
        Proposal storage proposal
    ) internal view returns (ProposalState) {
        if (proposal.executed) return ProposalState.Executed;
        if (proposal.canceled) return ProposalState.Defeated;
        if (block.number < proposal.startBlock) return ProposalState.Pending;
        if (block.number > proposal.endBlock) {
            uint256 totalVotes = proposal.forVotes +
                proposal.againstVotes +
                proposal.abstainVotes;
            if (
                totalVotes >= proposal.quorum &&
                proposal.forVotes > proposal.againstVotes
            ) {
                return ProposalState.Succeeded;
            } else {
                return ProposalState.Defeated;
            }
        }
        return ProposalState.Active;
    }

    /**
     * @notice Returns the stored vote record for `voter` on `proposalId`.
     * @param proposalId Proposal id.
     * @param voter Voter address.
     * @return option Stored vote option.
     * @return weight Stored vote weight.
     * @return voteBlock Block number when the vote was cast.
     * @return hasVoted Whether the voter already voted.
     */
    function getUserVote(
        uint256 proposalId,
        address voter
    )
        external
        view
        returns (
            VoteOption option,
            uint256 weight,
            uint256 voteBlock,
            bool hasVoted
        )
    {
        Vote storage userVote = votes[proposalId][voter];
        return (
            userVote.option,
            userVote.weight,
            userVote.voteBlock,
            userVote.hasVoted
        );
    }

    /**
     * @notice Returns the imported cross-chain vote totals for `proposalId` and `chainId`.
     * @param proposalId Proposal id.
     * @param chainId Source chain id.
     * @return forVotes Imported for votes.
     * @return againstVotes Imported against votes.
     * @return abstainVotes Imported abstain votes.
     * @return totalWeight Imported total voting weight.
     * @return isVerified Whether the payload was marked verified.
     */
    function getCrossChainVote(
        uint256 proposalId,
        uint256 chainId
    )
        external
        view
        returns (
            uint256 forVotes,
            uint256 againstVotes,
            uint256 abstainVotes,
            uint256 totalWeight,
            bool isVerified
        )
    {
        CrossChainVote storage crossChainVote = crossChainVotes[proposalId][
            chainId
        ];
        return (
            crossChainVote.forVotes,
            crossChainVote.againstVotes,
            crossChainVote.abstainVotes,
            crossChainVote.totalWeight,
            crossChainVote.isVerified
        );
    }

    /*━━━━━━━━━━━━━━━  Governance Token Invariant ━━━━━━━━━━━━━━━*/

    /// @notice Returns the expected governanceToken address from Registry SSOT.
    /// @dev Reverts if Registry is unset or KEY_EASY_STAKING is missing.
    function expectedGovernanceToken() external view returns (address) {
        return _expectedGovernanceTokenFromRegistry();
    }

    /// @dev Resolves the expected governance token from Registry and validates that the address has code.
    function _expectedGovernanceTokenFromRegistry()
        internal
        view
        returns (address expected)
    {
        if (registry == address(0))
            revert CrossChainGovernance__RegistryNotSet();
        expected = IRegistry(registry).getModuleOrRevert(
            ModuleKeys.KEY_EASY_STAKING
        );
        if (expected.code.length == 0)
            revert CrossChainGovernance__InvalidGovernanceToken(expected);
        return expected;
    }

    /// @dev Enforces that the cached governance token matches Registry SSOT.
    function _requireGovernanceTokenInSync() internal view {
        address expected = _expectedGovernanceTokenFromRegistry();
        if (governanceToken != expected) {
            revert CrossChainGovernance__GovernanceTokenOutOfSync(
                governanceToken,
                expected
            );
        }
    }

    /// @dev Refreshes the cached governance token from Registry and emits {GovernanceTokenSynced} on change.
    function _syncGovernanceTokenFromRegistry()
        internal
        returns (address expected, bool changed)
    {
        expected = _expectedGovernanceTokenFromRegistry();
        address old = governanceToken;
        if (old == expected) return (expected, false);
        governanceToken = expected;
        emit GovernanceTokenSynced(old, expected, registry, block.number);
        return (expected, true);
    }

    /// @notice Calculates the current quorum target from historical total supply.
    function _calculateQuorum() internal view returns (uint256 quorum) {
        if (quorumBPS == 0) return 0;

        uint256 snapshotBlock = block.number > 0 ? block.number - 1 : 0;
        uint256 baseSupply = IVotes(governanceToken).getPastTotalSupply(
            snapshotBlock
        );
        return Math.mulDiv(baseSupply, quorumBPS, 10000);
    }

    /**
     * @notice Authorizes UUPS upgrades.
     * @dev Reverts if caller lacks `DEFAULT_ADMIN_ROLE` or `newImplementation` has no code.
     *      If a Timelock/Multisig layer is introduced later, its checks should be enforced here.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {
        // Defensive check: do not upgrade to an EOA or zero-code address.
        if (newImplementation.code.length == 0) {
            revert CrossChainGovernance__InvalidImplementation(
                newImplementation
            );
        }
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[49] private __gap;
}
