use crate::contract::{self, ExitReason, HostExit, HostHealth, HostLaunch, LogLevel, Supervision};
#[cfg(unix)]
use process_wrap::std::ProcessGroup;
use process_wrap::std::{ChildWrapper, CommandWrap};
#[cfg(windows)]
use process_wrap::std::{CreationFlags, JobObject};
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::{Read, Write},
    path::PathBuf,
    process::{ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 5 });
const KILL_TIMEOUT: Duration = Duration::from_secs(2);
const HEALTH_FRESHNESS: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_EVENTS: usize = 64;
const STOP_LINE: &[u8] = b"{\"v\":1,\"type\":\"stop\",\"reason\":\"desktop supervisor\"}\n";

#[cfg(windows)]
mod kill_on_close {
    use process_wrap::std::{ChildWrapper, CommandWrap, CommandWrapper, JobObject};
    use std::{
        io,
        os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
        process::{Child, Command},
    };
    use windows::Win32::{
        Foundation::HANDLE,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    #[derive(Debug, Default)]
    pub struct KillOnClose {
        job: Option<OwnedHandle>,
    }

    impl CommandWrapper for KillOnClose {
        fn post_spawn(
            &mut self,
            _: &mut Command,
            child: &mut Child,
            core: &CommandWrap,
        ) -> io::Result<()> {
            let result = (|| {
                if !core.has_wrap::<JobObject>() {
                    return Err(io::Error::other("suspended job assignment is required"));
                }
                // All post_spawn hooks run before JobObject resumes the child.
                let handle = unsafe { CreateJobObjectW(None, None) }.map_err(io::Error::other)?;
                let job = unsafe { OwnedHandle::from_raw_handle(handle.0) };
                let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                unsafe {
                    SetInformationJobObject(
                        handle,
                        JobObjectExtendedLimitInformation,
                        &information as *const _ as _,
                        std::mem::size_of_val(&information) as u32,
                    )
                    .map_err(io::Error::other)?;
                    AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle()))
                        .map_err(io::Error::other)?;
                }
                self.job = Some(job);
                Ok(())
            })();
            if result.is_err() {
                let _ = child.kill();
                let _ = child.wait();
            }
            result
        }

        fn wrap_child(
            &mut self,
            inner: Box<dyn ChildWrapper>,
            _: &CommandWrap,
        ) -> io::Result<Box<dyn ChildWrapper>> {
            let job = self
                .job
                .take()
                .ok_or_else(|| io::Error::other("kill-on-close job is missing"))?;
            Ok(Box::new(KillOnCloseChild { inner, job }))
        }
    }

    #[derive(Debug)]
    struct KillOnCloseChild {
        inner: Box<dyn ChildWrapper>,
        job: OwnedHandle,
    }

    pub fn tree_empty(child: &dyn ChildWrapper) -> io::Result<bool> {
        let owned = (child as &dyn std::any::Any)
            .downcast_ref::<KillOnCloseChild>()
            .ok_or_else(|| io::Error::other("owned process job is unavailable"))?;
        let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(HANDLE(owned.job.as_raw_handle())),
                JobObjectBasicAccountingInformation,
                &mut information as *mut _ as _,
                std::mem::size_of_val(&information) as u32,
                None,
            )
            .map_err(io::Error::other)?;
        }
        Ok(information.ActiveProcesses == 0)
    }

    impl ChildWrapper for KillOnCloseChild {
        fn inner(&self) -> &dyn ChildWrapper {
            self.inner.as_ref()
        }
        fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
            self.inner.as_mut()
        }
        fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
            self.inner
        }
        fn process_handle(&self) -> Option<BorrowedHandle<'_>> {
            self.inner
                .process_handle()
                .or_else(|| self.inner.try_inner_child().map(AsHandle::as_handle))
        }
    }
}

#[derive(Clone)]
pub struct LaunchSpec {
    pub node: PathBuf,
    pub repo: PathBuf,
    pub config: PathBuf,
    pub env_file: PathBuf,
    pub launch: HostLaunch,
}

impl LaunchSpec {
    fn command(&self) -> Result<Command, String> {
        if !self.node.is_absolute()
            || !self.repo.is_absolute()
            || !self.config.is_absolute()
            || !self.env_file.is_absolute()
            || !self.node.is_file()
            || !self.repo.is_dir()
            || !self.config.is_file()
            || !self.env_file.is_file()
            || !self.repo.join("scripts/council-host.mts").is_file()
        {
            return Err("Owner launch configuration is unavailable.".into());
        }
        let encoded = serde_json::to_string(&self.launch)
            .map_err(|_| "Owner launch configuration is invalid.")?;
        contract::parse_launch(&encoded).map_err(|_| "Owner launch configuration is invalid.")?;
        let mut command = Command::new(&self.node);
        command.current_dir(&self.repo).env_clear();
        for (key, value) in
            std::env::vars_os().filter(|(key, _)| inherited_environment_key(&key.to_string_lossy()))
        {
            command.env(key, value);
        }
        command
            .env("ZUYCHIN_SUPERVISED", "1")
            .env("ZUYCHIN_HOST_LAUNCH", encoded);
        let mut env_argument = std::ffi::OsString::from("--env-file=");
        env_argument.push(&self.env_file);
        command
            .arg(env_argument)
            .arg("--import")
            .arg("tsx")
            .arg(self.repo.join("scripts/council-host.mts"))
            .arg("--config")
            .arg(&self.config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        Ok(command)
    }
}

fn inherited_environment_key(key: &str) -> bool {
    matches!(
        key.to_ascii_uppercase().as_str(),
        "PATH"
            | "PATHEXT"
            | "SYSTEMROOT"
            | "WINDIR"
            | "COMSPEC"
            | "HOME"
            | "USERPROFILE"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "PROGRAMDATA"
            | "PROGRAMFILES"
            | "PROGRAMFILES(X86)"
            | "TEMP"
            | "TMP"
            | "TMPDIR"
            | "LANG"
            | "LC_ALL"
            | "TZ"
    )
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLog {
    pub at_ms: u64,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopExit {
    pub code: Option<i32>,
    pub reason: Option<ExitReason>,
    pub clean: bool,
    pub forced: bool,
    pub draining: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHostStatus {
    pub phase: Phase,
    pub owned: bool,
    pub restart_safe: bool,
    pub health: Option<HostHealth>,
    pub logs: VecDeque<DesktopLog>,
    pub error: Option<String>,
    pub last_exit: Option<DesktopExit>,
}

impl Default for DesktopHostStatus {
    fn default() -> Self {
        Self {
            phase: Phase::Stopped,
            owned: false,
            restart_safe: false,
            health: None,
            logs: VecDeque::new(),
            error: None,
            last_exit: None,
        }
    }
}

#[derive(Default)]
struct Shared {
    status: DesktopHostStatus,
    health_at: Option<Instant>,
}

impl Shared {
    fn snapshot(&self) -> DesktopHostStatus {
        let mut status = self.status.clone();
        status.restart_safe = status.owned
            && status.phase == Phase::Running
            && self
                .health_at
                .is_some_and(|at| at.elapsed() <= HEALTH_FRESHNESS)
            && status
                .health
                .as_ref()
                .is_some_and(|health| !health.draining && health.lifecycle == "ready");
        if status.phase == Phase::Running
            && self
                .health_at
                .is_some_and(|at| at.elapsed() > HEALTH_FRESHNESS)
        {
            status.error = Some("Host health is stale. Restart and Stop are unavailable.".into());
        }
        status
    }

    fn log(&mut self, level: LogLevel, message: &'static str) {
        if self
            .status
            .logs
            .back()
            .is_some_and(|entry| entry.level == level && entry.message == message)
        {
            return;
        }
        if self.status.logs.len() == MAX_EVENTS {
            self.status.logs.pop_front();
        }
        self.status.logs.push_back(DesktopLog {
            at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            level,
            message: message.into(),
        });
    }
}

type Reply = SyncSender<Result<DesktopHostStatus, String>>;
enum Request {
    Start(Reply),
    Stop(Reply),
    Restart(Reply),
}

#[derive(Default)]
struct ShutdownControl {
    requested: AtomicBool,
    finished: AtomicBool,
}

struct WorkerCompletion(Arc<ShutdownControl>);

impl Drop for WorkerCompletion {
    fn drop(&mut self) {
        self.0.finished.store(true, Ordering::Release);
    }
}

pub struct Supervisor {
    requests: SyncSender<Request>,
    shared: Arc<Mutex<Shared>>,
    shutdown: Arc<ShutdownControl>,
}

impl Supervisor {
    pub fn new(spec: LaunchSpec) -> Self {
        let (requests, receiver) = mpsc::sync_channel(8);
        let shared = Arc::new(Mutex::new(Shared::default()));
        let worker_shared = Arc::clone(&shared);
        let shutdown = Arc::new(ShutdownControl::default());
        let worker_shutdown = Arc::clone(&shutdown);
        if thread::Builder::new()
            .name("council-supervisor".into())
            .spawn(move || worker(spec, receiver, worker_shared, worker_shutdown))
            .is_err()
        {
            let mut state = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.status.phase = Phase::Failed;
            state.status.error = Some("The supervisor could not start.".into());
            shutdown.finished.store(true, Ordering::Release);
        }
        Self {
            requests,
            shared,
            shutdown,
        }
    }

    pub fn status(&self) -> DesktopHostStatus {
        self.shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot()
    }

    fn request(
        &self,
        action: impl FnOnce(Reply) -> Request,
        timeout: Duration,
    ) -> Result<DesktopHostStatus, String> {
        if self.shutdown.requested.load(Ordering::Acquire) {
            return Err("The supervisor is shutting down.".into());
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        self.requests
            .try_send(action(reply))
            .map_err(|_| "The supervisor is unavailable or busy.".to_string())?;
        receiver
            .recv_timeout(timeout)
            .map_err(|_| "The supervisor did not answer in time.".to_string())?
    }

    pub fn start(&self) -> Result<DesktopHostStatus, String> {
        self.request(Request::Start, Duration::from_secs(3))
    }
    pub fn stop(&self) -> Result<DesktopHostStatus, String> {
        self.request(Request::Stop, Duration::from_secs(3))
    }
    pub fn restart(&self) -> Result<DesktopHostStatus, String> {
        self.request(Request::Restart, Duration::from_secs(3))
    }
    pub fn shutdown(&self) -> Result<DesktopHostStatus, String> {
        self.shutdown.requested.store(true, Ordering::Release);
        let deadline = Instant::now() + STOP_TIMEOUT + KILL_TIMEOUT + Duration::from_secs(3);
        loop {
            if self.shutdown.finished.load(Ordering::Acquire) {
                let status = self.status();
                return if status.owned {
                    Err("Host termination has not been confirmed.".into())
                } else {
                    Ok(status)
                };
            }
            if Instant::now() >= deadline {
                return Err("Host termination has not been confirmed.".into());
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown.requested.store(true, Ordering::Release);
    }
}

enum Output {
    Message(Supervision),
    Invalid,
}

fn read_output(mut stream: impl Read, sender: SyncSender<Output>, done: Arc<AtomicBool>) {
    let mut chunk = [0; 1_024];
    let mut line = Vec::with_capacity(1_024);
    let mut oversized = false;
    loop {
        let size = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(size) => size,
        };
        for byte in &chunk[..size] {
            if *byte == b'\n' {
                if oversized {
                    let _ = sender.try_send(Output::Invalid);
                } else {
                    let parsed = std::str::from_utf8(&line)
                        .ok()
                        .and_then(contract::parse_supervision);
                    match parsed {
                        Some(Ok(message)) => {
                            let _ = sender.try_send(Output::Message(message));
                        }
                        Some(Err(_)) => {
                            let _ = sender.try_send(Output::Invalid);
                        }
                        None => {}
                    }
                }
                line.clear();
                oversized = false;
            } else if !oversized {
                if line.len() == contract::MAX_LINE_BYTES {
                    line.clear();
                    oversized = true;
                } else {
                    line.push(*byte);
                }
            }
        }
    }
    done.store(true, Ordering::Release);
}

struct OwnedChild {
    child: Box<dyn ChildWrapper>,
    stdin: Option<ChildStdin>,
    output: Receiver<Output>,
    output_done: Arc<AtomicBool>,
    started_at: Instant,
    stop_at: Option<Instant>,
    killed_at: Option<Instant>,
    ended: Option<(ExitStatus, Instant)>,
    report: Option<HostExit>,
    forced: bool,
    ready: bool,
    bad_report: bool,
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn spawn_owned(command: Command) -> Result<OwnedChild, String> {
    let mut wrapped = CommandWrap::from(command);
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        wrapped
            .wrap(CreationFlags(CREATE_NO_WINDOW))
            .wrap(JobObject)
            .wrap(kill_on_close::KillOnClose::default());
    }
    #[cfg(unix)]
    wrapped.wrap(ProcessGroup::leader());
    let mut child = wrapped
        .spawn()
        .map_err(|_| "The configured Node host could not be started.".to_string())?;
    let stdin = child.stdin().take();
    let stdout = match child.stdout().take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.start_kill();
            return Err("The host supervision pipe is unavailable.".into());
        }
    };
    let (sender, output) = mpsc::sync_channel(MAX_EVENTS);
    let output_done = Arc::new(AtomicBool::new(false));
    let reader_done = Arc::clone(&output_done);
    if thread::Builder::new()
        .name("council-output".into())
        .spawn(move || read_output(stdout, sender, reader_done))
        .is_err()
    {
        let _ = child.start_kill();
        return Err("The host supervision pipe could not be read.".into());
    }
    Ok(OwnedChild {
        child,
        stdin,
        output,
        output_done,
        started_at: Instant::now(),
        stop_at: None,
        killed_at: None,
        ended: None,
        report: None,
        forced: false,
        ready: false,
        bad_report: false,
    })
}

fn start_process(spec: &LaunchSpec, state: &mut Shared) -> Result<OwnedChild, String> {
    let owned = spawn_owned(spec.command()?)?;
    state.status.phase = Phase::Starting;
    state.status.owned = true;
    state.status.health = None;
    state.status.error = None;
    state.status.last_exit = None;
    state.health_at = None;
    state.log(LogLevel::Info, "Starting the configured host.");
    Ok(owned)
}

fn begin_stop(owned: &mut OwnedChild, state: &mut Shared) {
    if owned.stop_at.is_some() {
        return;
    }
    state.status.phase = Phase::Stopping;
    owned.stop_at = Some(Instant::now());
    if let Some(mut stdin) = owned.stdin.take() {
        let _ = stdin.write_all(STOP_LINE);
    }
    state.log(LogLevel::Info, "Stopping the owned host.");
}

fn force_stop(owned: &mut OwnedChild, state: &mut Shared, message: &'static str) {
    if owned.killed_at.is_some() {
        return;
    }
    owned.forced = true;
    owned.killed_at = Some(Instant::now());
    let _ = owned.child.start_kill();
    owned.stdin.take();
    state.status.phase = Phase::Stopping;
    state.status.error = Some(message.into());
    state.log(LogLevel::Error, message);
}

fn consume_output(owned: &mut OwnedChild, state: &mut Shared) {
    for _ in 0..MAX_EVENTS {
        let Ok(output) = owned.output.try_recv() else {
            break;
        };
        match output {
            Output::Message(Supervision::Health(health))
                if health.pid == owned.child.id() && owned.report.is_none() =>
            {
                if health.lifecycle != "starting" {
                    owned.ready = true;
                }
                state.health_at = Some(Instant::now());
                state.status.health = Some(health);
                if owned.stop_at.is_none() && owned.killed_at.is_none() && owned.ready {
                    state.status.phase = Phase::Running;
                }
            }
            Output::Message(Supervision::Log(level)) => {
                let message = match level {
                    LogLevel::Info => "Host reported a lifecycle update.",
                    LogLevel::Warn => "Host reported a warning.",
                    LogLevel::Error => "Host reported an error.",
                };
                state.log(level, message);
            }
            Output::Message(Supervision::Exit(report)) => {
                if owned.report.is_some() {
                    owned.bad_report = true;
                } else {
                    owned.report = Some(report);
                }
                state.status.phase = Phase::Stopping;
                owned.stop_at.get_or_insert_with(Instant::now);
            }
            _ => {
                state.log(
                    LogLevel::Warn,
                    "An invalid supervision message was ignored.",
                );
            }
        }
    }
}

fn finish_process(owned: &OwnedChild, state: &mut Shared) {
    let actual = owned.ended.as_ref().and_then(|(status, _)| status.code());
    let clean = !owned.forced
        && !owned.bad_report
        && actual == Some(0)
        && owned.report.as_ref().is_some_and(|report| {
            report.code == 0
                && !report.draining
                && matches!(report.reason, ExitReason::Requested | ExitReason::Signal)
        });
    state.status.last_exit = Some(DesktopExit {
        code: actual,
        reason: owned.report.as_ref().map(|report| report.reason.clone()),
        clean,
        forced: owned.forced,
        draining: owned.report.as_ref().map(|report| report.draining),
    });
    state.status.owned = false;
    state.status.phase = if clean { Phase::Stopped } else { Phase::Failed };
    state.health_at = None;
    if clean {
        state.status.error = None;
        state.log(LogLevel::Info, "The owned host stopped cleanly.");
    } else {
        let message = match owned.report.as_ref().map(|report| &report.reason) {
            Some(ExitReason::Singleton) => {
                "Another host already owns this machine. It was left running."
            }
            Some(ExitReason::Config) => "The host rejected its owner configuration.",
            Some(ExitReason::Fatal) => "The owned host reported a fatal failure.",
            _ if owned.forced => "The owned host required forced process-tree cleanup.",
            _ => "The owned host exited without a matching clean exit report.",
        };
        state.status.error = Some(message.into());
        state.log(LogLevel::Error, message);
    }
}

fn complete_if_terminated(
    owned: &mut OwnedChild,
    state: &mut Shared,
    tree_empty: std::io::Result<bool>,
) -> bool {
    let tree_confirmed = match tree_empty {
        Ok(empty) => {
            if !empty && owned.ended.is_some() {
                force_stop(
                    owned,
                    state,
                    "The exited host left owned processes requiring cleanup.",
                );
            }
            empty
        }
        Err(_) => {
            force_stop(
                owned,
                state,
                "The owned process tree could not be inspected safely.",
            );
            false
        }
    };
    let finished = tree_confirmed
        && owned.ended.as_ref().is_some_and(|(_, at)| {
            owned.output_done.load(Ordering::Acquire) || at.elapsed() >= Duration::from_millis(200)
        });
    if !finished
        && owned
            .killed_at
            .is_some_and(|at| at.elapsed() >= KILL_TIMEOUT)
    {
        state.status.phase = Phase::Failed;
        state.status.error = Some(
            "Process-tree termination has not been confirmed. Its ownership is retained; wait and retry closing.".into(),
        );
    }
    if finished {
        consume_output(owned, state);
        finish_process(owned, state);
    }
    finished
}

fn worker(
    spec: LaunchSpec,
    requests: Receiver<Request>,
    shared: Arc<Mutex<Shared>>,
    shutdown: Arc<ShutdownControl>,
) {
    let _completion = WorkerCompletion(Arc::clone(&shutdown));
    let mut process: Option<OwnedChild> = None;
    let mut pending_restart = false;
    let mut shutting_down = false;
    loop {
        let request = requests.recv_timeout(POLL_INTERVAL);
        let mut state = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(owned) = process.as_mut() {
            consume_output(owned, &mut state);
        }
        if shutdown.requested.load(Ordering::Acquire)
            || matches!(request, Err(mpsc::RecvTimeoutError::Disconnected))
        {
            shutting_down = true;
            pending_restart = false;
            if let Some(owned) = process.as_mut() {
                begin_stop(owned, &mut state);
            }
        }
        if let Ok(request) = request {
            match request {
                Request::Start(reply) | Request::Stop(reply) | Request::Restart(reply)
                    if shutting_down || shutdown.requested.load(Ordering::Acquire) =>
                {
                    let _ = reply.send(Err("The supervisor is shutting down.".into()));
                }
                Request::Start(reply) => {
                    let result = if shutting_down || process.is_some() {
                        Err("The supervisor already owns a host or is stopping.".into())
                    } else {
                        start_process(&spec, &mut state).map(|owned| {
                            process = Some(owned);
                            state.snapshot()
                        })
                    };
                    if let Err(error) = &result {
                        if process.is_none() {
                            state.status.phase = Phase::Failed;
                            state.status.error = Some(error.clone());
                        }
                    }
                    let _ = reply.send(result);
                }
                Request::Stop(reply) => {
                    let result = if !state.snapshot().restart_safe {
                        Err("Stop requires fresh idle health from the owned host.".into())
                    } else if let Some(owned) = process.as_mut() {
                        begin_stop(owned, &mut state);
                        Ok(state.snapshot())
                    } else {
                        Err("No host is owned by this supervisor.".into())
                    };
                    let _ = reply.send(result);
                }
                Request::Restart(reply) => {
                    let result = if !state.snapshot().restart_safe {
                        Err("Restart requires fresh idle health from the owned host.".into())
                    } else if let Some(owned) = process.as_mut() {
                        pending_restart = true;
                        begin_stop(owned, &mut state);
                        Ok(state.snapshot())
                    } else {
                        Err("No host is owned by this supervisor.".into())
                    };
                    let _ = reply.send(result);
                }
            }
        }
        let mut finished = false;
        if let Some(owned) = process.as_mut() {
            consume_output(owned, &mut state);
            if owned.ended.is_none() {
                match owned.child.try_wait() {
                    Ok(Some(status)) => {
                        owned.ended = Some((status, Instant::now()));
                        #[cfg(not(windows))]
                        let _ = owned.child.start_kill();
                    }
                    Err(_) => force_stop(
                        owned,
                        &mut state,
                        "The owned host could not be inspected safely.",
                    ),
                    Ok(None) => {}
                }
            }
            if owned.ended.is_none() {
                if !owned.ready && owned.started_at.elapsed() >= START_TIMEOUT {
                    force_stop(
                        owned,
                        &mut state,
                        "The host did not become ready before its deadline.",
                    );
                } else if owned.stop_at.is_some_and(|at| at.elapsed() >= STOP_TIMEOUT) {
                    force_stop(
                        owned,
                        &mut state,
                        "The host did not stop before its deadline.",
                    );
                }
            }
            #[cfg(windows)]
            let tree_empty = kill_on_close::tree_empty(owned.child.as_ref());
            #[cfg(not(windows))]
            let tree_empty = Ok(true);
            finished = complete_if_terminated(owned, &mut state, tree_empty);
        }
        if finished {
            process.take();
            if pending_restart
                && state
                    .status
                    .last_exit
                    .as_ref()
                    .is_some_and(|exit| exit.clean)
                && !shutting_down
                && !shutdown.requested.load(Ordering::Acquire)
            {
                match start_process(&spec, &mut state) {
                    Ok(owned) => process = Some(owned),
                    Err(error) => {
                        state.status.phase = Phase::Failed;
                        state.status.error = Some(error);
                    }
                }
            }
            pending_restart = false;
        }
        if shutting_down && process.is_none() {
            while let Ok(request) = requests.try_recv() {
                let (Request::Start(reply) | Request::Stop(reply) | Request::Restart(reply)) =
                    request;
                let _ = reply.send(Err("The supervisor is shutting down.".into()));
            }
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[derive(Debug)]
    struct ExitedChild;

    impl ChildWrapper for ExitedChild {
        fn inner(&self) -> &dyn ChildWrapper {
            self
        }
        fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
            self
        }
        fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
            self
        }
        fn start_kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn exited_parent() -> (OwnedChild, Shared) {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        let (_, output) = mpsc::sync_channel(1);
        let mut state = Shared::default();
        state.status.owned = true;
        state.status.phase = Phase::Stopping;
        (
            OwnedChild {
                child: Box::new(ExitedChild),
                stdin: None,
                output,
                output_done: Arc::new(AtomicBool::new(true)),
                started_at: Instant::now(),
                stop_at: Some(Instant::now()),
                killed_at: None,
                ended: Some((ExitStatus::from_raw(0), Instant::now())),
                report: Some(HostExit {
                    code: 0,
                    reason: ExitReason::Requested,
                    draining: false,
                }),
                forced: false,
                ready: true,
                bad_report: false,
            },
            state,
        )
    }

    #[test]
    fn pending_descendants_retain_ownership_and_block_clean_restart() {
        let (mut owned, mut state) = exited_parent();
        owned.output_done.store(false, Ordering::Release);
        owned.ended.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(1);
        assert!(!complete_if_terminated(&mut owned, &mut state, Ok(false)));
        owned.output_done.store(true, Ordering::Release);
        assert!(!complete_if_terminated(&mut owned, &mut state, Ok(false)));
        assert!(state.status.owned);
        assert!(!state.snapshot().restart_safe);
        assert!(state.status.last_exit.is_none());
        assert!(owned.forced);
        assert!(owned.killed_at.is_some());
        assert!(complete_if_terminated(&mut owned, &mut state, Ok(true)));
        let exit = state.status.last_exit.as_ref().unwrap();
        assert!(!exit.clean && exit.forced);
        assert_eq!(exit.code, Some(0));
        assert_eq!(exit.reason, Some(ExitReason::Requested));
        assert_eq!(exit.draining, Some(false));
    }

    #[test]
    fn unconfirmed_tree_keeps_fixed_deadline_and_owned_failure() {
        for inspection_failed in [false, true] {
            let (mut owned, mut state) = exited_parent();
            let inspection = || {
                if inspection_failed {
                    Err(std::io::Error::other("job accounting unavailable"))
                } else {
                    Ok(false)
                }
            };
            assert!(!complete_if_terminated(
                &mut owned,
                &mut state,
                inspection()
            ));
            let expired = Instant::now() - KILL_TIMEOUT - Duration::from_millis(1);
            owned.killed_at = Some(expired);
            for _ in 0..3 {
                assert!(!complete_if_terminated(
                    &mut owned,
                    &mut state,
                    inspection()
                ));
                assert_eq!(owned.killed_at, Some(expired));
                assert_eq!(state.status.phase, Phase::Failed);
                assert!(state.status.owned);
                assert!(!state.snapshot().restart_safe);
                assert!(state.status.last_exit.is_none());
                assert!(state.status.error.as_ref().unwrap().contains("ownership"));
            }
            assert!(complete_if_terminated(&mut owned, &mut state, Ok(true)));
            assert!(!state.status.owned);
            let exit = state.status.last_exit.unwrap();
            assert!(exit.forced && !exit.clean);
        }
    }

    #[test]
    fn confirmed_empty_tree_preserves_clean_parent_exit() {
        let (mut owned, mut state) = exited_parent();
        assert!(complete_if_terminated(&mut owned, &mut state, Ok(true)));
        assert!(!state.status.owned);
        let exit = state.status.last_exit.unwrap();
        assert!(exit.clean && !exit.forced);
        assert_eq!(exit.code, Some(0));
    }

    const FAKE_HOST: &str = r#"
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
const output = (message) => process.stdout.write('zch ' + JSON.stringify({v: 1, ...message}) + '\n');
const busy = config.mode === 'busy';
const health = () => output({type:'health', at:new Date().toISOString(), hostVersion:'fixture', hostGeneration:'typescript-node', hostId:'5f6c2f7a-0b3e-4d21-9a1c-2b7c9e0a1d33', pid:process.pid, port:null, lifecycle:busy ? 'draining' : 'ready', draining:busy, leaseHealthy:false, councilCode:busy ? 'CN-73YD' : null, agents:0, uptimeMs:1});
let exiting = false;
let descendant = null;
const finish = async () => {
    if (exiting || config.mode === 'hang-stop' || config.mode === 'hang-start' || config.mode === 'tree-hang') return;
    exiting = true;
    if (config.mode === 'tree-clean') {
        await new Promise((resolve) => { descendant.once('exit', resolve); descendant.kill(); });
    }
    output({type:'exit', at:new Date().toISOString(), code:0, reason:'requested', detail:'private path must not escape', councilCode:null, draining:busy});
    setTimeout(() => process.exit(0), 20);
};
if (config.mode === 'singleton') {
    output({type:'exit', at:new Date().toISOString(), code:1, reason:'singleton', detail:'private manual host path', councilCode:null, draining:false});
    setTimeout(() => process.exit(1), 20);
} else {
    if (config.mode === 'delayed-ready') setTimeout(() => { health(); setInterval(health, 100); }, 3000);
    else if (config.mode !== 'hang-start') { health(); setInterval(health, 100); }
    else setInterval(() => {}, 100);
    output({type:'log', level:'warn', at:new Date().toISOString(), message:'private-secret-material'});
    process.stderr.write('private-secret-material\n');
    if (config.mode.startsWith('tree')) {
        descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore', detached:process.platform === 'win32', windowsHide:true});
        writeFileSync(config.pidFile, String(descendant.pid));
    }
    if (config.mode === 'unreported') setTimeout(() => process.exit(0), 100);
    process.stdin.on('data', finish);
    process.stdin.on('end', finish);
    process.stdin.resume();
}
"#;

    struct Fixture {
        supervisor: Supervisor,
        root: tempfile::TempDir,
        node: PathBuf,
    }

    const FIXTURE_SLACK: Duration = Duration::from_secs(3);
    const DESCENDANT_TIMEOUT: Duration = Duration::from_secs(3);

    #[derive(Clone, Copy, Debug)]
    enum FixtureWait {
        Ready,
        Restart,
        StartFailure,
        Stopped,
    }

    impl FixtureWait {
        fn timeout(self) -> Duration {
            match self {
                Self::Ready => START_TIMEOUT + FIXTURE_SLACK,
                Self::Restart => STOP_TIMEOUT + KILL_TIMEOUT + START_TIMEOUT + FIXTURE_SLACK,
                Self::StartFailure => START_TIMEOUT + KILL_TIMEOUT + FIXTURE_SLACK,
                Self::Stopped => STOP_TIMEOUT + KILL_TIMEOUT + FIXTURE_SLACK,
            }
        }
    }

    #[cfg(windows)]
    fn abrupt_helper_timeout() -> Duration {
        let shutdown_timeout = STOP_TIMEOUT + KILL_TIMEOUT + Duration::from_secs(3);
        FixtureWait::Ready.timeout() + DESCENDANT_TIMEOUT + shutdown_timeout + FIXTURE_SLACK
    }

    impl Fixture {
        fn new(node: &std::path::Path, mode: &str) -> Self {
            Self::with_root(node, mode, tempfile::tempdir().unwrap())
        }

        fn with_root(node: &std::path::Path, mode: &str, root: tempfile::TempDir) -> Self {
            let repo = root.path().join("repo");
            std::fs::create_dir_all(repo.join("scripts")).unwrap();
            std::fs::create_dir_all(repo.join("node_modules/tsx")).unwrap();
            std::fs::write(repo.join("scripts/council-host.mts"), FAKE_HOST).unwrap();
            std::fs::write(
                repo.join("node_modules/tsx/package.json"),
                r#"{"name":"tsx","type":"module","exports":"./index.js"}"#,
            )
            .unwrap();
            std::fs::write(repo.join("node_modules/tsx/index.js"), "").unwrap();
            let config = root.path().join("host.json");
            std::fs::write(
                &config,
                serde_json::json!({"mode":mode,"pidFile":root.path().join("descendant.pid")})
                    .to_string(),
            )
            .unwrap();
            let env_file = root.path().join("host.env");
            std::fs::write(&env_file, "").unwrap();
            Self {
                supervisor: Supervisor::new(LaunchSpec {
                    node: node.to_owned(),
                    repo,
                    config,
                    env_file,
                    launch: HostLaunch::default(),
                }),
                root,
                node: node.to_owned(),
            }
        }

        fn descendant_pid(&self) -> u32 {
            let pid_file = self.root.path().join("descendant.pid");
            let deadline = Instant::now() + DESCENDANT_TIMEOUT;
            while !pid_file.exists() {
                assert!(Instant::now() < deadline);
                thread::sleep(POLL_INTERVAL);
            }
            std::fs::read_to_string(pid_file).unwrap().parse().unwrap()
        }

        fn wait(
            &self,
            operation: FixtureWait,
            predicate: impl Fn(&DesktopHostStatus) -> bool,
        ) -> DesktopHostStatus {
            let deadline = Instant::now() + operation.timeout();
            loop {
                let status = self.supervisor.status();
                if predicate(&status) {
                    return status;
                }
                assert!(
                    status.phase != Phase::Failed || status.owned,
                    "fixture {operation:?} reached unexpected terminal failure: {status:?}"
                );
                assert!(
                    Instant::now() < deadline,
                    "fixture {operation:?} deadline: {status:?}"
                );
                thread::sleep(Duration::from_millis(25));
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.supervisor.shutdown();
        }
    }

    const DIAGNOSTIC_TAIL_BYTES: usize = 4_096;

    struct DiagnosticCapture {
        tail: Arc<Mutex<VecDeque<u8>>>,
        done: Arc<AtomicBool>,
    }

    impl DiagnosticCapture {
        fn start(mut stream: impl Read + Send + 'static) -> Self {
            let tail = Arc::new(Mutex::new(VecDeque::with_capacity(DIAGNOSTIC_TAIL_BYTES)));
            let done = Arc::new(AtomicBool::new(false));
            let reader_tail = Arc::clone(&tail);
            let reader_done = Arc::clone(&done);
            thread::spawn(move || {
                let mut chunk = [0; 1_024];
                while let Ok(size) = stream.read(&mut chunk) {
                    if size == 0 {
                        break;
                    }
                    let mut bytes = reader_tail
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    for byte in &chunk[..size] {
                        if bytes.len() == DIAGNOSTIC_TAIL_BYTES {
                            bytes.pop_front();
                        }
                        bytes.push_back(*byte);
                    }
                }
                reader_done.store(true, Ordering::Release);
            });
            Self { tail, done }
        }

        fn snapshot(&self, private_values: &[&str]) -> String {
            let Ok(bytes) = self.tail.try_lock() else {
                return "[diagnostic snapshot busy]".into();
            };
            let raw: Vec<_> = bytes.iter().copied().collect();
            drop(bytes);
            let mut text = String::from_utf8_lossy(&raw).into_owned();
            for value in private_values
                .iter()
                .copied()
                .chain(["private-secret-material"])
            {
                if !value.is_empty() {
                    text = text.replace(value, "[REDACTED]");
                }
            }
            text.chars()
                .filter(|value| !value.is_control() || *value == '\n')
                .collect()
        }

        fn finished(&self) -> bool {
            self.done.load(Ordering::Acquire)
        }
    }

    #[test]
    fn helper_diagnostics_are_bounded_redacted_and_readable_before_eof() {
        struct HeldReader {
            prefix: Cursor<Vec<u8>>,
            release: Receiver<()>,
        }
        impl Read for HeldReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let size = self.prefix.read(buffer)?;
                if size == 0 {
                    let _ = self.release.recv();
                }
                Ok(size)
            }
        }
        let (release, receiver) = mpsc::channel();
        let input = format!(
            "{}private-secret-material /private/fixture-path end",
            "x".repeat(DIAGNOSTIC_TAIL_BYTES * 2)
        );
        let capture = DiagnosticCapture::start(HeldReader {
            prefix: Cursor::new(input.into_bytes()),
            release: receiver,
        });
        let deadline = Instant::now() + KILL_TIMEOUT;
        loop {
            let text = capture.snapshot(&["/private/fixture-path"]);
            if text.ends_with("end") {
                assert!(text.len() <= DIAGNOSTIC_TAIL_BYTES);
                assert!(!text.contains("private-secret-material"));
                assert!(!text.contains("/private/fixture-path"));
                assert!(!capture.finished());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "diagnostics were blocked before EOF"
            );
            thread::sleep(POLL_INTERVAL);
        }
        drop(release);
        let deadline = Instant::now() + KILL_TIMEOUT;
        while !capture.finished() {
            assert!(
                Instant::now() < deadline,
                "diagnostic reader did not finish after EOF"
            );
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn assert_pid_stopped(node: &std::path::Path, pid: u32) {
        let mut probe = Command::new(node);
        probe.env_clear();
        for (key, value) in
            std::env::vars_os().filter(|(key, _)| inherited_environment_key(&key.to_string_lossy()))
        {
            probe.env(key, value);
        }
        probe.arg("-e").arg("try { process.kill(Number(process.argv[1]), 0); process.exit(1); } catch (error) { process.exit(error.code === 'ESRCH' ? 0 : 2); }").arg(pid.to_string())
            .stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            probe.creation_flags(0x08000000);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let result = probe.status().unwrap();
            match result.code() {
                Some(0) => break,
                Some(1) => {}
                code => panic!("process liveness probe failed with exit code {code:?}"),
            }
            assert!(
                Instant::now() < deadline,
                "owned process survived supervisor exit"
            );
            thread::sleep(POLL_INTERVAL);
        }
    }

    #[cfg(windows)]
    fn assert_pid_running_now(pid: u32, expected: bool) {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows::Win32::{
            Foundation::{ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };
        let running = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
            Ok(handle) => {
                let _owned = unsafe { OwnedHandle::from_raw_handle(handle.0) };
                match unsafe { WaitForSingleObject(handle, 0) } {
                    WAIT_OBJECT_0 => false,
                    WAIT_TIMEOUT => true,
                    result => panic!("unexpected process wait result: {result:?}"),
                }
            }
            Err(error) => {
                assert_eq!(error.code(), ERROR_INVALID_PARAMETER.to_hresult());
                false
            }
        };
        assert_eq!(running, expected, "owned PID {pid} liveness mismatch");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires COUNCIL_TEST_NODE pointing to a local Node 24+ runtime"]
    fn tree_restart_requires_clean_descendant_exit() {
        let node =
            PathBuf::from(std::env::var_os("COUNCIL_TEST_NODE").expect("set COUNCIL_TEST_NODE"));
        for mode in ["tree", "tree-clean"] {
            let fixture = Fixture::new(&node, mode);
            fixture.supervisor.start().unwrap();
            let ready = fixture.wait(FixtureWait::Ready, |status| status.restart_safe);
            let parent = ready.health.unwrap().pid;
            let descendant = fixture.descendant_pid();
            assert_pid_running_now(descendant, true);
            fixture.supervisor.restart().unwrap();
            if mode == "tree" {
                let stopped = fixture.wait(FixtureWait::Stopped, |status| !status.owned);
                let exit = stopped.last_exit.unwrap();
                assert!(!exit.clean && exit.forced);
                assert_eq!(exit.code, Some(0));
                assert_eq!(stopped.phase, Phase::Failed);
            } else {
                fixture.wait(FixtureWait::Restart, |status| {
                    status.restart_safe
                        && status
                            .health
                            .as_ref()
                            .is_some_and(|health| health.pid != parent)
                });
            }
            assert_pid_running_now(parent, false);
            assert_pid_running_now(descendant, false);
            let mut current_descendant = fixture.descendant_pid();
            if mode == "tree-clean" {
                let deadline = Instant::now() + DESCENDANT_TIMEOUT;
                while current_descendant == descendant {
                    assert!(Instant::now() < deadline);
                    thread::sleep(POLL_INTERVAL);
                    current_descendant = fixture.descendant_pid();
                }
            }
            let stopped = fixture.supervisor.shutdown().unwrap();
            assert_pid_running_now(current_descendant, false);
            assert_eq!(stopped.last_exit.unwrap().clean, mode == "tree-clean");
        }
    }

    #[test]
    fn full_command_queue_cannot_drop_shutdown_or_start_afterwards() {
        let (requests, receiver) = mpsc::sync_channel(8);
        let shared = Arc::new(Mutex::new(Shared::default()));
        let shutdown = Arc::new(ShutdownControl::default());
        let mut results = Vec::new();
        for _ in 0..8 {
            let (reply, result) = mpsc::sync_channel(1);
            requests.try_send(Request::Start(reply)).unwrap();
            results.push(result);
        }
        let supervisor = Arc::new(Supervisor {
            requests,
            shared: Arc::clone(&shared),
            shutdown: Arc::clone(&shutdown),
        });
        let closing = Arc::clone(&supervisor);
        let close = thread::spawn(move || closing.shutdown());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !shutdown.requested.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            thread::sleep(POLL_INTERVAL);
        }
        assert!(
            !close.is_finished(),
            "initial stopped status is not a shutdown acknowledgement"
        );
        let spec = LaunchSpec {
            node: PathBuf::new(),
            repo: PathBuf::new(),
            config: PathBuf::new(),
            env_file: PathBuf::new(),
            launch: HostLaunch::default(),
        };
        let worker_thread = thread::spawn(move || worker(spec, receiver, shared, shutdown));
        assert!(!close.join().unwrap().unwrap().owned);
        worker_thread.join().unwrap();
        for result in results {
            assert_eq!(
                result.recv().unwrap().unwrap_err(),
                "The supervisor is shutting down."
            );
        }
        assert!(supervisor.start().is_err());
        assert_eq!(supervisor.status().phase, Phase::Stopped);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess helper for abrupt_supervisor_exit_kills_owned_tree"]
    fn abrupt_supervisor_fixture_helper() {
        let Some(out) = std::env::var_os("COUNCIL_ABORT_FIXTURE") else {
            return;
        };
        let node = PathBuf::from(std::env::var_os("COUNCIL_TEST_NODE").unwrap());
        let fixture = Fixture::with_root(&node, "tree-hang", tempfile::tempdir_in(&out).unwrap());
        fixture.supervisor.start().unwrap();
        let ready = fixture.wait(FixtureWait::Ready, |status| status.restart_safe);
        let pid_file = fixture.root.path().join("descendant.pid");
        let deadline = Instant::now() + DESCENDANT_TIMEOUT;
        while !pid_file.exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(POLL_INTERVAL);
        }
        let descendant: u32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
        std::fs::write(
            PathBuf::from(out).join("pids.json"),
            serde_json::json!({"host":ready.health.unwrap().pid,"descendant":descendant})
                .to_string(),
        )
        .unwrap();
        // process::exit skips all Rust destructors and graceful shutdown.
        std::process::exit(0);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires COUNCIL_TEST_NODE pointing to a local Node 24+ runtime"]
    fn abrupt_supervisor_exit_kills_owned_tree() {
        use std::os::windows::process::CommandExt;
        let node =
            PathBuf::from(std::env::var_os("COUNCIL_TEST_NODE").expect("set COUNCIL_TEST_NODE"));
        let out = tempfile::tempdir().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.env_clear();
        for (key, value) in
            std::env::vars_os().filter(|(key, _)| inherited_environment_key(&key.to_string_lossy()))
        {
            command.env(key, value);
        }
        command
            .env("COUNCIL_TEST_NODE", &node)
            .env("COUNCIL_ABORT_FIXTURE", out.path())
            .args([
                "--exact",
                "supervisor::tests::abrupt_supervisor_fixture_helper",
                "--ignored",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000);
        let mut helper = command.spawn().unwrap();
        let stdout = DiagnosticCapture::start(helper.stdout.take().unwrap());
        let stderr = DiagnosticCapture::start(helper.stderr.take().unwrap());
        let deadline = Instant::now() + abrupt_helper_timeout();
        let mut timed_out = false;
        let result = loop {
            if let Some(result) = helper.try_wait().unwrap() {
                break result;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                let _ = helper.kill();
                break helper.wait().unwrap();
            }
            thread::sleep(POLL_INTERVAL);
        };
        let diagnostics_deadline = Instant::now() + KILL_TIMEOUT;
        while !(stdout.finished() && stderr.finished()) && Instant::now() < diagnostics_deadline {
            thread::sleep(POLL_INTERVAL);
        }
        let temporary_root = std::env::temp_dir();
        let private_paths = [
            out.path(),
            node.as_path(),
            temporary_root.as_path(),
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
        ]
        .map(|path| path.to_string_lossy().into_owned());
        let private_values: Vec<_> = private_paths.iter().map(String::as_str).collect();
        assert!(
            !timed_out && result.success(),
            "abrupt-exit helper failed: timeout={timed_out}, exit={:?}, readers_finished={}, stdout={}, stderr={}",
            result.code(), stdout.finished() && stderr.finished(), stdout.snapshot(&private_values), stderr.snapshot(&private_values),
        );
        let pids: serde_json::Value =
            serde_json::from_slice(&std::fs::read(out.path().join("pids.json")).unwrap()).unwrap();
        assert_pid_stopped(&node, pids["host"].as_u64().unwrap() as u32);
        assert_pid_stopped(&node, pids["descendant"].as_u64().unwrap() as u32);
    }

    #[test]
    fn environment_drops_runtime_overrides_and_credentials() {
        for key in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "TSX_TSCONFIG_PATH",
            "MCP_COUNCIL_HOST_KEY",
            "OPENAI_API_KEY",
            "ZUYCHIN_HOST_LAUNCH",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
        ] {
            assert!(!inherited_environment_key(key), "{key}");
        }
        for key in ["Path", "SystemRoot", "USERPROFILE", "HOME", "TEMP"] {
            assert!(inherited_environment_key(key));
        }
    }

    #[test]
    fn reader_bounds_lines_and_does_not_forward_private_content() {
        let raw = format!("{}\nzch {{\"v\":1,\"type\":\"log\",\"level\":\"info\",\"message\":\"secret material\"}}\n", "x".repeat(contract::MAX_LINE_BYTES + 1));
        let (sender, receiver) = mpsc::sync_channel(4);
        let done = Arc::new(AtomicBool::new(false));
        read_output(Cursor::new(raw), sender, Arc::clone(&done));
        assert!(matches!(receiver.try_recv(), Ok(Output::Invalid)));
        assert!(matches!(
            receiver.try_recv(),
            Ok(Output::Message(Supervision::Log(LogLevel::Info)))
        ));
        assert!(done.load(Ordering::Acquire));
    }

    #[test]
    fn restart_requires_owned_fresh_idle_health() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/council/supervisor-v1.json"))
                .unwrap();
        let Supervision::Health(health) =
            contract::parse_supervision(fixture["supervisionValid"][0]["line"].as_str().unwrap())
                .unwrap()
                .unwrap()
        else {
            panic!()
        };
        let mut state = Shared::default();
        state.status.phase = Phase::Running;
        state.status.owned = true;
        state.status.health = Some(health);
        state.health_at = Some(Instant::now());
        assert!(state.snapshot().restart_safe);
        state.status.health.as_mut().unwrap().draining = true;
        assert!(!state.snapshot().restart_safe);
        state.status.health.as_mut().unwrap().draining = false;
        state.health_at = Some(Instant::now() - HEALTH_FRESHNESS - Duration::from_secs(1));
        assert!(!state.snapshot().restart_safe);
        state.health_at = Some(Instant::now());
        state.status.owned = false;
        assert!(!state.snapshot().restart_safe);
    }

    #[test]
    fn logs_are_bounded_canned_events() {
        let mut state = Shared::default();
        for _ in 0..100 {
            state.log(LogLevel::Info, "Host reported a lifecycle update.");
            state.log(LogLevel::Warn, "Host reported a warning.");
        }
        assert_eq!(state.status.logs.len(), MAX_EVENTS);
        assert!(!serde_json::to_string(&state.status)
            .unwrap()
            .contains("secret material"));
    }

    #[test]
    #[ignore = "requires COUNCIL_TEST_NODE pointing to a local Node 24+ runtime"]
    fn delayed_valid_health_uses_production_startup_allowance() {
        let node =
            PathBuf::from(std::env::var_os("COUNCIL_TEST_NODE").expect("set COUNCIL_TEST_NODE"));
        let fixture = Fixture::new(&node, "delayed-ready");
        let started = Instant::now();
        fixture.supervisor.start().unwrap();
        let ready = fixture.wait(FixtureWait::Ready, |status| status.restart_safe);
        assert!(started.elapsed() >= Duration::from_secs(3));
        assert!(ready.owned && ready.health.is_some());
        let stopped = fixture.supervisor.shutdown().unwrap();
        assert!(!stopped.owned);
        assert!(stopped.last_exit.unwrap().clean);
    }

    #[test]
    #[ignore = "requires COUNCIL_TEST_NODE pointing to a local Node 24+ runtime"]
    fn isolated_node_lifecycle_and_descendant_cleanup() {
        let node =
            PathBuf::from(std::env::var_os("COUNCIL_TEST_NODE").expect("set COUNCIL_TEST_NODE"));
        assert!(node.is_absolute() && node.is_file());
        {
            let fixture = Fixture::new(&node, "ready");
            fixture.supervisor.start().unwrap();
            let ready = fixture.wait(FixtureWait::Ready, |status| status.restart_safe);
            let first_pid = ready.health.unwrap().pid;
            fixture.supervisor.restart().unwrap();
            let restarted = fixture.wait(FixtureWait::Restart, |status| {
                status.restart_safe
                    && status
                        .health
                        .as_ref()
                        .is_some_and(|health| health.pid != first_pid)
            });
            assert!(!serde_json::to_string(&restarted)
                .unwrap()
                .contains("private-secret-material"));
            fixture.supervisor.stop().unwrap();
            assert!(
                fixture
                    .wait(FixtureWait::Stopped, |status| !status.owned)
                    .last_exit
                    .unwrap()
                    .clean
            );
        }
        {
            let fixture = Fixture::new(&node, "busy");
            fixture.supervisor.start().unwrap();
            fixture.wait(FixtureWait::Ready, |status| status.phase == Phase::Running);
            assert!(fixture.supervisor.stop().is_err());
            assert!(fixture.supervisor.restart().is_err());
            let stopped = fixture.supervisor.shutdown().unwrap();
            assert!(!stopped.owned);
            let exit = stopped.last_exit.unwrap();
            assert!(!exit.clean && !exit.forced && exit.draining == Some(true));
        }
        for mode in ["unreported", "hang-start", "singleton"] {
            let fixture = Fixture::new(&node, mode);
            fixture.supervisor.start().unwrap();
            let failed = fixture.wait(FixtureWait::StartFailure, |status| {
                status.phase == Phase::Failed && !status.owned
            });
            let exit = failed.last_exit.unwrap();
            assert!(!exit.clean);
            assert_eq!(exit.forced, mode == "hang-start");
            if mode == "singleton" {
                assert_eq!(exit.reason, Some(ExitReason::Singleton));
            }
            if mode == "unreported" {
                assert_eq!(exit.code, Some(0));
                assert_eq!(exit.reason, None);
            }
        }
        {
            let fixture = Fixture::new(&node, "hang-stop");
            fixture.supervisor.start().unwrap();
            fixture.wait(FixtureWait::Ready, |status| status.restart_safe);
            fixture.supervisor.restart().unwrap();
            let failed = fixture.wait(FixtureWait::Stopped, |status| {
                status.phase == Phase::Failed && !status.owned
            });
            assert!(failed.last_exit.unwrap().forced);
        }
        {
            let fixture = Fixture::new(&node, "tree");
            fixture.supervisor.start().unwrap();
            fixture.wait(FixtureWait::Ready, |status| status.restart_safe);
            let descendant = fixture.descendant_pid();
            #[cfg(windows)]
            assert_pid_running_now(descendant, true);
            let stopped = fixture.supervisor.shutdown().unwrap();
            #[cfg(windows)]
            assert_pid_running_now(descendant, false);
            assert!(!stopped.owned);
            let exit = stopped.last_exit.unwrap();
            assert_eq!(exit.forced, cfg!(windows));
            assert_eq!(exit.clean, !cfg!(windows));
            assert_pid_stopped(&fixture.node, descendant);
        }
    }
}
