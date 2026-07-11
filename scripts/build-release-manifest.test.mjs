import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/build-release-manifest.mjs");

test("builds a same-origin release manifest without selecting stale assets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "abcdeploy-release-"));
  try {
    await writeFile(
      path.join(directory, "ABCDeploy_0.1.1_aarch64.dmg"),
      "stale",
    );
    await writeFile(
      path.join(directory, "ABCDeploy_0.2.0-preview.10_aarch64.dmg"),
      "future",
    );
    await writeFile(
      path.join(directory, "ABCDeploy_0.2.0-preview.1_aarch64.dmg"),
      "current-mac",
    );
    await writeFile(
      path.join(
        directory,
        "ABCDeploy_0.2.0-preview.1_aarch64.app.tar.gz",
      ),
      "internal-updater-archive",
    );
    await writeFile(
      path.join(directory, "ABCDeploy_0.2.0-preview.1_x64-setup.exe"),
      "current-windows",
    );
    const output = path.join(directory, "latest.json");
    await execFileAsync(process.execPath, [
      script,
      directory,
      output,
      "0.2.0-preview.1",
    ]);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.version, "v0.2.0-preview.1");
    assert.equal(manifest.assets["mac-arm"].available, true);
    assert.match(
      manifest.assets["mac-arm"].url,
      /^\/downloads\/v0\.2\.0-preview\.1\//,
    );
    assert.equal(manifest.assets.windows.available, true);
    assert.equal(manifest.assets.linux.available, false);
    assert.equal(manifest.assets["mac-arm"].sha256.length, 64);
    assert.equal(
      manifest.assets["mac-arm"].name,
      "ABCDeploy_0.2.0-preview.1_aarch64.dmg",
    );
    assert.doesNotMatch(manifest.assets["mac-arm"].name, /0\.1\.1/);
    assert.doesNotMatch(manifest.assets["mac-arm"].name, /preview\.10/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to publish an empty installer directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "abcdeploy-empty-"));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        script,
        directory,
        path.join(directory, "latest.json"),
        "0.2.0-preview.1",
      ]),
      /No installer assets found/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
