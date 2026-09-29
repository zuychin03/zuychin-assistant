fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "council_desktop_status",
            "council_desktop_start",
            "council_desktop_stop",
            "council_desktop_restart",
        ]),
    ))
    .expect("desktop build configuration is invalid");
}
