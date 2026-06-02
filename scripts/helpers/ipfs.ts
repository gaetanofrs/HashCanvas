/**
 * Programmatic IPFS integration via a local Helia node (WP4 §5.1).
 *
 * Helia ships as ESM only; Hardhat scripts/tests transpile to CommonJS, so the ESM modules are
 * pulled in through dynamic `import()` (supported natively on Node 18+/22). The node is backed by an
 * in-memory blockstore — no daemon, no network — which mirrors the "Private IPFS Cluster" isolated
 * from the public web (WP2 §3.1.4) and is perfect for deterministic tests/simulation.
 */
import { createHash } from "node:crypto";

/**
 * Genuine dynamic ESM import that survives TypeScript's CommonJS downleveling.
 * (A plain `import()` would be transpiled to `require()`, which the ESM-only Helia packages reject.)
 */
const esmImport: (specifier: string) => Promise<any> = new Function(
  "specifier",
  "return import(specifier)"
) as any;

export interface HeliaCtx {
  helia: any; // Helia instance
  json: any; // @helia/json client
  fs: any; // @helia/unixfs client (raw binary files: TIFF / DICOM)
  stop: () => Promise<void>;
}

/** Boot an in-memory Helia node with JSON-LD and UnixFS clients. */
export async function createHeliaNode(): Promise<HeliaCtx> {
  const { createHelia } = await esmImport("helia");
  const { json } = await esmImport("@helia/json");
  const { unixfs } = await esmImport("@helia/unixfs");
  const { MemoryBlockstore } = await esmImport("blockstore-core");

  // start:false → no libp2p networking is brought up. Local content-addressed add/get only need the
  // blockstore, and skipping libp2p avoids lingering timers that would keep the Node process alive.
  const helia = await createHelia({
    blockstore: new MemoryBlockstore(),
    start: false,
  });

  return {
    helia,
    json: json(helia),
    fs: unixfs(helia),
    stop: async () => {
      await helia.stop();
    },
  };
}

/** Add a JSON(-LD) object to Helia; returns the immutable CID string anchored on-chain. */
export async function addJson(ctx: HeliaCtx, obj: unknown): Promise<string> {
  const cid = await ctx.json.add(obj);
  return cid.toString();
}

/** Resolve a JSON(-LD) object back from its CID. */
export async function getJson<T = any>(ctx: HeliaCtx, cidStr: string): Promise<T> {
  const { CID } = await esmImport("multiformats/cid");
  return (await ctx.json.get(CID.parse(cidStr))) as T;
}

/** Add a raw binary file (e.g. TIFF / DICOM) to Helia; returns its UnixFS CID string. */
export async function addBytes(ctx: HeliaCtx, bytes: Uint8Array): Promise<string> {
  const cid = await ctx.fs.addBytes(bytes);
  return cid.toString();
}

/** Read a raw binary file back from its CID into a single Uint8Array. */
export async function getBytes(ctx: HeliaCtx, cidStr: string): Promise<Uint8Array> {
  const { CID } = await esmImport("multiformats/cid");
  const chunks: Uint8Array[] = [];
  for await (const chunk of ctx.fs.cat(CID.parse(cidStr))) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 64-char SHA-256 hex fingerprint of raw bytes (matches the manifest `sha256` fields). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
