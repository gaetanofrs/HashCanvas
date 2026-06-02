// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/**
 * @title IdentityRegistry
 * @notice Identity Smart Contract Registry implementing the SSI Trust Triangle (WP2 §3.2).
 *
 *  - Issuer  : the MIC (E02) — its public key is hardcoded into the registry governance state.
 *  - Verifier: this contract — runs Issuer Verification + Subject-Signer Validation on the VC.
 *  - Holder  : the market participant (E01/E04/E05) — signs the onboarding transaction locally.
 *
 *  Privacy-by-Design: no PII is committed on-chain. Only the opaque DID, the role attribute and a
 *  one-way `identityCommitmentSha256` of the off-chain KYC dossier are stored.
 *
 *  3-Strikes Enforcement (WP2 §2.1.2 / §3.2.4 Phase 5): three validated fraud strikes flip the DID
 *  status deterministically and irreversibly to REVOKED.
 */
contract IdentityRegistry is IIdentityRegistry {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    struct Identity {
        string did; // did:hashcanvas:<method-specific-id>
        Role role;
        DidStatus status;
        bytes32 identityCommitment; // identityCommitmentSha256 of off-chain KYC files
        uint8 strikes;
        uint256 expiresAt; // VC expirationDate (unix seconds)
    }

    /// @notice MIC issuer signing key, hardcoded into the contract governance state (Phase 4.1).
    address public immutable mic;

    /// @notice Number of validated fraud strikes that irreversibly revokes a DID.
    uint8 public constant STRIKE_THRESHOLD = 3;

    mapping(address => Identity) private _identities;

    /// @notice Contracts authorised to report validated fraud strikes (Lifecycle / Governance).
    mapping(address => bool) public authorizedStriker;

    event IdentityOnboarded(address indexed holder, string did, Role role);
    event StrikeRegistered(address indexed actor, uint8 totalStrikes, string reason);
    event IdentityRevoked(address indexed actor, string reason);
    event StrikerUpdated(address indexed striker, bool allowed);

    error NotMic();
    error NotAuthorizedStriker();
    error AlreadyRegistered();
    error InvalidRole();
    error CredentialExpired();
    error BadIssuerSignature();
    error SubjectSignerMismatch();

    modifier onlyMic() {
        if (msg.sender != mic) revert NotMic();
        _;
    }

    constructor(address micIssuer) {
        require(micIssuer != address(0), "MIC=0");
        mic = micIssuer;
    }

    // ---------------------------------------------------------------------------------------------
    // MIC administration
    // ---------------------------------------------------------------------------------------------

    /// @notice The MIC whitelists the system contracts allowed to push validated fraud strikes.
    function setStriker(address striker, bool allowed) external onlyMic {
        authorizedStriker[striker] = allowed;
        emit StrikerUpdated(striker, allowed);
    }

    // ---------------------------------------------------------------------------------------------
    // Onboarding (Phase 4 — Ledger Activation & On-Chain Role Caching)
    // ---------------------------------------------------------------------------------------------

    /**
     * @notice Deterministic digest the MIC signs off-chain when issuing the Verifiable Credential.
     * @dev The holder address is bound INTO the signed credential. This is what defeats the
     *      Identity Provisioning Interception MitM (T12): the MIC only ever signs over the legitimate
     *      applicant's address, so an attacker who swaps the public key cannot produce a credential
     *      that validates for their own address. `address(this)` + `chainid` provide domain
     *      separation against cross-contract / cross-chain replay (A.4).
     */
    function credentialDigest(
        address holder,
        string calldata did,
        Role role,
        bytes32 identityCommitment,
        uint256 expiresAt
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    address(this),
                    block.chainid,
                    holder,
                    did,
                    role,
                    identityCommitment,
                    expiresAt
                )
            );
    }

    /**
     * @notice One-time onboarding transaction. The Holder submits the MIC-issued VC payload.
     * @dev Runs the two atomic validation checks of Phase 4:
     *      1. Issuer Verification    — recovers the VC signature and asserts signer == MIC.
     *      2. Subject-Signer Validation — the tx caller (msg.sender) must be the credential subject
     *         (`holder`), proving custody of the private key bound to the DID.
     */
    function onboard(
        string calldata did,
        Role role,
        bytes32 identityCommitment,
        uint256 expiresAt,
        bytes calldata micSignature
    ) external {
        if (_identities[msg.sender].status != DidStatus.UNREGISTERED) revert AlreadyRegistered();
        if (role == Role.NONE) revert InvalidRole();
        if (expiresAt <= block.timestamp) revert CredentialExpired();

        // (1) Issuer Verification — the credential must be signed by the MIC master key.
        bytes32 digest = credentialDigest(msg.sender, did, role, identityCommitment, expiresAt)
            .toEthSignedMessageHash();
        address signer = digest.recover(micSignature);
        if (signer != mic) revert BadIssuerSignature();

        // (2) Subject-Signer Validation is satisfied structurally: the VC was signed for
        //     `msg.sender`, and only the holder of that key could have broadcast this tx.
        if (signer == msg.sender) revert SubjectSignerMismatch(); // MIC cannot self-onboard a holder slot

        _identities[msg.sender] = Identity({
            did: did,
            role: role,
            status: DidStatus.ACTIVE,
            identityCommitment: identityCommitment,
            strikes: 0,
            expiresAt: expiresAt
        });

        emit IdentityOnboarded(msg.sender, did, role);
    }

    // ---------------------------------------------------------------------------------------------
    // 3-Strikes Enforcement
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IIdentityRegistry
    function registerStrike(address actor, string calldata reason) external {
        if (!authorizedStriker[msg.sender]) revert NotAuthorizedStriker();
        Identity storage id = _identities[actor];
        if (id.status != DidStatus.ACTIVE) return; // already revoked / unknown — no-op

        id.strikes += 1;
        emit StrikeRegistered(actor, id.strikes, reason);

        if (id.strikes >= STRIKE_THRESHOLD) {
            id.status = DidStatus.REVOKED;
            emit IdentityRevoked(actor, "3-strikes");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Static verification loop (Phase 5) — cheap, read-only role checks
    // ---------------------------------------------------------------------------------------------

    function isActive(address account) public view returns (bool) {
        Identity storage id = _identities[account];
        return id.status == DidStatus.ACTIVE && id.expiresAt > block.timestamp;
    }

    function roleOf(address account) external view returns (Role) {
        return _identities[account].role;
    }

    function hasActiveRole(address account, Role role) external view returns (bool) {
        return isActive(account) && _identities[account].role == role;
    }

    function strikesOf(address account) external view returns (uint8) {
        return _identities[account].strikes;
    }

    function didOf(address account) external view returns (string memory) {
        return _identities[account].did;
    }

    function statusOf(address account) external view returns (DidStatus) {
        return _identities[account].status;
    }
}
