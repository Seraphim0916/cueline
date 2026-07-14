import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`${relativePath} must exist and contain valid JSON: ${error.message}`);
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
}

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const packageJson = await readJson("package.json");
const codexManifest = await readJson(".codex-plugin/plugin.json");
const claudeManifest = await readJson(".claude-plugin/plugin.json");

for (const [name, manifest] of [
  [".codex-plugin/plugin.json", codexManifest],
  [".claude-plugin/plugin.json", claudeManifest],
]) {
  requireNonEmptyString(manifest.name, `${name}: name`);
  requireNonEmptyString(manifest.version, `${name}: version`);
  requireNonEmptyString(manifest.description, `${name}: description`);
  requireNonEmptyString(manifest.author?.name, `${name}: author.name`);
  if (!semver.test(manifest.version)) {
    throw new Error(`${name}: version must be strict semver`);
  }
  if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) {
    throw new Error(`${name}: name and version must match package.json`);
  }
}

const pluginInterface = codexManifest.interface;
for (const field of [
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "defaultPrompt",
]) {
  requireNonEmptyString(pluginInterface?.[field], `.codex-plugin/plugin.json: interface.${field}`);
}
if (!Array.isArray(pluginInterface.capabilities) || pluginInterface.capabilities.some((item) => typeof item !== "string")) {
  throw new Error(".codex-plugin/plugin.json: interface.capabilities must be an array of strings");
}
if (codexManifest.skills !== "./skills/") {
  throw new Error(".codex-plugin/plugin.json: skills must be ./skills/");
}

const skill = await readFile(path.join(root, "skills/cueline/SKILL.md"), "utf8");
if (!skill.startsWith("---\n") || !/^name: cueline$/m.test(skill) || !/^description: .+$/m.test(skill)) {
  throw new Error("skills/cueline/SKILL.md must contain cueline name and description frontmatter");
}

console.log(`Plugin validation passed: ${root} (${packageJson.version})`);
