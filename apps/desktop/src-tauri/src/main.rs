// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() == Some("--pilot-deploy") {
        let result = arguments
            .next()
            .ok_or_else(|| "--pilot-deploy 需要项目目录".to_string())
            .and_then(|path| abcdeploy_desktop_lib::run_pilot_validation_cli(&path));
        if let Err(message) = result {
            eprintln!("{message}");
            std::process::exit(1);
        }
        return;
    }
    abcdeploy_desktop_lib::run();
}
