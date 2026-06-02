import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployStack, onboard, hashVote, compoundHash, Role, Status } from "../scripts/helpers/deploy";

const CID = "QmManifestCidExampleForTests000000000000000000";
const ASSET = "urn:uuid:6c9b33a1-2851-4b1e-962a-7bf439019284";

async function setup() {
  const [mic, artist, buyer, tpc, gallery] = await ethers.getSigners();
  const stack = await deployStack(mic);
  await onboard(stack.identity, mic, artist, Role.ARTIST, "did:hashcanvas:artist");
  await onboard(stack.identity, mic, buyer, Role.COLLECTOR, "did:hashcanvas:collector");
  await onboard(stack.identity, mic, tpc, Role.TPC, "did:hashcanvas:tpc");
  await onboard(stack.identity, mic, gallery, Role.GALLERY, "did:hashcanvas:gallery");
  return { ...stack, artist, buyer, tpc, gallery };
}

describe("ArtworkLifecycle — Finite State Machine", () => {
  it("only an Artist can initialize a Digital Twin (mitigates T08)", async () => {
    const { lifecycle, buyer } = await setup();
    await expect(
      lifecycle.connect(buyer).initializeArtwork(ASSET, CID, 150, [])
    ).to.be.revertedWithCustomError(lifecycle, "Unauthorized");
  });

  it("transitions PENDING_VALIDATION → CERTIFIED automatically against the active policy", async () => {
    const { lifecycle, artist } = await setup();
    await lifecycle.connect(artist).initializeArtwork(ASSET, CID, 150, [compoundHash("Ultramarine_PB29")]);
    expect(await lifecycle.statusOf(ASSET)).to.equal(Status.PENDING_VALIDATION);

    await lifecycle.connect(artist).requestCertification(ASSET, "0x1234");
    expect(await lifecycle.statusOf(ASSET)).to.equal(Status.CERTIFIED);
  });

  it("rejects certification when the asset violates the active policy (min value + banned compound)", async () => {
    const { lifecycle, governance, sbt, mic, artist } = await setup();
    const [, , , , , c1, c2] = await ethers.getSigners();

    // Stand up a minimal AICA quorum and push a stricter policy through commit-reveal.
    for (const c of [c1, c2]) await governance.setCritic(c.address, true);
    await sbt.mint(c1.address, ethers.parseEther("10"));
    await sbt.mint(c2.address, ethers.parseEther("10"));

    const banned = compoundHash("Counterfeit_Pigment_X");
    await governance.connect(c1).proposePolicyUpdate(1000, [banned]);
    const id = await governance.proposalCount();
    const slt = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
    for (const c of [c1, c2]) await governance.connect(c).commitVote(id, hashVote(1, slt(c.address), c.address, id));
    await time.increase(3601);
    for (const c of [c1, c2]) await governance.connect(c).revealVote(id, 1, slt(c.address));
    await time.increase(3601);
    await governance.execute(id);
    expect(await lifecycle.policyMinDeclaredValue()).to.equal(1000);

    // declaredValue 150 < 1000 → certification must fail.
    await lifecycle.connect(artist).initializeArtwork(ASSET, CID, 150, []);
    await expect(
      lifecycle.connect(artist).requestCertification(ASSET, "0x")
    ).to.be.revertedWithCustomError(lifecycle, "PolicyNotMet");

    // A compliant asset (value ≥ 1000, no banned compound) certifies fine.
    const ASSET2 = "urn:uuid:compliant-asset";
    await lifecycle.connect(artist).initializeArtwork(ASSET2, CID, 2000, [compoundHash("Ultramarine_PB29")]);
    await lifecycle.connect(artist).requestCertification(ASSET2, "0x");
    expect(await lifecycle.statusOf(ASSET2)).to.equal(Status.CERTIFIED);

    // ...but a compliant value with a banned compound is still rejected.
    const ASSET3 = "urn:uuid:banned-compound-asset";
    await lifecycle.connect(artist).initializeArtwork(ASSET3, CID, 2000, [banned]);
    await expect(
      lifecycle.connect(artist).requestCertification(ASSET3, "0x")
    ).to.be.revertedWithCustomError(lifecycle, "PolicyNotMet");
  });

  it("executes a lock-and-release transfer and blocks Double Transfer (T03)", async () => {
    const { lifecycle, artist, buyer, gallery } = await setup();
    await lifecycle.connect(artist).initializeArtwork(ASSET, CID, 150, []);
    await lifecycle.connect(artist).requestCertification(ASSET, "0x");

    await lifecycle.connect(artist).initiateTransfer(ASSET, buyer.address);
    expect(await lifecycle.statusOf(ASSET)).to.equal(Status.LOCKED_FOR_SALE);

    // Second concurrent transfer to a different buyer must revert (asset is locked).
    await expect(
      lifecycle.connect(artist).initiateTransfer(ASSET, gallery.address)
    ).to.be.revertedWithCustomError(lifecycle, "BadState");

    await lifecycle.connect(buyer).finalizeTransfer(ASSET);
    expect(await lifecycle.statusOf(ASSET)).to.equal(Status.CERTIFIED);
    expect(await lifecycle.ownerOf(ASSET)).to.equal(buyer.address);
  });

  it("lets only the TPC freeze/unfreeze, and only governance revoke", async () => {
    const { lifecycle, artist, tpc, buyer } = await setup();
    await lifecycle.connect(artist).initializeArtwork(ASSET, CID, 150, []);
    await lifecycle.connect(artist).requestCertification(ASSET, "0x");

    await expect(lifecycle.connect(buyer).freeze(ASSET)).to.be.revertedWithCustomError(
      lifecycle,
      "Unauthorized"
    );

    await lifecycle.connect(tpc).freeze(ASSET);
    expect(await lifecycle.statusOf(ASSET)).to.equal(Status.FROZEN);

    await lifecycle.connect(tpc).unfreeze(ASSET);
    expect(await lifecycle.statusOf(ASSET)).to.equal(Status.CERTIFIED);

    // Terminal REVOKED is reachable only through the governance contract.
    await expect(
      lifecycle.connect(tpc).governanceRevoke(ASSET)
    ).to.be.revertedWithCustomError(lifecycle, "NotGovernance");
  });
});
