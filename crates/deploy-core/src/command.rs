use std::path::{Path, PathBuf};
use std::process::Command;

/// Creates a command that also works when the desktop app is launched from Finder.
/// macOS GUI applications do not inherit the user's shell PATH, so common tools
/// installed by Docker Desktop, Homebrew or system installers must be resolved
/// explicitly.
#[must_use]
pub fn system_command(program: &str) -> Command {
    Command::new(resolve_executable(program))
}

fn resolve_executable(program: &str) -> PathBuf {
    let path = Path::new(program);
    if path.components().count() > 1 {
        return path.to_path_buf();
    }

    let inherited = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>());
    let common = [
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
        PathBuf::from("/Applications/Docker.app/Contents/Resources/bin"),
    ];

    inherited
        .chain(common)
        .map(|directory| directory.join(program))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::resolve_executable;

    #[test]
    fn keeps_explicit_paths_unchanged() {
        assert_eq!(
            resolve_executable("/custom/bin/tool").to_string_lossy(),
            "/custom/bin/tool"
        );
    }

    #[test]
    fn resolves_standard_system_tools_for_gui_apps() {
        assert!(resolve_executable("sh").is_file());
    }
}
