/**
 * HashCanvas — End-to-end lifecycle simulation (WP4).
 *
 * Runs the full storyline: SSI onboarding → IPFS-anchored genesis → policy update & automatic
 * certification → delegation/sub-delegation → unilateral cascading revocation → lock-and-release
 * sale → off-chain tamper detection by the TPC (freeze) → AICA emergency revocation (terminal).
 *
 *   npx hardhat run scripts/simulate.ts
 */
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployStack, onboard, hashVote, compoundHash, Role, Status } from "./helpers/deploy";
import { createHeliaNode, getJson, sha256Hex } from "./helpers/ipfs";
import { buildManifest } from "./helpers/manifest";

const COMMIT = 100;
const REVEAL = 100;
const STATUS_NAME = ["NONE", "PENDING_VALIDATION", "CERTIFIED", "LOCKED_FOR_SALE", "DELEGATED", "FROZEN", "REVOKED"];

function log(step: string, msg: string) {
  console.log(`\n=== ${step} ===\n${msg}`);
}

async function runProposal(governance: any, id: bigint, critics: any[], support: number) {
  const salt = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(`salt:${s}:${id}`));
  for (const c of critics) {
    await governance.connect(c).commitVote(id, hashVote(support, salt(c.address), c.address, id));
  }
  await time.increase(COMMIT + 1); // → REVEAL
  for (const c of critics) {
    await governance.connect(c).revealVote(id, support, salt(c.address));
  }
  await time.increase(REVEAL + 1); // → CLOSED
  await governance.execute(id);
}

async function main() {
  const [mic, artist, gallery, collector1, collector2, tpc, c1, c2, c3] = await ethers.getSigners();
  const critics = [c1, c2, c3];

  const stack = await deployStack(mic, { commitDuration: COMMIT, revealDuration: REVEAL });
  const { identity, sbt, lifecycle, governance } = stack;

  // ---------------------------------------------------------------------------------------------
  // STEP 1 — Onboarding (MIC issues VCs; holders activate on-chain)
  // ---------------------------------------------------------------------------------------------
  await onboard(identity, mic, artist, Role.ARTIST, "did:hashcanvas:artist:gaetano");
  await onboard(identity, mic, gallery, Role.GALLERY, "did:hashcanvas:gallery:uffizi");
  await onboard(identity, mic, collector1, Role.COLLECTOR, "did:hashcanvas:collector:alpha");
  await onboard(identity, mic, collector2, Role.COLLECTOR, "did:hashcanvas:collector:beta");
  await onboard(identity, mic, tpc, Role.TPC, "did:hashcanvas:tpc:nucleo");

  for (const c of critics) await governance.setCritic(c.address, true);
  await sbt.mint(c1.address, ethers.parseEther("10"));
  await sbt.mint(c2.address, ethers.parseEther("7"));
  await sbt.mint(c3.address, ethers.parseEther("4"));
  log("STEP 1 — Onboarding", `Artist/Gallery/2x Collector/TPC onboarded. 3 AICA critics whitelisted & seeded.`);

  // ---------------------------------------------------------------------------------------------
  // STEP 2 — Initialization & IPFS storage (Helia)
  // ---------------------------------------------------------------------------------------------
  const ctx = await createHeliaNode();
  const built = await buildManifest(ctx, { artistDid: "did:hashcanvas:artist:gaetano", value: 150 });
  const ASSET = "urn:uuid:6c9b33a1-2851-4b1e-962a-7bf439019284";
  const compounds = built.manifest.realizationMaterials.map((m: any) => compoundHash(m.compoundId));

  await lifecycle.connect(artist).initializeArtwork(ASSET, built.cid, 150, compounds);
  log(
    "STEP 2 — Genesis + IPFS",
    `Manifest pinned on Helia.\n  manifestCID  = ${built.cid}\n  x-ray subCID = ${built.xrayRadiographyScan.cid}\n  status       = ${STATUS_NAME[Number(await lifecycle.statusOf(ASSET))]}`
  );

  // ---------------------------------------------------------------------------------------------
  // STEP 3 — Policy Update (commit-reveal) + automatic certification
  // ---------------------------------------------------------------------------------------------
  await governance.connect(c1).proposePolicyUpdate(100, [compoundHash("Counterfeit_Pigment_X")]);
  await runProposal(governance, await governance.proposalCount(), critics, 1 /* FOR */);

  const aicaSig = await mic.signMessage(ethers.toUtf8Bytes(`aica-cert:${ASSET}`));
  await lifecycle.connect(artist).requestCertification(ASSET, aicaSig);
  log(
    "STEP 3 — Policy + Certification",
    `Policy v${await lifecycle.policyVersion()} active (minValue=${await lifecycle.policyMinDeclaredValue()}). ` +
      `Asset auto-certified → ${STATUS_NAME[Number(await lifecycle.statusOf(ASSET))]}`
  );

  // ---------------------------------------------------------------------------------------------
  // STEP 4 — Delegation & sub-delegation
  // ---------------------------------------------------------------------------------------------
  await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 30 * 24 * 3600);
  await lifecycle.connect(gallery).subDelegate(ASSET, collector1.address, 10 * 24 * 3600);
  log(
    "STEP 4 — Delegation",
    `Owner→Gallery (primary), Gallery→Collector1 (sub). ` +
      `Collector1 authorized = ${await lifecycle.isDelegateAuthorized(ASSET, collector1.address)} (status ${STATUS_NAME[Number(await lifecycle.statusOf(ASSET))]})`
  );

  // ---------------------------------------------------------------------------------------------
  // STEP 5 — Unilateral revocation (cascading)
  // ---------------------------------------------------------------------------------------------
  await lifecycle.connect(artist).revokeDelegation(ASSET);
  log(
    "STEP 5 — Cascading Revocation",
    `Owner revoked primary delegation. Collector1 authorized = ${await lifecycle.isDelegateAuthorized(ASSET, collector1.address)} ` +
      `(status ${STATUS_NAME[Number(await lifecycle.statusOf(ASSET))]})`
  );

  // ---------------------------------------------------------------------------------------------
  // STEP 6 — Sale via lock-and-release
  // ---------------------------------------------------------------------------------------------
  await lifecycle.connect(artist).initiateTransfer(ASSET, collector2.address);
  const lockedState = STATUS_NAME[Number(await lifecycle.statusOf(ASSET))];
  await lifecycle.connect(collector2).finalizeTransfer(ASSET);
  log(
    "STEP 6 — Sale (lock-and-release)",
    `LOCKED state during sale = ${lockedState}. New owner = collector2 (${(await lifecycle.ownerOf(ASSET)) === collector2.address}) ` +
      `→ ${STATUS_NAME[Number(await lifecycle.statusOf(ASSET))]}`
  );

  // ---------------------------------------------------------------------------------------------
  // STEP 7 — Off-chain tampering & TPC integrity reaction (FROZEN)
  // ---------------------------------------------------------------------------------------------
  const manifest: any = await getJson(ctx, built.cid);
  const expectedHash = manifest.diagnosticAssets.xrayRadiographyScan.sha256;
  // An adversary flips a single bit of the DICOM forensic file in the off-chain store.
  const tampered = Uint8Array.from(built.xrayRadiographyScan.bytes);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01; // flip one in-range bit of the forensic file
  const recomputed = sha256Hex(tampered);
  const mismatch = recomputed !== expectedHash;
  if (!mismatch) throw new Error("expected an integrity hash mismatch");

  // The TPC autonomous auditor detects the divergence vs the immutable on-chain anchor → freeze.
  await lifecycle.connect(tpc).freeze(ASSET);
  log(
    "STEP 7 — TPC Integrity Alert",
    `DICOM bit flipped off-chain.\n  expected sha256   = ${expectedHash.slice(0, 24)}…\n  recomputed sha256 = ${recomputed.slice(0, 24)}…\n  mismatch detected = ${mismatch} → asset FROZEN (${STATUS_NAME[Number(await lifecycle.statusOf(ASSET))]})`
  );

  // ---------------------------------------------------------------------------------------------
  // STEP 8 — Emergency Revocation Proposal (AICA) → terminal REVOKED + strike
  // ---------------------------------------------------------------------------------------------
  const maliciousActor = collector2.address; // current owner holding the compromised asset
  await governance.connect(tpc).proposeEmergencyRevocation(ASSET, maliciousActor);
  await runProposal(governance, await governance.proposalCount(), critics, 1 /* FOR */);

  log(
    "STEP 8 — Emergency Revocation",
    `AICA quorum approved revocation.\n  asset status   = ${STATUS_NAME[Number(await lifecycle.statusOf(ASSET))]}\n  actor strikes  = ${await identity.strikesOf(maliciousActor)}\n  actor active   = ${await identity.isActive(maliciousActor)}`
  );

  if (Number(await lifecycle.statusOf(ASSET)) !== Status.REVOKED) throw new Error("asset not revoked");

  await ctx.stop();
  console.log("\n✅ Simulation completed — full artwork lifecycle executed end-to-end.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
