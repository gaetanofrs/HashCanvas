import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployStack, onboard, Role, Status } from "../scripts/helpers/deploy";

const CID = "QmManifestCidExampleForTests000000000000000000";
const ASSET = "urn:uuid:delegation-asset";

async function setup() {
  const [mic, artist, gallery, gallery2, collector, collector2] = await ethers.getSigners();
  const stack = await deployStack(mic);
  await onboard(stack.identity, mic, artist, Role.ARTIST, "did:hashcanvas:artist");
  await onboard(stack.identity, mic, gallery, Role.GALLERY, "did:hashcanvas:gallery1");
  await onboard(stack.identity, mic, gallery2, Role.GALLERY, "did:hashcanvas:gallery2");
  await onboard(stack.identity, mic, collector, Role.COLLECTOR, "did:hashcanvas:collector1");
  await onboard(stack.identity, mic, collector2, Role.COLLECTOR, "did:hashcanvas:collector2");

  await stack.lifecycle.connect(artist).initializeArtwork(ASSET, CID, 150, []);
  await stack.lifecycle.connect(artist).requestCertification(ASSET, "0x");
  return { ...stack, artist, gallery, gallery2, collector, collector2 };
}

describe("ArtworkLifecycle — Delegation: anti-loop, TTL & cascading revocation", () => {
  it("grants a primary delegation and a gallery→collector sub-delegation", async () => {
    const { lifecycle, artist, gallery, collector } = await setup();
    await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 30 * 24 * 3600);
    expect(await lifecycle.statusOf(ASSET)).to.equal(Status.DELEGATED);

    await lifecycle.connect(gallery).subDelegate(ASSET, collector.address, 10 * 24 * 3600);
    expect(await lifecycle.isDelegateAuthorized(ASSET, collector.address)).to.equal(true);
    const chain = await lifecycle.delegationChain(ASSET);
    expect(chain.length).to.equal(2);
  });

  it("blocks inter-gallery sub-delegation loops (anti-loop)", async () => {
    const { lifecycle, artist, gallery, gallery2 } = await setup();
    await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 30 * 24 * 3600);
    await expect(
      lifecycle.connect(gallery).subDelegate(ASSET, gallery2.address, 24 * 3600)
    ).to.be.revertedWithCustomError(lifecycle, "AntiLoop");
  });

  it("caps the delegation chain at depth 2", async () => {
    const { lifecycle, artist, gallery, collector, collector2 } = await setup();
    await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 30 * 24 * 3600);
    await lifecycle.connect(gallery).subDelegate(ASSET, collector.address, 10 * 24 * 3600);
    // collector has no GALLERY role → cannot sub-delegate further (depth/role gate).
    await expect(
      lifecycle.connect(collector).subDelegate(ASSET, collector2.address, 3600)
    ).to.be.revertedWithCustomError(lifecycle, "Unauthorized");
  });

  it("prevents TTL escalation beyond the parent delegation (T13)", async () => {
    const { lifecycle, artist, gallery, collector } = await setup();
    await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 10 * 24 * 3600);
    await expect(
      lifecycle.connect(gallery).subDelegate(ASSET, collector.address, 30 * 24 * 3600)
    ).to.be.revertedWithCustomError(lifecycle, "TtlEscalation");
  });

  it("cascades a unilateral owner revocation down the whole chain", async () => {
    const { lifecycle, artist, gallery, collector } = await setup();
    await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 30 * 24 * 3600);
    await lifecycle.connect(gallery).subDelegate(ASSET, collector.address, 10 * 24 * 3600);
    expect(await lifecycle.isDelegateAuthorized(ASSET, collector.address)).to.equal(true);

    await lifecycle.connect(artist).revokeDelegation(ASSET);
    expect(await lifecycle.statusOf(ASSET)).to.equal(Status.CERTIFIED);
    expect(await lifecycle.isDelegateAuthorized(ASSET, gallery.address)).to.equal(false);
    expect(await lifecycle.isDelegateAuthorized(ASSET, collector.address)).to.equal(false);
  });

  it("expires delegations once the TTL passes (parent expiry voids the sub-delegate)", async () => {
    const { lifecycle, artist, gallery, collector } = await setup();
    await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 1000);
    await lifecycle.connect(gallery).subDelegate(ASSET, collector.address, 800);
    expect(await lifecycle.isDelegateAuthorized(ASSET, collector.address)).to.equal(true);

    await time.increase(1001);
    expect(await lifecycle.isDelegateAuthorized(ASSET, collector.address)).to.equal(false);
    expect(await lifecycle.isDelegateAuthorized(ASSET, gallery.address)).to.equal(false);
    // expired delegate can no longer exercise the delegation
    await expect(
      lifecycle.connect(collector).exerciseDelegation(ASSET)
    ).to.be.revertedWithCustomError(lifecycle, "Unauthorized");
  });

  it("forbids a delegate from initiating a sale (DR.5 scope restriction)", async () => {
    const { lifecycle, artist, gallery, collector } = await setup();
    await lifecycle.connect(artist).delegatePrimary(ASSET, gallery.address, 30 * 24 * 3600);
    await expect(
      lifecycle.connect(gallery).initiateTransfer(ASSET, collector.address)
    ).to.be.revertedWithCustomError(lifecycle, "Unauthorized");
  });
});
