import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [assetDirectory, outputPath, rawVersion] = process.argv.slice(2);
if (!assetDirectory || !outputPath || !rawVersion) {
  throw new Error(
    "Usage: node scripts/build-release-manifest.mjs <asset-dir> <output> <version>",
  );
}

const version = rawVersion.startsWith("v") ? rawVersion : `v${rawVersion}`;
const files = await listFiles(assetDirectory);
const escapedVersion = version.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const versionPattern = new RegExp(`${escapedVersion}(?=$|[^0-9A-Za-z.-])`);
const releaseFiles = files.filter((candidate) =>
  versionPattern.test(path.basename(candidate)),
);
if (releaseFiles.length === 0) {
  throw new Error(`No installer assets found for ${version}`);
}
const definitions = {
  "mac-arm": [/aarch64.*\.dmg$/i, /aarch64.*\.app\.tar\.gz$/i],
  "mac-intel": [/x64.*\.dmg$/i, /x86_64.*\.dmg$/i],
  windows: [/x64.*setup.*\.exe$/i, /x64.*\.msi$/i],
  linux: [/amd64.*\.AppImage$/i, /amd64.*\.deb$/i],
};

const assets = {};
for (const [key, patterns] of Object.entries(definitions)) {
  const file = releaseFiles.find((candidate) =>
    patterns.some((pattern) => pattern.test(path.basename(candidate))),
  );
  assets[key] = file
    ? {
        available: true,
        name: path.basename(file),
        url: `/downloads/${version}/${encodeURIComponent(path.basename(file))}`,
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      }
    : { available: false, url: "", sha256: "" };
}

const manifest = {
  version,
  channel: version.includes("-") ? "preview" : "stable",
  releasePage: "https://abcdeploy.finagent.cloud/#download",
  publishedAt: new Date().toISOString(),
  assets,
};
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(absolute)));
    else if (entry.isFile()) result.push(absolute);
  }
  return result.sort();
}
