use crate::{contract::parse_launch, supervisor::LaunchSpec};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerConfig {
    app_url: String,
    node_path: PathBuf,
    repository_path: PathBuf,
    host_config_path: PathBuf,
    env_file_path: PathBuf,
    launch: Value,
}

pub struct DesktopConfig {
    pub app_url: Url,
    pub origin: String,
    pub launch: LaunchSpec,
}

pub fn trusted_url(raw: &str, development: bool) -> Result<Url, &'static str> {
    let url = Url::parse(raw).map_err(|_| "Invalid app URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let literal_host = url.host_str().is_some_and(|host| {
        host.chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | ':' | '[' | ']'))
    });
    if !(url.scheme() == "https" || development && local && url.scheme() == "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !literal_host
    {
        return Err("Use an HTTPS app URL without credentials, query or fragment");
    }
    Ok(url)
}

pub fn same_origin(expected: &str, candidate: &Url) -> bool {
    candidate.origin().ascii_serialization() == expected
        && candidate.username().is_empty()
        && candidate.password().is_none()
}

fn canonical(path: &Path, directory: bool) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() {
        return Err("Desktop paths must be absolute");
    }
    // Node's loader rejects Windows extended-length paths for its entry point and cwd.
    let resolved = dunce::canonicalize(path).map_err(|_| "A configured desktop path is missing")?;
    if (directory && !resolved.is_dir()) || (!directory && !resolved.is_file()) {
        return Err("A configured desktop path has the wrong type");
    }
    Ok(resolved)
}

pub fn load(path: &Path) -> Result<DesktopConfig, &'static str> {
    let bytes = fs::read(path).map_err(|_| "Desktop setup is missing")?;
    if bytes.len() > 32_768 {
        return Err("Desktop configuration is too large");
    }
    let owner: OwnerConfig =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid desktop configuration")?;
    let app_url = trusted_url(&owner.app_url, cfg!(debug_assertions))?;
    let origin = app_url.origin().ascii_serialization();
    let node = canonical(&owner.node_path, false)?;
    let repo = canonical(&owner.repository_path, true)?;
    let config = canonical(&owner.host_config_path, false)?;
    let env_file = canonical(&owner.env_file_path, false)?;
    if !repo.join("scripts/council-host.mts").is_file()
        || !repo.join("node_modules/tsx/package.json").is_file()
        || !repo.join(".git").exists()
    {
        return Err("The configured checkout needs the Council host and installed dependencies");
    }
    let host: Value =
        serde_json::from_slice(&fs::read(&config).map_err(|_| "Cannot read host configuration")?)
            .map_err(|_| "Invalid host configuration")?;
    let built_in = origin == "http://localhost:3000" || origin == "http://127.0.0.1:3000";
    let allowed = host
        .pointer("/host/origins")
        .and_then(Value::as_array)
        .is_some_and(|origins| origins.iter().any(|value| value.as_str() == Some(&origin)));
    if !built_in && !allowed {
        return Err("Add the app origin to host.origins in the Council host configuration");
    }
    let launch = parse_launch(&owner.launch.to_string())
        .map_err(|_| "Invalid supervision launch configuration")?;
    Ok(DesktopConfig {
        app_url,
        origin,
        launch: LaunchSpec {
            node,
            repo,
            config,
            env_file,
            launch,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn canonical_paths_remain_usable_by_node() {
        let directory = tempfile::tempdir().unwrap();
        let path = canonical(directory.path(), true).unwrap();
        assert!(path.is_absolute());
        assert!(!path.as_os_str().to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn remote_urls_fail_closed() {
        for raw in [
            "http://example.com",
            "file:///tmp/app",
            "https://x@example.com",
            "https://example.com?secret=x",
            "https://example.com/#x",
            "https://*.example.com",
            "https://app{test}.example.com",
        ] {
            assert!(trusted_url(raw, false).is_err(), "{raw}");
        }
        assert!(trusted_url("http://127.0.0.1:3105/council", true).is_ok());
        assert!(trusted_url("http://127.0.0.1:3105/council", false).is_err());
        assert!(trusted_url("http://example.com", true).is_err());
    }

    #[test]
    fn navigation_allows_login_but_rejects_origin_changes() {
        let origin = "https://app.example";
        assert!(same_origin(
            origin,
            &Url::parse("https://app.example/login").unwrap()
        ));
        for raw in [
            "https://app.example.evil/council",
            "https://app.example:444/council",
            "http://app.example",
            "https://user@app.example",
        ] {
            assert!(!same_origin(origin, &Url::parse(raw).unwrap()), "{raw}");
        }
    }
}
