// usage: bun run fetch-projects [id ...]
// Downloads the projects in projects/manifest.json from scratch.mit.edu into .cache/projects as sb3
// files. A project whose project.json no longer matches the manifest's sha256 was edited after it
// was recorded, so it is skipped rather than replayed against the wrong version.
import fs from "node:fs";
import zlib from "node:zlib";
import { manifest, PROJECT_FILES, projectFile } from "./projects.ts";

const UA = { "User-Agent": "scratch-bench (github.com/gradylink/scratch-bench)" };

const get = async (url: string): Promise<Uint8Array> => {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (attempt === 3 || res.status === 404) throw new Error(`${res.status} ${url}`);
    await Bun.sleep(1000 * attempt);
  }
};

const sha256 = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** A zip of deflated entries. */
const zip = (files: [string, Uint8Array][]): Uint8Array => {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = zlib.crc32(data);
    const packed = zlib.deflateRawSync(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, 8, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, packed.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, packed);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]);
};

/** project.json from an sb3 Scratch served whole (stored or deflated entries). */
const projectJsonOf = (sb3: Uint8Array): Uint8Array => {
  const view = new DataView(sb3.buffer, sb3.byteOffset, sb3.byteLength);
  for (let i = 0; i + 30 <= sb3.length && view.getUint32(i, true) === 0x04034b50;) {
    const method = view.getUint16(i + 8, true);
    const size = view.getUint32(i + 18, true);
    const nameLength = view.getUint16(i + 26, true);
    const start = i + 30 + nameLength + view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(sb3.subarray(i + 30, i + 30 + nameLength));
    const data = sb3.subarray(start, start + size);
    if (name === "project.json") return method === 8 ? zlib.inflateRawSync(data) : data;
    i = start + size;
  }
  throw new Error("no project.json in the downloaded sb3");
};

/** Written whole or not at all, so an interrupted fetch never leaves a broken sb3 behind. */
const save = (id: string, data: Uint8Array) => {
  fs.writeFileSync(`${projectFile(id)}.part`, data);
  fs.renameSync(`${projectFile(id)}.part`, projectFile(id));
};

const fetchProject = async (id: string, want: string): Promise<string> => {
  const meta = JSON.parse(
    new TextDecoder().decode(await get(`https://api.scratch.mit.edu/projects/${id}`)),
  );
  const raw = await get(`https://projects.scratch.mit.edu/${id}?token=${meta.project_token}`);
  const isZip = raw[0] === 0x50 && raw[1] === 0x4b;
  const json = isZip ? projectJsonOf(raw) : raw;
  if (sha256(json) !== want) return "changed since it was recorded, skipped";
  if (isZip) {
    save(id, raw);
    return "fetched";
  }
  const project = JSON.parse(new TextDecoder().decode(json));
  const assets = new Map<string, Uint8Array>();
  for (const target of project.targets) {
    for (const asset of [...target.costumes, ...target.sounds]) {
      const name = asset.md5ext ?? `${asset.assetId}.${asset.dataFormat}`;
      if (!assets.has(name)) {
        assets.set(
          name,
          await get(`https://assets.scratch.mit.edu/internalapi/asset/${name}/get/`),
        );
      }
    }
  }
  save(id, zip([["project.json", json], ...assets]));
  return "fetched";
};

const only = new Set(process.argv.slice(2));
const wanted = manifest().filter((p) => !only.size || only.has(p.id));
for (const id of only) {
  if (!wanted.some((p) => p.id === id)) console.log(`${id}: not in projects/manifest.json`);
}
fs.mkdirSync(PROJECT_FILES, { recursive: true });
let failed = 0;
let next = 0;
const worker = async () => {
  while (next < wanted.length) {
    const p = wanted[next++];
    if (fs.existsSync(projectFile(p.id))) continue;
    try {
      const status = await fetchProject(p.id, p.sha256);
      if (status !== "fetched") failed++;
      console.log(`${p.id} ${p.title}: ${status}`);
    } catch (e) {
      failed++;
      console.log(`${p.id} ${p.title}: ${(e as Error).message}`);
    }
  }
};
await Promise.all(Array.from({ length: 6 }, worker));
const have = wanted.filter((p) => fs.existsSync(projectFile(p.id))).length;
console.log(`${have} of ${wanted.length} projects in ${PROJECT_FILES}`);
process.exit(failed && !have ? 1 : 0);
