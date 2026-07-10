const repository = "https://github.com/blacksco0920-dot/abcdeploy";
const releasesPage = `${repository}/releases`;

applyPlatformHint();
void loadRelease();

function applyPlatformHint() {
  const primary = document.querySelector("[data-primary-download]");
  if (!primary) return;
  const platform = navigator.userAgent.toLowerCase();
  if (platform.includes("windows")) primary.textContent = "下载 Windows 版";
  else if (platform.includes("mac")) primary.textContent = "下载 macOS 版";
  else if (platform.includes("linux")) primary.textContent = "下载 Linux 版";
}

async function loadRelease() {
  try {
    const response = await fetch(
      "https://api.github.com/repos/blacksco0920-dot/abcdeploy/releases?per_page=5",
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) return;
    const releases = await response.json();
    const release = releases.find((item) => !item.draft);
    if (!release) return;
    const version = document.querySelector("[data-release-version]");
    if (version) version.textContent = `${release.prerelease ? "预览版" : "稳定版"} ${release.tag_name}`;
    bindAsset(release.assets, "mac-arm", [/aarch64.*\.dmg$/i, /aarch64.*\.app\.tar\.gz$/i]);
    bindAsset(release.assets, "mac-intel", [/x64.*\.dmg$/i, /x86_64.*\.dmg$/i]);
    bindAsset(release.assets, "windows", [/x64.*setup.*\.exe$/i, /x64.*\.msi$/i]);
    bindAsset(release.assets, "linux", [/amd64.*\.AppImage$/i, /amd64.*\.deb$/i]);
  } catch {
    document.querySelectorAll("[data-asset]").forEach((link) => {
      link.href = releasesPage;
    });
  }
}

function bindAsset(assets, key, patterns) {
  const link = document.querySelector(`[data-asset="${key}"]`);
  if (!link) return;
  const asset = assets.find((item) => patterns.some((pattern) => pattern.test(item.name)));
  link.href = asset?.browser_download_url ?? releasesPage;
}
