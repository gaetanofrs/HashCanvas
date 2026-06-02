// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReputationSBT} from "./ReputationSBT.sol";
import {IArtworkLifecycle} from "./interfaces/IArtworkLifecycle.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/**
 * @title AICAGovernance
 * @notice Operational Governance Authority for the AICA consortium (WP2 §3.3).
 *
 *  Design note: this is a purpose-built Governor following OpenZeppelin's modular Governor *pattern*
 *  (proposal lifecycle, weighted counting, quorum, execution) rather than literally inheriting
 *  `Governor`. OZ's `castVote(proposalId, support)` reveals the choice at cast time, which is
 *  fundamentally incompatible with the required Two-Phase Blind (Commit-Reveal) protocol and the
 *  hybrid heads-based quorum. The voting surface is therefore reimplemented as
 *  `commitVote` / `revealVote`, keeping the rest of the pattern intact.
 *
 *  Voting weight comes from non-transferable Reputation SBTs, immunising governance from
 *  flash-loan / vote-buying manipulation.
 *
 *  Two proposal flows:
 *   - POLICY_UPDATE        → on approval, overwrites the active validation policy on the Lifecycle.
 *   - EMERGENCY_REVOCATION → opened on a Nucleo TPC alert; on approval, drives a specific assetId to
 *                            the terminal REVOKED state and applies a fraud strike to the owner.
 */
contract AICAGovernance {
    enum ProposalType {
        POLICY_UPDATE,
        EMERGENCY_REVOCATION
    }

    enum Phase {
        COMMIT,
        REVEAL,
        CLOSED
    }

    uint8 public constant VOTE_FOR = 1;
    uint8 public constant VOTE_AGAINST = 2;

    struct Proposal {
        ProposalType ptype;
        bytes payload;
        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 forWeight;
        uint256 againstWeight;
        uint32 revealedCount;
        bool executed;
        address proposer;
    }

    IIdentityRegistry public immutable identity;
    ReputationSBT public immutable sbt;
    IArtworkLifecycle public immutable lifecycle;
    address public immutable admin;

    uint256 public immutable commitDuration;
    uint256 public immutable revealDuration;
    uint256 public immutable revealReward; // synchronous SBT minted to a critic on successful reveal

    mapping(address => bool) public isCritic; // on-chain whitelist (WP2 §3.3.1)
    uint256 public criticCount;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bytes32)) public commitOf;
    mapping(uint256 => mapping(address => bool)) public hasRevealed;

    event CriticUpdated(address indexed critic, bool allowed);
    event ProposalCreated(uint256 indexed id, ProposalType ptype, address proposer, uint256 commitDeadline, uint256 revealDeadline);
    event VoteCommitted(uint256 indexed id, address indexed critic);
    event VoteRevealed(uint256 indexed id, address indexed critic, uint8 support, uint256 weight);
    event ProposalExecuted(uint256 indexed id, bool approved);

    error NotAdmin();
    error NotCritic();
    error NotTpc();
    error WrongPhase();
    error AlreadyRevealed();
    error NoCommit();
    error BadReveal();
    error BadSupport();
    error AlreadyExecuted();
    error QuorumNotReached();
    error TooEarly();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyCritic() {
        if (!isCritic[msg.sender]) revert NotCritic();
        _;
    }

    constructor(
        IIdentityRegistry identityRegistry,
        ReputationSBT reputation,
        IArtworkLifecycle artworkLifecycle,
        uint256 commitDuration_,
        uint256 revealDuration_,
        uint256 revealReward_
    ) {
        identity = identityRegistry;
        sbt = reputation;
        lifecycle = artworkLifecycle;
        admin = msg.sender;
        commitDuration = commitDuration_;
        revealDuration = revealDuration_;
        revealReward = revealReward_;
    }

    // ---------------------------------------------------------------------------------------------
    // Critic whitelist
    // ---------------------------------------------------------------------------------------------

    function setCritic(address critic, bool allowed) external onlyAdmin {
        if (isCritic[critic] == allowed) return;
        isCritic[critic] = allowed;
        criticCount = allowed ? criticCount + 1 : criticCount - 1;
        emit CriticUpdated(critic, allowed);
    }

    // ---------------------------------------------------------------------------------------------
    // Proposal creation
    // ---------------------------------------------------------------------------------------------

    function proposePolicyUpdate(uint256 minDeclaredValue, bytes32[] calldata disallowedCompounds)
        external
        onlyCritic
        returns (uint256 id)
    {
        return _createProposal(ProposalType.POLICY_UPDATE, abi.encode(minDeclaredValue, disallowedCompounds));
    }

    /**
     * @notice Opened by a Nucleo TPC alert (TPC_ROLE). Targets a single assetId for revocation.
     * @dev Restricting the trigger to the TPC role is the structural mitigation surface for Alert
     *      Flooding (T10): only an accredited auditor identity can force a peer-review session.
     */
    function proposeEmergencyRevocation(string calldata assetId, address maliciousActor)
        external
        returns (uint256 id)
    {
        if (!identity.hasActiveRole(msg.sender, IIdentityRegistry.Role.TPC)) revert NotTpc();
        id = _createProposal(ProposalType.EMERGENCY_REVOCATION, abi.encode(assetId, maliciousActor));
        // The TPC fraud notification automatically freezes the asset on-chain (no manual step).
        lifecycle.governanceFreeze(assetId);
    }

    function _createProposal(ProposalType ptype, bytes memory payload) internal returns (uint256 id) {
        id = ++proposalCount;
        uint256 commitDeadline = block.timestamp + commitDuration;
        uint256 revealDeadline = commitDeadline + revealDuration;
        _proposals[id] = Proposal({
            ptype: ptype,
            payload: payload,
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            forWeight: 0,
            againstWeight: 0,
            revealedCount: 0,
            executed: false,
            proposer: msg.sender
        });
        emit ProposalCreated(id, ptype, msg.sender, commitDeadline, revealDeadline);
    }

    // ---------------------------------------------------------------------------------------------
    // Two-Phase Blind Voting (Commit-Reveal)
    // ---------------------------------------------------------------------------------------------

    /// @notice Hash a vote locally before committing: keccak256(support, salt, voter, proposalId).
    function hashVote(uint8 support, bytes32 salt, address voter, uint256 id)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(support, salt, voter, id));
    }

    /// @notice Commit TTL — critics submit a blinded hash. Reveals are impossible in this window.
    function commitVote(uint256 id, bytes32 commitHash) external onlyCritic {
        if (phaseOf(id) != Phase.COMMIT) revert WrongPhase();
        commitOf[id][msg.sender] = commitHash;
        emit VoteCommitted(id, msg.sender);
    }

    /// @notice Reveal TTL — critics disclose (support, salt); the contract checks it against the commit,
    ///         tallies SBT weight and synchronously mints the participation reward.
    function revealVote(uint256 id, uint8 support, bytes32 salt) external onlyCritic {
        Proposal storage p = _proposals[id];
        if (phaseOf(id) != Phase.REVEAL) revert WrongPhase();
        if (hasRevealed[id][msg.sender]) revert AlreadyRevealed();
        bytes32 commit = commitOf[id][msg.sender];
        if (commit == bytes32(0)) revert NoCommit();
        if (hashVote(support, salt, msg.sender, id) != commit) revert BadReveal();
        if (support != VOTE_FOR && support != VOTE_AGAINST) revert BadSupport();

        uint256 weight = sbt.balanceOf(msg.sender); // meritocratic weight at reveal time
        if (support == VOTE_FOR) {
            p.forWeight += weight;
        } else {
            p.againstWeight += weight;
        }
        p.revealedCount += 1;
        hasRevealed[id][msg.sender] = true;

        emit VoteRevealed(id, msg.sender, support, weight);

        // Synchronous Incentivization (WP2 §3.3.5): mint reputation to the revealing critic.
        if (revealReward > 0) {
            sbt.mint(msg.sender, revealReward);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Resolution & execution (hybrid quorum)
    // ---------------------------------------------------------------------------------------------

    /**
     * @notice Resolve and execute a closed proposal.
     *  - Democratic Quorum (heads-based): >= 51% of unique whitelisted critics must have revealed.
     *  - Meritocratic Resolution (weight-based): forWeight must exceed againstWeight.
     */
    function execute(uint256 id) external {
        Proposal storage p = _proposals[id];
        if (p.commitDeadline == 0) revert WrongPhase(); // unknown proposal
        if (block.timestamp <= p.revealDeadline) revert TooEarly();
        if (p.executed) revert AlreadyExecuted();
        p.executed = true; // checks-effects-interactions

        // Democratic quorum: revealedCount / criticCount >= 51%
        if (uint256(p.revealedCount) * 100 < 51 * criticCount) revert QuorumNotReached();

        bool approved = p.forWeight > p.againstWeight;
        if (approved) {
            if (p.ptype == ProposalType.POLICY_UPDATE) {
                (uint256 minValue, bytes32[] memory disallowed) = abi.decode(p.payload, (uint256, bytes32[]));
                lifecycle.setPolicy(minValue, disallowed);
            } else {
                (string memory assetId, address actor) = abi.decode(p.payload, (string, address));
                lifecycle.governanceRevoke(assetId);
                // penalise the malicious actor (counts toward 3-Strikes Enforcement)
                identity.registerStrike(actor, "AICA emergency revocation");
            }
        }
        emit ProposalExecuted(id, approved);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function phaseOf(uint256 id) public view returns (Phase) {
        Proposal storage p = _proposals[id];
        if (block.timestamp <= p.commitDeadline) return Phase.COMMIT;
        if (block.timestamp <= p.revealDeadline) return Phase.REVEAL;
        return Phase.CLOSED;
    }

    function quorumReached(uint256 id) external view returns (bool) {
        Proposal storage p = _proposals[id];
        return uint256(p.revealedCount) * 100 >= 51 * criticCount;
    }

    function getProposal(uint256 id)
        external
        view
        returns (
            ProposalType ptype,
            uint256 commitDeadline,
            uint256 revealDeadline,
            uint256 forWeight,
            uint256 againstWeight,
            uint32 revealedCount,
            bool executed
        )
    {
        Proposal storage p = _proposals[id];
        return (p.ptype, p.commitDeadline, p.revealDeadline, p.forWeight, p.againstWeight, p.revealedCount, p.executed);
    }
}
