import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const SCHEMA = "cueline-artifact-manifest/1";

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function isInside(parent, candidate) {
  return candidate.startsWith(`${parent}${path.sep}`);
}

export async function prepareOutputDirectory(root, requested = "release-artifacts") {
  const rootReal = await realpath(root);
  const output = path.resolve(rootReal, requested);
  if (!isInside(rootReal, output)) {
    throw new Error("artifact output must be a child directory of the repository");
  }
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) {
    throw new Error("artifact output directory must not be a symbolic link");
  }
  const outputReal = await realpath(output);
  if (!isInside(rootReal, outputReal)) {
    throw new Error("artifact output resolved outside the repository");
  }
  return outputReal;
}

function safeArtifactName(value) {
  return typeof value === "string" && value !== "" && value === path.basename(value) && !value.includes("..") && value.endsWith(".tgz");
}

export async function verifyArtifactManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schema !== SCHEMA) throw new Error("unsupported artifact manifest schema");
  if (!safeArtifactName(manifest.artifact?.filename)) throw new Error("unsafe artifact filename");
  if (!/^[0-9a-f]{64}$/.test(manifest.artifact.sha256)) throw new Error("invalid artifact sha256");
  const directory = path.dirname(manifestPath);
  const artifactPath = path.join(directory, manifest.artifact.filename);
  const checksumPath = `${artifactPath}.sha256`;
  const actual = await sha256File(artifactPath);
  if (actual !== manifest.artifact.sha256) throw new Error("artifact sha256 mismatch");
  const checksum = await readFile(checksumPath, "utf8");
  if (checksum !== `${actual}  ${manifest.artifact.filename}\n`) throw new Error("checksum file mismatch");
  const size = (await lstat(artifactPath)).size;
  if (size !== manifest.artifact.size) throw new Error("artifact size mismatch");
  return { schema: SCHEMA, status: "ok", filename: manifest.artifact.filename, sha256: actual, size };
}

export async function buildArtifact(root, requestedOutput = "release-artifacts") {
  const output = await prepareOutputDirectory(root, requestedOutput);
  const { stdout } = await execFile("npm", ["pack", "--json", "--pack-destination", output], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const report = JSON.parse(stdout)[0];
  if (!safeArtifactName(report?.filename)) throw new Error("npm pack returned an unsafe filename");
  const artifactPath = path.join(output, report.filename);
  const sha256 = await sha256File(artifactPath);
  const files = [...(report.files ?? [])]
    .map(({ path: file, size, mode }) => ({ path: file, size, mode }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schema: SCHEMA,
    package: { name: report.name, version: report.version },
    artifact: {
      filename: report.filename,
      sha256,
      npmShasum: report.shasum,
      npmIntegrity: report.integrity,
      size: report.size,
      unpackedSize: report.unpackedSize,
      fileCount: files.length,
    },
    files,
  };
  const manifestPath = `${artifactPath}.manifest.json`;
  await writeFile(`${artifactPath}.sha256`, `${sha256}  ${report.filename}\n`, { mode: 0o600 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const verification = await verifyArtifactManifest(manifestPath);
  return { ...verification, manifestPath, checksumPath: `${artifactPath}.sha256`, fileCount: files.length };
}

function parseArguments(args) {
  const [command, value] = args;
  if (command === "build" && args.length <= 2) return { command, output: value ?? "release-artifacts" };
  if (command === "verify" && args.length === 2) return { command, manifest: value };
  throw new Error("usage: artifact-integrity.mjs build [output-directory] | verify <manifest-path>");
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const args = parseArguments(process.argv.slice(2));
    const report = args.command === "build"
      ? await buildArtifact(root, args.output)
      : await verifyArtifactManifest(path.resolve(root, args.manifest));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ schema: SCHEMA, status: "error", message: error instanceof Error ? error.message : "artifact operation failed" }));
    process.exitCode = 1;
  }
}
