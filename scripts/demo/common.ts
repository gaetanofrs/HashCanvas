/**
 * Utility condivise per le demo interattive (scenario1/2/3).
 * Prompt da console: INVIO per procedere, s/n per confermare, scelte numeriche.
 * Se lo stdin non è interattivo (es. output rediretto) le scelte vengono auto-confermate.
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployStack, onboard, hashVote, Role } from "../helpers/deploy";

const rl = readline.createInterface({ input: stdin, output: stdout });
const interactive = Boolean(stdin.isTTY);

export const STATUS_NAME = [
  "NONE",
  "PENDING_VALIDATION",
  "CERTIFIED",
  "LOCKED_FOR_SALE",
  "DELEGATED",
  "FROZEN",
  "REVOKED",
];

export const COMMIT = 60;
export const REVEAL = 60;

export function title(t: string) {
  console.log(`\n${"═".repeat(64)}\n  ${t}\n${"═".repeat(64)}`);
}

export function step(n: number, t: string) {
  console.log(`\n── Step ${n} ─ ${t}`);
}

export function info(msg: string) {
  console.log(`   ${msg}`);
}

/** Attende INVIO prima di eseguire l'azione descritta. */
export async function pause(action: string): Promise<void> {
  if (!interactive) {
    console.log(`\n▶  ${action}`);
    return;
  }
  await rl.question(`\n▶  Premi INVIO per ${action}…`);
}

/** Domanda s/n. Ritorna true se l'utente conferma. */
export async function confirm(question: string): Promise<boolean> {
  if (!interactive) {
    console.log(`\n❓ ${question} → (auto: SÌ)`);
    return true;
  }
  const ans = (await rl.question(`\n❓ ${question} (s/n) `)).trim().toLowerCase();
  return ans === "s" || ans === "si" || ans === "sì" || ans === "y";
}

/** Menu numerato. Ritorna l'indice (0-based) dell'opzione scelta. */
export async function choose(question: string, options: string[]): Promise<number> {
  console.log(`\n❓ ${question}`);
  options.forEach((o, i) => console.log(`   ${i + 1}) ${o}`));
  if (!interactive) {
    console.log(`   → (auto: 1)`);
    return 0;
  }
  while (true) {
    const ans = (await rl.question(`   Scelta [1-${options.length}]: `)).trim();
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    console.log("   Valore non valido, riprova.");
  }
}

export async function showStatus(lifecycle: any, assetId: string): Promise<void> {
  const s = Number(await lifecycle.statusOf(assetId));
  console.log(`   → stato asset: ${STATUS_NAME[s]}`);
}

export function done(): void {
  rl.close();
}

/**
 * Cast standard di attori già onboardati + 3 critici AICA whitelisted e dotati di reputazione.
 * commitDuration/revealDuration brevi per rendere le demo scorrevoli.
 */
export async function bootstrap() {
  const [mic, artist, gallery, gallery2, collector1, collector2, tpc, c1, c2, c3] =
    await ethers.getSigners();
  const stack = await deployStack(mic, { commitDuration: COMMIT, revealDuration: REVEAL });
  const { identity, sbt, governance } = stack;

  await onboard(identity, mic, artist, Role.ARTIST, "did:hashcanvas:artist:gaetano");
  await onboard(identity, mic, gallery, Role.GALLERY, "did:hashcanvas:gallery:uffizi");
  await onboard(identity, mic, gallery2, Role.GALLERY, "did:hashcanvas:gallery:brera");
  await onboard(identity, mic, collector1, Role.COLLECTOR, "did:hashcanvas:collector:alpha");
  await onboard(identity, mic, collector2, Role.COLLECTOR, "did:hashcanvas:collector:beta");
  await onboard(identity, mic, tpc, Role.TPC, "did:hashcanvas:tpc:nucleo");

  const critics = [c1, c2, c3];
  for (const c of critics) await governance.setCritic(c.address, true);
  await sbt.mint(c1.address, ethers.parseEther("10"));
  await sbt.mint(c2.address, ethers.parseEther("7"));
  await sbt.mint(c3.address, ethers.parseEther("4"));

  return {
    ...stack,
    actors: { mic, artist, gallery, gallery2, collector1, collector2, tpc },
    critics,
  };
}

/**
 * Esegue un'intera proposta di governance AICA in commit-reveal con l'esito di voto indicato.
 * support: 1 = FOR, 2 = AGAINST. Tutti i 3 critici partecipano (quorum 51% raggiunto).
 */
export async function runProposal(governance: any, id: bigint, critics: any[], support: number) {
  const salt = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(`salt:${s}:${id}`));
  for (const c of critics) {
    await governance.connect(c).commitVote(id, hashVote(support, salt(c.address), c.address, id));
  }
  await time.increase(COMMIT + 1); // → fase REVEAL
  for (const c of critics) {
    await governance.connect(c).revealVote(id, support, salt(c.address));
  }
  await time.increase(REVEAL + 1); // → CHIUSA
  await governance.execute(id);
}
