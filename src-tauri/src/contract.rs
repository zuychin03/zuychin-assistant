use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;

pub const MAX_LINE_BYTES: usize = 8_192;
const CODE_ALPHABET: &str = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostLaunch {
    v: u8,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_adopt: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach: Option<String>,
}

impl Default for HostLaunch {
    fn default() -> Self {
        Self {
            v: 1,
            kind: "launch",
            workspace: None,
            base_branch: None,
            auto_adopt: None,
            attach: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Denial {
    pub code: &'static str,
    pub reason: &'static str,
}

impl fmt::Display for Denial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.reason)
    }
}
impl std::error::Error for Denial {}

fn denied(code: &'static str) -> Denial {
    Denial {
        code,
        reason: match code {
            "not_json" => "Message is not valid JSON.",
            "not_object" => "Message must be an object.",
            "wrong_type" => "Message type is not supported.",
            "unsupported_version" => "Message version is not supported.",
            "unknown_field" => "Message contains an unsupported field.",
            "bad_workspace" => "Workspace must be an allowlisted name.",
            "bad_base_branch" => "Base branch is invalid.",
            "bad_auto_adopt" => "Auto adopt must be a boolean.",
            "bad_attach" => "Council code is invalid.",
            _ => "Supervision payload is invalid.",
        },
    }
}

fn object(raw: &str) -> Result<Map<String, Value>, Denial> {
    if raw.len() > MAX_LINE_BYTES {
        return Err(denied("not_json"));
    }
    serde_json::from_str::<Value>(raw)
        .map_err(|_| denied("not_json"))?
        .as_object()
        .cloned()
        .ok_or_else(|| denied("not_object"))
}

fn version(record: &Map<String, Value>) -> Result<(), Denial> {
    if record.get("v").and_then(Value::as_f64) == Some(1.0) {
        Ok(())
    } else {
        Err(denied("unsupported_version"))
    }
}

fn known_keys(record: &Map<String, Value>, keys: &[&str]) -> Result<(), Denial> {
    if record.keys().any(|key| !keys.contains(&key.as_str())) {
        Err(denied("unknown_field"))
    } else {
        Ok(())
    }
}

pub fn valid_workspace(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

pub fn valid_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
        && !value.contains("..")
        && !value.contains("//")
        && !value.ends_with('/')
        && !value.ends_with('.')
        && !value.ends_with(".lock")
}

fn valid_code(value: &str) -> bool {
    value.len() == 7
        && value.starts_with("CN-")
        && value[3..]
            .bytes()
            .all(|byte| CODE_ALPHABET.as_bytes().contains(&byte))
}

fn optional_string(
    record: &Map<String, Value>,
    key: &str,
    code: &'static str,
) -> Result<Option<String>, Denial> {
    match record.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(denied(code)),
    }
}

pub fn parse_launch(raw: &str) -> Result<HostLaunch, Denial> {
    let record = object(raw)?;
    if record.get("type").and_then(Value::as_str) != Some("launch") {
        return Err(denied("wrong_type"));
    }
    version(&record)?;
    known_keys(
        &record,
        &[
            "v",
            "type",
            "workspace",
            "baseBranch",
            "autoAdopt",
            "attach",
        ],
    )?;
    let mut launch = HostLaunch {
        workspace: optional_string(&record, "workspace", "bad_workspace")?,
        ..HostLaunch::default()
    };
    if launch
        .workspace
        .as_deref()
        .is_some_and(|name| !valid_workspace(name))
    {
        return Err(denied("bad_workspace"));
    }
    launch.base_branch = optional_string(&record, "baseBranch", "bad_base_branch")?;
    if launch
        .base_branch
        .as_deref()
        .is_some_and(|name| !valid_branch(name))
    {
        return Err(denied("bad_base_branch"));
    }
    launch.auto_adopt = match record.get("autoAdopt") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(value)) => Some(*value),
        _ => return Err(denied("bad_auto_adopt")),
    };
    launch.attach =
        optional_string(&record, "attach", "bad_attach")?.map(|code| code.to_uppercase());
    if launch
        .attach
        .as_deref()
        .is_some_and(|code| !valid_code(code))
    {
        return Err(denied("bad_attach"));
    }
    Ok(launch)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HostControl {
    v: u8,
    #[serde(rename = "type")]
    kind: &'static str,
    pub reason: Option<String>,
}

pub fn parse_control(raw: &str) -> Option<Result<HostControl, Denial>> {
    if raw.trim().is_empty() {
        return None;
    }
    Some((|| {
        let record = object(raw)?;
        version(&record)?;
        if record.get("type").and_then(Value::as_str) != Some("stop") {
            return Err(denied("wrong_type"));
        }
        known_keys(&record, &["v", "type", "reason"])?;
        let reason = record
            .get("reason")
            .and_then(Value::as_str)
            .map(|reason| reason.chars().take(200).collect());
        Ok(HostControl {
            v: 1,
            kind: "stop",
            reason,
        })
    })())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHealth {
    pub host_version: String,
    pub host_generation: String,
    pub host_id: String,
    pub pid: u32,
    pub port: Option<u16>,
    pub lifecycle: String,
    pub draining: bool,
    pub lease_healthy: bool,
    pub council_code: Option<String>,
    pub agents: u32,
    pub uptime_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExitReason {
    Requested,
    Signal,
    Singleton,
    Config,
    Fatal,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HostExit {
    pub code: i32,
    pub reason: ExitReason,
    pub draining: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Supervision {
    Health(HostHealth),
    Log(LogLevel),
    Exit(HostExit),
}

fn string(record: &Map<String, Value>, key: &str) -> Result<String, Denial> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| denied("bad_payload"))
}
fn boolean(record: &Map<String, Value>, key: &str) -> Result<bool, Denial> {
    record
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| denied("bad_payload"))
}
fn natural(record: &Map<String, Value>, key: &str, maximum: u64) -> Result<u64, Denial> {
    record
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value <= maximum)
        .ok_or_else(|| denied("bad_payload"))
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
}

fn health(record: &Map<String, Value>) -> Result<HostHealth, Denial> {
    let host_version = string(record, "hostVersion")?;
    let host_generation = string(record, "hostGeneration")?;
    let host_id = string(record, "hostId")?;
    if !token(&host_version)
        || !token(&host_generation)
        || host_id.len() != 36
        || !host_id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(denied("bad_payload"));
    }
    let lifecycle = string(record, "lifecycle")?;
    if !["starting", "ready", "degraded", "draining", "stopping"].contains(&lifecycle.as_str()) {
        return Err(denied("bad_payload"));
    }
    let draining = boolean(record, "draining")?;
    if !draining && ["draining", "stopping"].contains(&lifecycle.as_str()) {
        return Err(denied("bad_payload"));
    }
    let council_code = optional_string(record, "councilCode", "bad_payload")?;
    if council_code
        .as_deref()
        .is_some_and(|code| !valid_code(code))
    {
        return Err(denied("bad_payload"));
    }
    let port = match record.get("port") {
        Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_u64()
                .filter(|port| (1..=65_535).contains(port))
                .ok_or_else(|| denied("bad_payload"))? as u16,
        ),
        None => return Err(denied("bad_payload")),
    };
    let pid = natural(record, "pid", u32::MAX as u64)? as u32;
    if pid == 0 {
        return Err(denied("bad_payload"));
    }
    Ok(HostHealth {
        host_version,
        host_generation,
        host_id,
        pid,
        port,
        lifecycle,
        draining,
        lease_healthy: boolean(record, "leaseHealthy")?,
        council_code,
        agents: natural(record, "agents", 1_000)? as u32,
        uptime_ms: natural(record, "uptimeMs", 9_007_199_254_740_991)?,
    })
}

pub fn parse_supervision(raw: &str) -> Option<Result<Supervision, Denial>> {
    let raw = raw.trim();
    let body = raw.strip_prefix("zch ")?;
    Some((|| {
        let record = object(body)?;
        version(&record)?;
        match record.get("type").and_then(Value::as_str) {
            Some("health") => Ok(Supervision::Health(health(&record)?)),
            Some("log") => {
                if !record.get("message").is_some_and(Value::is_string) {
                    return Err(denied("bad_payload"));
                }
                Ok(Supervision::Log(
                    match record.get("level").and_then(Value::as_str) {
                        Some("info") => LogLevel::Info,
                        Some("warn") => LogLevel::Warn,
                        Some("error") => LogLevel::Error,
                        _ => return Err(denied("bad_payload")),
                    },
                ))
            }
            Some("exit") => {
                let code = record
                    .get("code")
                    .and_then(Value::as_i64)
                    .and_then(|value| i32::try_from(value).ok())
                    .ok_or_else(|| denied("bad_payload"))?;
                let reason = match record.get("reason").and_then(Value::as_str) {
                    Some("requested") => ExitReason::Requested,
                    Some("signal") => ExitReason::Signal,
                    Some("singleton") => ExitReason::Singleton,
                    Some("config") => ExitReason::Config,
                    Some("fatal") => ExitReason::Fatal,
                    _ => return Err(denied("bad_payload")),
                };
                Ok(Supervision::Exit(HostExit {
                    code,
                    reason,
                    draining: boolean(&record, "draining")?,
                }))
            }
            _ => Err(denied("wrong_type")),
        }
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_contract_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../fixtures/council/supervisor-v1.json"))
                .unwrap();
        for case in corpus["launchValid"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(parse_launch(case["line"].as_str().unwrap()).unwrap())
                    .unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
        for case in corpus["launchInvalid"].as_array().unwrap() {
            assert_eq!(
                parse_launch(case["line"].as_str().unwrap())
                    .unwrap_err()
                    .code,
                case["code"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
        for case in corpus["controlValid"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(
                    parse_control(case["line"].as_str().unwrap())
                        .unwrap()
                        .unwrap()
                )
                .unwrap(),
                case["expect"]
            );
        }
        for case in corpus["controlInvalid"].as_array().unwrap() {
            assert_eq!(
                parse_control(case["line"].as_str().unwrap())
                    .unwrap()
                    .unwrap_err()
                    .code,
                case["code"].as_str().unwrap()
            );
        }
        for case in corpus["controlIgnored"].as_array().unwrap() {
            assert!(parse_control(case["line"].as_str().unwrap()).is_none());
        }
        for case in corpus["supervisionValid"].as_array().unwrap() {
            let kind = match parse_supervision(case["line"].as_str().unwrap())
                .unwrap()
                .unwrap()
            {
                Supervision::Health(_) => "health",
                Supervision::Log(_) => "log",
                Supervision::Exit(_) => "exit",
            };
            assert_eq!(kind, case["type"].as_str().unwrap());
        }
        for case in corpus["supervisionInvalid"].as_array().unwrap() {
            assert_eq!(
                parse_supervision(case["line"].as_str().unwrap())
                    .unwrap()
                    .unwrap_err()
                    .code,
                case["code"].as_str().unwrap()
            );
        }
        for case in corpus["supervisionIgnored"].as_array().unwrap() {
            assert!(parse_supervision(case["line"].as_str().unwrap()).is_none());
        }
    }

    #[test]
    fn health_requires_typed_payload_and_logs_discard_content() {
        assert!(
            parse_supervision(r#"zch {"v":1,"type":"health","draining":false}"#)
                .unwrap()
                .is_err()
        );
        assert_eq!(
            parse_supervision(
                r#"zch {"v":1,"type":"log","level":"warn","message":"credential or private path"}"#
            ),
            Some(Ok(Supervision::Log(LogLevel::Warn)))
        );
        assert!(parse_launch(r#"{"v":1,"type":"launch","args":["--no-lock"]}"#).is_err());
    }
}
