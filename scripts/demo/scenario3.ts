/**
 * DEMO 3 — Vigilanza del Nucleo TPC.
 * Il TPC rileva una manomissione off-chain (hash mismatch vs CID immutabile), congela l'asset,
 * e attiva una proposta di revoca d'emergenza votata dall'AICA in commit-reveal.
 *
 *   npx hardhat run scripts/demo/scenario3.ts
 */
import { ethers } from "hardhat";
import { compoundHash, Status } from "../helpers/deploy";
import { createHeliaNode, sha256Hex } from "../helpers/ipfs";
import { buildManifest } from "../helpers/manifest";
import {
  bootstrap,
  runProposal,
  title,
  step,
  info,
  pause,
  confirm,
  choose,
  showStatus,
  done,
} from "./common";

const ASSET = "urn:uuid:tpc-demo-0001";

async function main() {
  title("DEMO 3 · Il TPC rileva un illecito → FROZEN → revoca AICA");

  const { identity, lifecycle, governance, actors, critics } = await bootstrap();
  const { mic, artist, tpc } = actors;

  // Preparazione: opera creata, ancorata su IPFS e certificata.
  const ctx = await createHeliaNode();
  const built = await buildManifest(ctx, { artistDid: "did:hashcanvas:artist:gaetano", value: 150 });
  const compounds = built.manifest.realizationMaterials.map((m: any) => compoundHash(m.compoundId));
  await lifecycle.connect(artist).initializeArtwork(ASSET, built.cid, 150, compounds);
  const aicaSig = await mic.signMessage(ethers.toUtf8Bytes(`aica-cert:${ASSET}`));
  await lifecycle.connect(artist).requestCertification(ASSET, aicaSig);
  info("Setup: opera CERTIFIED, manifest ancorato su IPFS. Detentore = Artista.");

  // ---- Step 1: audit di integrità del TPC ----------------------------------------------------
  step(1, "Il TPC verifica l'integrità del file forense (radiografia DICOM)");
  info("Il TPC ricalcola lo SHA-256 del file off-chain e lo confronta con l'hash nel manifest.");
  await pause("eseguire il controllo di integrità");

  const expected = built.xrayRadiographyScan.sha256;
  const tampered = Uint8Array.from(built.xrayRadiographyScan.bytes);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01; // un bit alterato off-chain
  const recomputed = sha256Hex(tampered);
  info(`hash atteso    = ${expected.slice(0, 24)}…`);
  info(`hash ricalcolato = ${recomputed.slice(0, 24)}…`);
  info(`manomissione rilevata = ${recomputed !== expected}`);

  // ---- Step 2: notifica di frode → freeze automatico -----------------------------------------
  step(2, "Il TPC notifica la frode all'AICA (freeze automatico on-chain)");
  info("Il TPC non congela manualmente: invia la notifica allo smart contract AICA, che");
  info("apre la proposta di revoca e congela AUTOMATICAMENTE l'asset alla ricezione dell'alert.");
  if (!(await confirm("Il TPC invia la notifica di frode all'AICA?"))) {
    info("Nessuna notifica inviata. Demo terminata.");
    await ctx.stop();
    return;
  }
  const maliciousActor = await lifecycle.ownerOf(ASSET);
  await governance.connect(tpc).proposeEmergencyRevocation(ASSET, maliciousActor);
  const id = await governance.proposalCount();
  await showStatus(lifecycle, ASSET);
  info(`Asset congelato automaticamente dal contratto AICA. Proposta #${id} aperta.`);
  info("I critici ora votano in commit-reveal (voto cieco).");

  // ---- Step 3: esito del voto AICA -----------------------------------------------------------
  step(3, "Voto dell'AICA sulla revoca");

  const outcome = await choose("Qual è l'esito del voto dei critici AICA?", [
    "Revoca CONFERMATA (i critici votano FOR)",
    "Alert RESPINTO (i critici votano AGAINST)",
  ]);

  if (outcome === 0) {
    await runProposal(governance, id, critics, 1 /* FOR */);
    info("Quorum raggiunto e maggioranza a favore: revoca eseguita.");
    await showStatus(lifecycle, ASSET);
    info(`Asset REVOKED = ${Number(await lifecycle.statusOf(ASSET)) === Status.REVOKED} (stato terminale).`);
    info(`Strike sul detentore = ${await identity.strikesOf(maliciousActor)} (verso il 3-strikes).`);
  } else {
    await runProposal(governance, id, critics, 2 /* AGAINST */);
    info("Maggioranza contraria: la revoca NON viene eseguita.");
    await pause("far revocare il freeze dal TPC (alert respinto)");
    await lifecycle.connect(tpc).unfreeze(ASSET);
    await showStatus(lifecycle, ASSET);
    info("Asset riportato a CERTIFIED: torna operativo sul mercato.");
  }

  await ctx.stop();
  console.log("\n✅ Demo 3 completata.");
}

main()
  .then(() => {
    done();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    done();
    process.exit(1);
  });
