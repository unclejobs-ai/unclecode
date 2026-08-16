use serde_json::{json, Value};
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BACKGROUND_JOB_FILENAME: &str = "background-job.json";
const BACKGROUND_STDOUT_FILENAME: &str = "background.stdout.log";
const BACKGROUND_STDERR_FILENAME: &str = "background.stderr.log";
const BACKGROUND_CHILD_ENV: &str = "UNCLECODE_TEAM_BACKGROUND_CHILD";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackgroundRunRequest {
    pub objective: String,
    pub persona: String,
    pub lanes: String,
    pub gate: String,
    pub runtime: String,
    pub isolation: String,
    pub quiet: bool,
    pub worker_timeout_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackgroundJob {
    pub run_id: String,
    pub run_root: PathBuf,
    pub workspace_root: PathBuf,
    pub pid: u32,
    pub process_identity: Option<String>,
    pub state: String,
    pub request: BackgroundRunRequest,
    pub stdout_log: PathBuf,
    pub stderr_log: PathBuf,
    pub exit_code: Option<u8>,
    pub message: Option<String>,
    pub created_at: u128,
    pub updated_at: u128,
}

pub struct BackgroundLaunch {
    pub pid: u32,
    pub stdout_log: PathBuf,
    pub stderr_log: PathBuf,
}

pub fn is_background_child() -> bool {
    env::var(BACKGROUND_CHILD_ENV).ok().as_deref() == Some("1")
}

pub fn launch_background_job(
    current_exe: &Path,
    data_root: &Path,
    run_root: &Path,
    run_id: &str,
    workspace_root: &Path,
    request: BackgroundRunRequest,
) -> Result<BackgroundLaunch, String> {
    fs::create_dir_all(run_root)
        .map_err(|error| format!("Failed to create {}: {error}", run_root.display()))?;
    let stdout_log = run_root.join(BACKGROUND_STDOUT_FILENAME);
    let stderr_log = run_root.join(BACKGROUND_STDERR_FILENAME);
    let created_at = current_millis();
    let mut job = BackgroundJob {
        run_id: run_id.to_string(),
        run_root: run_root.to_path_buf(),
        workspace_root: workspace_root.to_path_buf(),
        pid: 0,
        process_identity: None,
        state: "starting".to_string(),
        request,
        stdout_log: stdout_log.clone(),
        stderr_log: stderr_log.clone(),
        exit_code: None,
        message: None,
        created_at,
        updated_at: created_at,
    };
    write_background_job(&job)?;

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_log)
        .map_err(|error| format!("Failed to open {}: {error}", stdout_log.display()))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_log)
        .map_err(|error| format!("Failed to open {}: {error}", stderr_log.display()))?;
    let mut command = Command::new(current_exe);
    command
        .args(build_child_args(run_id, &job.request))
        .current_dir(workspace_root)
        .env(BACKGROUND_CHILD_ENV, "1")
        .env("UNCLECODE_DATA_ROOT", data_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            job.state = "errored".to_string();
            job.message = Some(format!("Failed to launch background coordinator: {error}"));
            job.updated_at = current_millis();
            write_background_job(&job)?;
            return Err(job.message.unwrap_or_default());
        }
    };

    job.pid = child.id();
    job.process_identity = read_process_identity(job.pid);
    if job.process_identity.is_none() {
        let _ = terminate_process_group(job.pid);
        job.state = "errored".to_string();
        job.message = Some(format!(
            "Failed to verify background coordinator process {}",
            job.pid
        ));
        job.updated_at = current_millis();
        write_background_job(&job)?;
        return Err(job.message.unwrap_or_default());
    }
    job.state = "running".to_string();
    job.updated_at = current_millis();
    write_background_job(&job)?;
    Ok(BackgroundLaunch {
        pid: job.pid,
        stdout_log,
        stderr_log,
    })
}

pub fn wait_for_background_job(run_root: &Path) -> Result<BackgroundJob, String> {
    for _ in 0..100 {
        if let Ok(job) = read_background_job(run_root) {
            if job.pid > 0 {
                return Ok(job);
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(format!(
        "Background job did not become ready: {}",
        run_root.display()
    ))
}

pub fn complete_background_job(
    run_root: &Path,
    outcome: &Result<u8, String>,
) -> Result<(), String> {
    let mut job = read_background_job(run_root)?;
    match outcome {
        Ok(0) => {
            job.state = "accepted".to_string();
            job.exit_code = Some(0);
            job.message = None;
        }
        Ok(code) => {
            job.state = "errored".to_string();
            job.exit_code = Some(*code);
            job.message = Some(format!("Background coordinator exited with code {code}"));
        }
        Err(error) => {
            job.state = "errored".to_string();
            job.exit_code = Some(1);
            job.message = Some(error.clone());
        }
    }
    job.updated_at = current_millis();
    write_background_job(&job)
}

pub fn format_background_job_status(
    data_root: &Path,
    run_id: &str,
) -> Result<Option<String>, String> {
    let Some(job) = load_background_job(data_root, run_id)? else {
        return Ok(None);
    };
    let state = effective_state(&job);
    let mut lines = vec![
        format!("Background: {state}"),
        format!("PID:        {}", job.pid),
        format!("Stdout:     {}", job.stdout_log.display()),
        format!("Stderr:     {}", job.stderr_log.display()),
    ];
    if let Some(code) = job.exit_code {
        lines.push(format!("Exit code:  {code}"));
    }
    if let Some(message) = job.message.as_deref() {
        lines.push(format!("Message:    {message}"));
    }
    Ok(Some(format!("{}\n", lines.join("\n"))))
}

pub fn terminate_background_job(data_root: &Path, run_id: &str) -> Result<Option<u32>, String> {
    let Some(mut job) = load_background_job(data_root, run_id)? else {
        return Ok(None);
    };
    if matches!(job.state.as_str(), "starting" | "running") && is_pid_alive(job.pid) {
        terminate_background_process(&job, 100)?;
    }
    job.state = "cancelled".to_string();
    job.exit_code = None;
    job.message = Some("Cancelled by `unclecode team abort`".to_string());
    job.updated_at = current_millis();
    write_background_job(&job)?;
    Ok(Some(job.pid))
}

pub fn background_restart_request(
    data_root: &Path,
    run_id: &str,
) -> Result<(BackgroundRunRequest, PathBuf), String> {
    let job = load_background_job(data_root, run_id)?
        .ok_or_else(|| format!("Run {run_id} is not a background job"))?;
    if matches!(job.state.as_str(), "starting" | "running") && matches_background_process(&job) {
        return Err(format!(
            "Background run {run_id} is still running with PID {}",
            job.pid
        ));
    }
    Ok((job.request, job.workspace_root))
}

fn build_child_args(run_id: &str, request: &BackgroundRunRequest) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("team"),
        OsString::from("run"),
        OsString::from("--dispatch"),
        OsString::from("--record"),
        OsString::from(run_id),
        OsString::from("--persona"),
        OsString::from(&request.persona),
        OsString::from("--lanes"),
        OsString::from(&request.lanes),
        OsString::from("--gate"),
        OsString::from(&request.gate),
        OsString::from("--runtime"),
        OsString::from(&request.runtime),
        OsString::from("--isolation"),
        OsString::from(&request.isolation),
        OsString::from("--worker-timeout"),
        OsString::from(request.worker_timeout_ms.to_string()),
    ];
    if request.quiet {
        args.push(OsString::from("--quiet"));
    }
    args.push(OsString::from("--"));
    args.push(OsString::from(&request.objective));
    args
}

fn load_background_job(data_root: &Path, run_id: &str) -> Result<Option<BackgroundJob>, String> {
    validate_run_id(run_id)?;
    let run_root = data_root.join("team-runs").join(run_id);
    let path = run_root.join(BACKGROUND_JOB_FILENAME);
    if !path.is_file() {
        return Ok(None);
    }
    read_background_job(&run_root).map(Some)
}

fn read_background_job(run_root: &Path) -> Result<BackgroundJob, String> {
    let path = run_root.join(BACKGROUND_JOB_FILENAME);
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid background job {}: {error}", path.display()))?;
    let request = value
        .get("request")
        .ok_or_else(|| format!("Background job {} is missing request", path.display()))?;
    Ok(BackgroundJob {
        run_id: required_string(&value, "runId")?,
        run_root: PathBuf::from(required_string(&value, "runRoot")?),
        workspace_root: PathBuf::from(required_string(&value, "workspaceRoot")?),
        pid: required_u64(&value, "pid")?
            .try_into()
            .map_err(|_| format!("Background job {} has an invalid pid", path.display()))?,
        process_identity: value
            .get("processIdentity")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        state: required_string(&value, "state")?,
        request: BackgroundRunRequest {
            objective: required_string(request, "objective")?,
            persona: required_string(request, "persona")?,
            lanes: required_string(request, "lanes")?,
            gate: required_string(request, "gate")?,
            runtime: required_string(request, "runtime")?,
            isolation: required_string(request, "isolation")?,
            quiet: request
                .get("quiet")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            worker_timeout_ms: required_u64(request, "workerTimeoutMs")?,
        },
        stdout_log: PathBuf::from(required_string(&value, "stdoutLog")?),
        stderr_log: PathBuf::from(required_string(&value, "stderrLog")?),
        exit_code: value
            .get("exitCode")
            .and_then(Value::as_u64)
            .and_then(|code| u8::try_from(code).ok()),
        message: value
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
        created_at: required_u64(&value, "createdAt")? as u128,
        updated_at: required_u64(&value, "updatedAt")? as u128,
    })
}

fn write_background_job(job: &BackgroundJob) -> Result<(), String> {
    let path = job.run_root.join(BACKGROUND_JOB_FILENAME);
    let value = json!({
        "version": 1,
        "runId": job.run_id,
        "runRoot": job.run_root,
        "workspaceRoot": job.workspace_root,
        "pid": job.pid,
        "processIdentity": job.process_identity,
        "state": job.state,
        "request": {
            "objective": job.request.objective,
            "persona": job.request.persona,
            "lanes": job.request.lanes,
            "gate": job.request.gate,
            "runtime": job.request.runtime,
            "isolation": job.request.isolation,
            "quiet": job.request.quiet,
            "workerTimeoutMs": job.request.worker_timeout_ms,
        },
        "stdoutLog": job.stdout_log,
        "stderrLog": job.stderr_log,
        "exitCode": job.exit_code,
        "message": job.message,
        "createdAt": job.created_at as u64,
        "updatedAt": job.updated_at as u64,
    });
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to encode background job: {error}"))?;
    let temporary = job.run_root.join(format!(
        ".{BACKGROUND_JOB_FILENAME}.{}.{}.tmp",
        std::process::id(),
        current_millis()
    ));
    fs::write(&temporary, text)
        .map_err(|error| format!("Failed to write {}: {error}", temporary.display()))?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Failed to replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Failed to replace {}: {error}", path.display()))
}

fn effective_state(job: &BackgroundJob) -> &str {
    if matches!(job.state.as_str(), "starting" | "running") && !matches_background_process(job) {
        "lost"
    } else {
        &job.state
    }
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Background job is missing {key}"))
}

fn required_u64(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("Background job is missing {key}"))
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    let mut components = Path::new(run_id).components();
    if run_id.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(format!("Invalid team run id: {run_id}"));
    }
    Ok(())
}

fn current_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn matches_background_process(job: &BackgroundJob) -> bool {
    let Some(expected) = job.process_identity.as_deref() else {
        return false;
    };
    is_pid_alive(job.pid) && read_process_identity(job.pid).as_deref() == Some(expected)
}

#[cfg(target_os = "linux")]
fn read_process_identity(pid: u32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = stat.rsplit_once(") ")?.1;
    let start_ticks = fields.split_whitespace().nth(19)?;
    Some(format!("linux:{start_ticks}"))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn read_process_identity(pid: u32) -> Option<String> {
    let pid_arg = pid.to_string();
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid_arg, "-o", "lstart=", "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let identity = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!identity.is_empty()).then_some(identity)
}

#[cfg(windows)]
fn read_process_identity(pid: u32) -> Option<String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()"),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let identity = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!identity.is_empty()).then_some(identity)
}

#[cfg(not(any(unix, windows)))]
fn read_process_identity(_pid: u32) -> Option<String> {
    None
}

fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        let result = unsafe { kill(pid as i32, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn terminate_process_group(pid: u32) -> Result<(), String> {
    signal_process_group(pid, false)
}

fn force_kill_process_group(pid: u32) -> Result<(), String> {
    signal_process_group(pid, true)
}

fn terminate_background_process(job: &BackgroundJob, grace_attempts: usize) -> Result<(), String> {
    if !matches_background_process(job) {
        return Err(format!(
            "Background PID {} no longer matches run {}; refusing to terminate it",
            job.pid, job.run_id
        ));
    }
    terminate_process_group(job.pid)?;
    for _ in 0..grace_attempts {
        if !matches_background_process(job) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    if matches_background_process(job) {
        force_kill_process_group(job.pid)?;
    }
    for _ in 0..100 {
        if !matches_background_process(job) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(format!(
        "Background process group {} remained alive after forced termination; cancellation was not recorded",
        job.pid
    ))
}

fn signal_process_group(pid: u32, force: bool) -> Result<(), String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(format!("Invalid background PID: {pid}"));
    }
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        let signal = if force { 9 } else { 15 };
        let result = unsafe { kill(-(pid as i32), signal) };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(3) {
            return Ok(());
        }
        return Err(format!(
            "Failed to {} background process group {pid}: {}",
            if force { "kill" } else { "terminate" },
            std::io::Error::last_os_error()
        ));
    }
    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| format!("Failed to start taskkill for {pid}: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("taskkill failed for background PID {pid}"))
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    #[test]
    fn background_termination_escalates_after_sigterm_grace() {
        let root = env::temp_dir().join(format!(
            "unclecode-background-force-kill-{}-{}",
            std::process::id(),
            current_millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let ready = root.join("ready");
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "trap '' TERM; touch \"$1\"; while :; do sleep 1; done",
                "background-force-kill",
            ])
            .arg(&ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = command.spawn().unwrap();
        for _ in 0..100 {
            if ready.is_file() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            ready.is_file(),
            "signal-ignoring child did not become ready"
        );
        let pid = child.id();
        let process_identity = read_process_identity(pid);
        assert!(
            process_identity.is_some(),
            "child identity was not observable"
        );
        let job = BackgroundJob {
            run_id: "tr_force_kill".to_string(),
            run_root: root.clone(),
            workspace_root: root.clone(),
            pid,
            process_identity,
            state: "running".to_string(),
            request: BackgroundRunRequest {
                objective: "test".to_string(),
                persona: "coder".to_string(),
                lanes: "openai".to_string(),
                gate: "strict".to_string(),
                runtime: "local".to_string(),
                isolation: "shared".to_string(),
                quiet: true,
                worker_timeout_ms: 1_000,
            },
            stdout_log: root.join("stdout"),
            stderr_log: root.join("stderr"),
            exit_code: None,
            message: None,
            created_at: current_millis(),
            updated_at: current_millis(),
        };
        let reaper = thread::spawn(move || child.wait().unwrap());
        let started = std::time::Instant::now();
        terminate_background_process(&job, 5).unwrap();
        let status = reaper.join().unwrap();
        fs::remove_dir_all(&root).ok();

        assert!(!status.success());
        assert!(started.elapsed() >= Duration::from_millis(80));
        assert!(!matches_background_process(&job));
    }
}
