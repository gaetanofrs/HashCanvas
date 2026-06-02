# HashCanvas — Decentralized Artwork Lifecycle & Multi-Authority Governance

Reference implementation of the WP2 (System Design) and WP4 (Implementation) modules of
**Blockchains PW-04**: a permissioned EVM platform that turns physical artworks into immutable
"Digital Twins" governed by independent organizational authorities (MIC, AICA, TPC) with a
private IPFS off-chain layer.

## Stack

- **Solidity 0.8.24**, EVM **Paris** target, optimizer enabled.
- **OpenZeppelin Contracts 5.1.0** (ERC20 / ECDSA / MessageHashUtils — pinned because OZ ≥ 5.2 uses
  the Cancun-only `mcopy` opcode, incompatible with the Paris target).
- **Hardhat** + TypeScript (Chai/Mocha).
- **Helia** in-process IPFS node (`helia`, `@helia/json`, `@helia/unixfs`) for off-chain storage.

## Smart contracts (`contracts/`)

| Contract | Role |
| --- | --- |
| `IdentityRegistry.sol` | SSI Trust Triangle. MIC-signed Verifiable Credential verification (Issuer + Subject-Signer validation → defeats MitM **T12**), Privacy-by-Design (`identityCommitmentSha256`). Identity revocation happens **only** through deterministic **3-Strikes** enforcement (no manual admin revoke). |
| `ReputationSBT.sol` | Non-transferable Soulbound ERC-20 (transfer/approve disabled) used as AICA voting weight; immune to flash-loan / vote-buying. |
| `ArtworkLifecycle.sol` | Dual-Storage Digital Twin with an **immutable** `artworkDataCid` (anchored once at genesis, never updatable), 6-state **FSM**, automatic policy-based certification, asymmetric dRBAC delegation (anti-loop, depth ≤ 2, TTL, **cascading revocation**), lock-and-release transfer (defeats Double Transfer **T03**). Freeze on a TPC fraud notification is applied automatically by the Governance contract; terminal `REVOKED` is reachable only via an approved Emergency Revocation. |
| `AICAGovernance.sol` | Governor-pattern DAO with **commit-reveal** blind voting, **hybrid quorum** (51% heads + SBT weight), two proposal types (Policy Update / Emergency Revocation), synchronous reward minting, cross-contract execution. On a TPC notification it **auto-freezes** the target asset, then drives it to `REVOKED` and applies a fraud strike if the vote approves. |

### Design note — Governor

`AICAGovernance` follows OpenZeppelin's modular **Governor pattern** (proposal lifecycle, weighted
counting, quorum, execution) but does not literally inherit `Governor`. OZ's
`castVote(proposalId, support)` discloses the choice at cast time, which is fundamentally
incompatible with the required **Two-Phase Blind (Commit-Reveal)** protocol and the heads-based
quorum. The voting surface is therefore reimplemented as `commitVote` / `revealVote`.

### Design note — Reentrancy

No `ReentrancyGuard` is used; protection relies on the **checks-effects-interactions** pattern
(`execute` sets `executed` and `revealVote` sets `hasRevealed` before any external call) combined
with the absence of ETH/token transfers (sales settle off-chain, the SBT is non-transferable) and
the fact that the only external callees are trusted in-system contracts.

## Off-chain (`scripts/helpers/`)

- `ipfs.ts` — boots an in-memory Helia node, adds/reads JSON-LD manifests and raw binary files
  (TIFF/DICOM), computes SHA-256 fingerprints.
- `manifest.ts` — builds the exact WP4 §5.1.1.2 JSON-LD manifest (`supportMaterialAnalysis`,
  `colorPaletteHistogram`, `realizationMaterials`, `diagnosticAssets` with sub-CIDs + SHA-256).
- `deploy.ts` — deploys & wires the suite, onboards holders, vote/compound hashing helpers.

## Commands

```bash
npm install
npm run build                 # hardhat compile
npm test                      # 23 tests across SSI/T12, governance, FSM, delegation
REPORT_GAS=true npm test      # same tests, with the gas report
npm run simulate              # full end-to-end lifecycle (scripts/simulate.ts)
npm run demo:1                # interactive demo — lifecycle (create → certify → sale)
npm run demo:2                # interactive demo — delegation chain & cascading revocation
npm run demo:3                # interactive demo — TPC fraud detection → freeze → AICA revocation
```

## Interactive demos (`scripts/demo/`)

Three step-by-step scenarios that prompt for input (ENTER to proceed, `s/n` to confirm, numeric
choices). When stdin is non-interactive the choices auto-confirm, so they also run unattended.

1. **scenario1** — Creation → validation → off-chain sale with on-chain lock-and-release transfer.
2. **scenario2** — Primary delegation, asymmetric sub-delegation, anti-loop enforcement, cascading
   revocation.
3. **scenario3** — TPC integrity audit detects a tampered DICOM, the notification **auto-freezes**
   the asset, and the AICA votes (FOR → `REVOKED` + strike / AGAINST → unfreeze → `CERTIFIED`).

## End-to-end simulation (`scripts/simulate.ts`)

1. **Onboarding** — MIC issues VCs to Artist / Gallery / 2 Collectors / TPC; AICA critics seeded.
2. **Genesis + IPFS** — Helia pins the JSON-LD manifest; CID anchored on-chain (`PENDING_VALIDATION`).
3. **Policy + Certification** — AICA commit-reveal Policy Update; asset auto-certified (`CERTIFIED`).
4. **Delegation** — Owner→Gallery, Gallery→Collector1 sub-delegation.
5. **Cascading revocation** — owner revokes primary → sub-delegation voided instantly.
6. **Sale** — lock-and-release transfer to Collector2 (`LOCKED_FOR_SALE` → `CERTIFIED`).
7. **TPC integrity alert** — a DICOM bit is flipped off-chain; SHA-256 mismatch vs the immutable
   anchor → TPC autonomously forces `FROZEN`.
8. **Emergency Revocation** — TPC files an AICA proposal (auto-freeze on notification); commit-reveal
   quorum → terminal `REVOKED` + fraud strike on the malicious actor.
