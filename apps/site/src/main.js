const repository = "https://github.com/blacksco0920-dot/abcdeploy";
const releasesPage = `${repository}/releases`;
const localDownloadPage = "#download";
const preferredAsset = platformAsset();
const isMac = preferredAsset === "mac";

applyPlatformHint();
void loadRelease();

function platformAsset() {
  const platform = navigator.userAgent.toLowerCase();
  if (platform.includes("windows")) return "windows";
  if (platform.includes("mac")) return "mac";
  if (platform.includes("linux")) return "linux";
  return null;
}

function applyPlatformHint() {
  const primary = document.querySelector("[data-primary-download]");
  if (!primary) return;
  primary.textContent =
    preferredAsset === "windows"
      ? "下载 Windows 版"
      : preferredAsset === "linux"
        ? "下载 Linux 版"
        : isMac
          ? "选择 macOS 版本"
          : "选择适合我的版本";
  primary.href = localDownloadPage;
}

async function loadRelease() {
  try {
    const response = await fetch("/releases/latest.json", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("release manifest unavailable");
    const release = await response.json();
    const version = document.querySelector("[data-release-version]");
    if (version) {
      version.textContent = `${release.channel === "stable" ? "稳定版" : "预览版"} ${release.version}`;
    }
    const releasePage =
      release.releasePage && release.releasePage !== localDownloadPage
        ? release.releasePage
        : releasesPage;
    document.querySelectorAll("[data-asset]").forEach((link) => {
      const asset = release.assets?.[link.dataset.asset];
      link.href = asset?.available && asset.url ? asset.url : releasePage;
      if (asset?.sha256) link.title = `SHA-256: ${asset.sha256}`;
    });
    const primary = document.querySelector("[data-primary-download]");
    const selected = release.assets?.[preferredAsset];
    if (primary && !isMac && preferredAsset) {
      primary.href =
        selected?.available && selected.url ? selected.url : releasePage;
    }
  } catch {
    document.querySelectorAll("[data-asset]").forEach((link) => {
      link.href = releasesPage;
      link.removeAttribute("aria-disabled");
      link.title = "前往 GitHub Releases 下载";
    });
    const primary = document.querySelector("[data-primary-download]");
    if (primary && !isMac) primary.href = releasesPage;
  }
}
