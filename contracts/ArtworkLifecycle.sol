// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IArtworkLifecycle} from "./interfaces/IArtworkLifecycle.sol";

/**
 * @title ArtworkLifecycle
 * @notice Art Digital Twin & Lifecycle contract (WP2 §3.4/§3.5, WP4 §5.1).
 *
 *  Dual-Storage Paradigm: only the lightweight on-chain index lives here; the heavy JSON-LD manifest
 *  is stored off-chain on the private IPFS cluster and anchored via `artworkDataCid`.
 *
 *  Implements:
 *   - The 6-state Finite State Machine (PENDING_VALIDATION → CERTIFIED → … → REVOKED).
 *   - Automatic certification against the active AICA validation policy (no per-artwork vote).
 *   - Asymmetric dRBAC delegation with anti-loop (galleries → collectors only), depth cap = 2,
 *     TTL temporal validation and cascading revocation.
 *   - Lock-and-release ownership transfer that defeats Double Transfer (T03).
 */
contract ArtworkLifecycle is IArtworkLifecycle {
    enum Status {
        NONE,
        PENDING_VALIDATION,
        CERTIFIED,
        LOCKED_FOR_SALE,
        DELEGATED,
        FROZEN,
        REVOKED
    }

    struct Artwork {
        string assetId; // UUIDv4
        address artist; // artistDid (immutable creator)
        address currentOwner; // currentOwnerDid (dynamic title holder)
        string artworkDataCid; // IPFS root CID of the JSON-LD manifest
        bytes aicaSignature; // AICA certification proof
        Status status;
        Status prevStatus; // status captured before an emergency FREEZE (for Alert Rejected)
        uint256 lastUpdated;
        uint256 declaredValue; // mirror of manifest "value" used for automatic policy evaluation
    }

    struct Delegation {
        address delegate;
        uint256 expiry; // absolute unix deadline (TTL)
        uint8 depth; // 1 = primary, 2 = sub-delegation
        bool active;
    }

    uint8 public constant MAX_DELEGATION_DEPTH = 2;

    IIdentityRegistry public immutable identity;
    address public immutable admin; // deployer — wires governance once
    address public governance; // AICA Governance contract (policy + revocation authority)

    // Active validation policy (overwritten by governance, WP2 §3.3.5).
    uint256 public policyMinDeclaredValue;
    uint256 public policyVersion;
    bytes32[] private _disallowedList;
    mapping(bytes32 => bool) public disallowedCompound;

    mapping(bytes32 => Artwork) private _artworks; // keccak(assetId) => Artwork
    mapping(bytes32 => bool) private _exists;
    mapping(bytes32 => bytes32[]) private _compoundIds; // on-chain mirror for policy checks
    mapping(bytes32 => Delegation[]) private _chains; // delegation chain per asset
    mapping(bytes32 => address) public pendingBuyer; // lock-and-release transfer target

    event ArtworkInitialized(bytes32 indexed key, string assetId, address indexed artist, string cid);
    event ArtworkCertified(bytes32 indexed key, uint256 policyVersion);
    event PolicyUpdated(uint256 indexed version, uint256 minDeclaredValue, uint256 disallowedCount);
    event DelegationGranted(bytes32 indexed key, address indexed delegate, uint8 depth, uint256 expiry);
    event DelegationRevoked(bytes32 indexed key, address indexed by);
    event TransferInitiated(bytes32 indexed key, address indexed from, address indexed to);
    event TransferFinalized(bytes32 indexed key, address indexed newOwner);
    event AssetFrozen(bytes32 indexed key, address indexed by);
    event AssetUnfrozen(bytes32 indexed key);
    event AssetRevoked(bytes32 indexed key);

    error NotAdmin();
    error NotGovernance();
    error GovernanceAlreadySet();
    error Unauthorized(); // dRBAC / ownership failure
    error UnknownAsset();
    error AssetExists();
    error BadState();
    error PolicyNotMet();
    error AntiLoop(); // gallery may only sub-delegate to collectors
    error DepthExceeded();
    error TtlEscalation(); // sub-delegation cannot outlive its parent (T13)
    error DelegationExpired();

    constructor(IIdentityRegistry identityRegistry) {
        identity = identityRegistry;
        admin = msg.sender;
    }

    // ---------------------------------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------------------------------

    function setGovernance(address gov) external {
        if (msg.sender != admin) revert NotAdmin();
        if (governance != address(0)) revert GovernanceAlreadySet();
        governance = gov;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier onlyRole(IIdentityRegistry.Role role) {
        if (!identity.hasActiveRole(msg.sender, role)) revert Unauthorized();
        _;
    }

    function _key(string calldata assetId) internal pure returns (bytes32) {
        return keccak256(bytes(assetId));
    }

    function _load(bytes32 key) internal view returns (Artwork storage) {
        if (!_exists[key]) revert UnknownAsset();
        return _artworks[key];
    }

    // ---------------------------------------------------------------------------------------------
    // Phase 1 — Genesis & Initialization (ARTIST_ROLE only) — mitigates Unauthorized Init (T08)
    // ---------------------------------------------------------------------------------------------

    function initializeArtwork(
        string calldata assetId,
        string calldata artworkDataCid,
        uint256 declaredValue,
        bytes32[] calldata compoundIds
    ) external onlyRole(IIdentityRegistry.Role.ARTIST) {
        bytes32 key = _key(assetId);
        if (_exists[key]) revert AssetExists();

        Artwork storage a = _artworks[key];
        a.assetId = assetId;
        a.artist = msg.sender;
        a.currentOwner = msg.sender;
        a.artworkDataCid = artworkDataCid;
        a.status = Status.PENDING_VALIDATION;
        a.prevStatus = Status.PENDING_VALIDATION;
        a.lastUpdated = block.timestamp;
        a.declaredValue = declaredValue;

        _compoundIds[key] = compoundIds;
        _exists[key] = true;

        emit ArtworkInitialized(key, assetId, msg.sender, artworkDataCid);
    }

    // ---------------------------------------------------------------------------------------------
    // Phase 2 — Automatic Technical Certification against the active policy (no per-artwork vote)
    // ---------------------------------------------------------------------------------------------

    /**
     * @notice Deterministically certifies a PENDING asset iff it satisfies the active policy.
     * @param aicaSignature AICA attestation bound to (assetId, cid); stored as certification proof.
     * @dev `CERTIFIED` is reached automatically — the AICA does not vote per-artwork; it only governs
     *      the policy. Anyone can trigger the evaluation; the on-chain check is the gate.
     */
    function requestCertification(string calldata assetId, bytes calldata aicaSignature) external {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (a.status != Status.PENDING_VALIDATION) revert BadState();
        if (!_satisfiesPolicy(key, a.declaredValue)) revert PolicyNotMet();

        a.aicaSignature = aicaSignature;
        a.status = Status.CERTIFIED;
        a.prevStatus = Status.CERTIFIED;
        a.lastUpdated = block.timestamp;
        emit ArtworkCertified(key, policyVersion);
    }

    function _satisfiesPolicy(bytes32 key, uint256 declaredValue) internal view returns (bool) {
        if (declaredValue < policyMinDeclaredValue) return false;
        bytes32[] storage ids = _compoundIds[key];
        for (uint256 i = 0; i < ids.length; i++) {
            if (disallowedCompound[ids[i]]) return false;
        }
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // Policy management (governance cross-contract call)
    // ---------------------------------------------------------------------------------------------

    function setPolicy(uint256 minDeclaredValue, bytes32[] calldata disallowedCompounds)
        external
        onlyGovernance
    {
        // clear previous disallow-set
        for (uint256 i = 0; i < _disallowedList.length; i++) {
            disallowedCompound[_disallowedList[i]] = false;
        }
        delete _disallowedList;

        policyMinDeclaredValue = minDeclaredValue;
        for (uint256 i = 0; i < disallowedCompounds.length; i++) {
            disallowedCompound[disallowedCompounds[i]] = true;
            _disallowedList.push(disallowedCompounds[i]);
        }
        policyVersion += 1;
        emit PolicyUpdated(policyVersion, minDeclaredValue, disallowedCompounds.length);
    }

    // ---------------------------------------------------------------------------------------------
    // Delegation — asymmetric dRBAC, anti-loop, TTL, cascading revocation (WP2 §3.4.3/§3.4.4)
    // ---------------------------------------------------------------------------------------------

    /// @notice Primary delegation by the sovereign owner to a Gallery or a Collector (DR.1).
    function delegatePrimary(string calldata assetId, address to, uint256 ttlSeconds) external {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (msg.sender != a.currentOwner) revert Unauthorized();
        if (a.status != Status.CERTIFIED) revert BadState();
        bool ok = identity.hasActiveRole(to, IIdentityRegistry.Role.GALLERY) ||
            identity.hasActiveRole(to, IIdentityRegistry.Role.COLLECTOR);
        if (!ok) revert Unauthorized();

        delete _chains[key];
        uint256 expiry = block.timestamp + ttlSeconds;
        _chains[key].push(Delegation({delegate: to, expiry: expiry, depth: 1, active: true}));
        a.status = Status.DELEGATED;
        a.lastUpdated = block.timestamp;
        emit DelegationGranted(key, to, 1, expiry);
    }

    /**
     * @notice Sub-delegation by a Gallery custodian. Asymmetric rule: a Gallery may sub-delegate
     *         ONLY to a Collector (rejects other Galleries) to prevent inter-gallery loops.
     *         Depth is capped at 2 and the child TTL may not exceed the parent TTL (anti-T13).
     */
    function subDelegate(string calldata assetId, address to, uint256 ttlSeconds) external {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (a.status != Status.DELEGATED) revert BadState();

        Delegation[] storage chain = _chains[key];
        if (chain.length == 0) revert Unauthorized();

        Delegation storage parent = chain[chain.length - 1];
        // caller must be the active, unexpired primary delegate AND hold the GALLERY role
        if (parent.delegate != msg.sender || !parent.active) revert Unauthorized();
        if (block.timestamp > parent.expiry) revert DelegationExpired();
        if (!identity.hasActiveRole(msg.sender, IIdentityRegistry.Role.GALLERY)) revert Unauthorized();

        if (parent.depth >= MAX_DELEGATION_DEPTH) revert DepthExceeded();
        // anti-loop: galleries can only route downstream to collectors
        if (!identity.hasActiveRole(to, IIdentityRegistry.Role.COLLECTOR)) revert AntiLoop();

        uint256 expiry = block.timestamp + ttlSeconds;
        if (expiry > parent.expiry) revert TtlEscalation();

        chain.push(Delegation({delegate: to, expiry: expiry, depth: parent.depth + 1, active: true}));
        emit DelegationGranted(key, to, parent.depth + 1, expiry);
    }

    /// @notice Unilateral owner revocation — cascades down the whole chain instantly (DR.3).
    function revokeDelegation(string calldata assetId) external {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (msg.sender != a.currentOwner) revert Unauthorized();
        if (a.status != Status.DELEGATED) revert BadState();

        delete _chains[key]; // wiping the parental link voids every downstream sub-delegation
        a.status = Status.CERTIFIED;
        a.lastUpdated = block.timestamp;
        emit DelegationRevoked(key, msg.sender);
    }

    /**
     * @notice Runtime authorization check for a delegate action. Returns true only if `who` holds an
     *         active delegation AND every ancestor link up the chain is still active and unexpired —
     *         this is what makes cascading revocation and parent-TTL expiry effective at runtime.
     */
    function isDelegateAuthorized(string calldata assetId, address who) public view returns (bool) {
        bytes32 key = _key(assetId);
        if (!_exists[key]) return false;
        Delegation[] storage chain = _chains[key];
        for (uint256 i = 0; i < chain.length; i++) {
            if (chain[i].delegate == who) {
                for (uint256 j = 0; j <= i; j++) {
                    if (!chain[j].active || block.timestamp > chain[j].expiry) return false;
                }
                return true;
            }
        }
        return false;
    }

    /// @notice Example scoped delegate action (e.g. record an exhibition). DR.5: delegates can only
    ///         act within scope — they cannot initiate a sale (no ownership mutation here).
    function exerciseDelegation(string calldata assetId) external view returns (bool) {
        if (!isDelegateAuthorized(assetId, msg.sender)) revert Unauthorized();
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // Ownership transfer — lock-and-release (defeats Double Transfer T03)
    // ---------------------------------------------------------------------------------------------

    function initiateTransfer(string calldata assetId, address buyer) external {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (msg.sender != a.currentOwner) revert Unauthorized(); // DR.5: delegates cannot sell
        if (a.status != Status.CERTIFIED) revert BadState(); // already locked → 2nd transfer reverts
        bool ok = identity.hasActiveRole(buyer, IIdentityRegistry.Role.COLLECTOR) ||
            identity.hasActiveRole(buyer, IIdentityRegistry.Role.GALLERY);
        if (!ok) revert Unauthorized();

        a.status = Status.LOCKED_FOR_SALE;
        a.lastUpdated = block.timestamp;
        pendingBuyer[key] = buyer;
        emit TransferInitiated(key, msg.sender, buyer);
    }

    function finalizeTransfer(string calldata assetId) external {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (a.status != Status.LOCKED_FOR_SALE) revert BadState();
        address buyer = pendingBuyer[key];
        if (msg.sender != a.currentOwner && msg.sender != buyer) revert Unauthorized();

        a.currentOwner = buyer;
        a.status = Status.CERTIFIED;
        a.lastUpdated = block.timestamp;
        delete pendingBuyer[key];
        delete _chains[key]; // any prior delegation does not survive a title change
        emit TransferFinalized(key, buyer);
    }

    function cancelTransfer(string calldata assetId) external {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (a.status != Status.LOCKED_FOR_SALE) revert BadState();
        if (msg.sender != a.currentOwner) revert Unauthorized();
        a.status = Status.CERTIFIED;
        a.lastUpdated = block.timestamp;
        delete pendingBuyer[key];
    }

    // ---------------------------------------------------------------------------------------------
    // Emergency freeze (TPC) and terminal revocation (Governance)
    // ---------------------------------------------------------------------------------------------

    /// @notice Institutional Emergency Freeze — only the Nucleo TPC (E06) may invoke it.
    function freeze(string calldata assetId) external onlyRole(IIdentityRegistry.Role.TPC) {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (
            a.status != Status.CERTIFIED &&
            a.status != Status.DELEGATED &&
            a.status != Status.LOCKED_FOR_SALE
        ) revert BadState();
        a.prevStatus = a.status;
        a.status = Status.FROZEN;
        a.lastUpdated = block.timestamp;
        emit AssetFrozen(key, msg.sender);
    }

    /// @notice Automatic freeze triggered by the AICA contract upon a TPC fraud notification.
    ///         Idempotent: if the asset is already frozen this is a no-op.
    function governanceFreeze(string calldata assetId) external onlyGovernance {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (a.status == Status.FROZEN) return;
        if (
            a.status != Status.CERTIFIED &&
            a.status != Status.DELEGATED &&
            a.status != Status.LOCKED_FOR_SALE
        ) revert BadState();
        a.prevStatus = a.status;
        a.status = Status.FROZEN;
        a.lastUpdated = block.timestamp;
        emit AssetFrozen(key, msg.sender);
    }

    /// @notice Alert Rejected — TPC lifts the freeze, returning the asset to CERTIFIED (FSM §3.5.1.2).
    function unfreeze(string calldata assetId) external onlyRole(IIdentityRegistry.Role.TPC) {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (a.status != Status.FROZEN) revert BadState();
        a.status = Status.CERTIFIED;
        a.lastUpdated = block.timestamp;
        emit AssetUnfrozen(key);
    }

    /// @notice Terminal revocation — reachable ONLY through an approved Emergency Revocation Proposal.
    function governanceRevoke(string calldata assetId) external onlyGovernance {
        bytes32 key = _key(assetId);
        Artwork storage a = _load(key);
        if (a.status == Status.REVOKED || a.status == Status.NONE) revert BadState();
        a.status = Status.REVOKED; // terminal dead-end; ledger log preserved as evidence
        a.lastUpdated = block.timestamp;
        emit AssetRevoked(key);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function ownerOf(string calldata assetId) external view returns (address) {
        return _load(_key(assetId)).currentOwner;
    }

    function statusOf(string calldata assetId) external view returns (Status) {
        return _load(_key(assetId)).status;
    }

    function cidOf(string calldata assetId) external view returns (string memory) {
        return _load(_key(assetId)).artworkDataCid;
    }

    function getArtwork(string calldata assetId)
        external
        view
        returns (
            address artist,
            address currentOwner,
            string memory artworkDataCid,
            Status status,
            uint256 lastUpdated,
            uint256 declaredValue
        )
    {
        Artwork storage a = _load(_key(assetId));
        return (a.artist, a.currentOwner, a.artworkDataCid, a.status, a.lastUpdated, a.declaredValue);
    }

    function delegationChain(string calldata assetId) external view returns (Delegation[] memory) {
        return _chains[_key(assetId)];
    }
}
