use serde_json::Value;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "unclecode-background-contract-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn background_run_completes_restarts_and_cancels() {
    let root = TempRoot::new();
    let data_root = root.0.join("data");
    let binary = env!("CARGO_BIN_EXE_unclecode");

    let started = run_team(
        binary,
        &root.0,
        &data_root,
        &[
            "run",
            "--background",
            "--lanes",
            "openai,openai",
            "complete",
        ],
        &[("UNCLECODE_TEAM_WORKER_LIVE", "0")],
    );
    assert!(started.status.success(), "{}", output_text(&started));
    let run_id = output_field(&started.stdout, "RUN_ID=");
    let completed = wait_for_status(binary, &root.0, &data_root, &run_id, "Background: accepted");
    assert!(completed.contains("Status:    accepted"));

    let restarted = run_team(
        binary,
        &root.0,
        &data_root,
        &["restart", &run_id],
        &[("UNCLECODE_TEAM_WORKER_LIVE", "0")],
    );
    assert!(restarted.status.success(), "{}", output_text(&restarted));
    let restarted_id = output_field(&restarted.stdout, "RUN_ID=");
    assert_ne!(restarted_id, run_id);
    assert!(
        String::from_utf8_lossy(&restarted.stdout).contains(&format!("Restarted from {run_id}"))
    );
    let restarted_status = wait_for_status(
        binary,
        &root.0,
        &data_root,
        &restarted_id,
        "Background: accepted",
    );
    assert!(restarted_status.contains("Status:    accepted"));

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let mut connections = Vec::new();
        while !server_stop.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => connections.push(stream),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("stalled provider failed: {error}"),
            }
        }
    });
    let base_url = format!("http://{address}/v1");
    let cancelled = run_team(
        binary,
        &root.0,
        &data_root,
        &["run", "--background", "--lanes", "openai", "cancel"],
        &[
            ("UNCLECODE_TEAM_WORKER_LIVE", "1"),
            ("OPENAI_API_KEY", "contract-key"),
            ("OPENAI_BASE_URL", &base_url),
        ],
    );
    assert!(cancelled.status.success(), "{}", output_text(&cancelled));
    let cancelled_id = output_field(&cancelled.stdout, "RUN_ID=");
    wait_for_status(
        binary,
        &root.0,
        &data_root,
        &cancelled_id,
        "Background: running",
    );
    let job_path = data_root
        .join("team-runs")
        .join(&cancelled_id)
        .join("background-job.json");
    let mut job: Value = serde_json::from_str(&fs::read_to_string(&job_path).unwrap()).unwrap();
    let process_identity = job["processIdentity"]
        .as_str()
        .filter(|value| !value.is_empty())
        .expect("background metadata must persist process identity")
        .to_string();
    job["processIdentity"] = Value::String("not-the-running-process".to_string());
    fs::write(&job_path, serde_json::to_string_pretty(&job).unwrap()).unwrap();
    let refused = run_team(binary, &root.0, &data_root, &["abort", &cancelled_id], &[]);
    assert!(!refused.status.success(), "{}", output_text(&refused));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("refusing to terminate"));
    job["processIdentity"] = Value::String(process_identity);
    fs::write(&job_path, serde_json::to_string_pretty(&job).unwrap()).unwrap();
    let aborted = run_team(binary, &root.0, &data_root, &["abort", &cancelled_id], &[]);
    stop.store(true, Ordering::Release);
    server.join().unwrap();
    assert!(aborted.status.success(), "{}", output_text(&aborted));
    assert!(String::from_utf8_lossy(&aborted.stdout).contains("cancelled"));
    let aborted_status = wait_for_status(
        binary,
        &root.0,
        &data_root,
        &cancelled_id,
        "Background: cancelled",
    );
    assert!(aborted_status.contains("Status:    aborted"));
}

fn run_team(
    binary: &str,
    cwd: &Path,
    data_root: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Output {
    let mut command = Command::new(binary);
    command
        .arg("team")
        .args(args)
        .current_dir(cwd)
        .env("UNCLECODE_DATA_ROOT", data_root);
    for (key, value) in envs {
        command.env(key, value);
    }
    command.output().unwrap()
}

fn wait_for_status(
    binary: &str,
    cwd: &Path,
    data_root: &Path,
    run_id: &str,
    expected: &str,
) -> String {
    let mut last = String::new();
    for _ in 0..200 {
        let output = run_team(binary, cwd, data_root, &["status", run_id], &[]);
        assert!(output.status.success(), "{}", output_text(&output));
        last = String::from_utf8(output.stdout).unwrap();
        if last.contains(expected) {
            return last;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("status never contained {expected:?}:\n{last}");
}

fn output_field(stdout: &[u8], prefix: &str) -> String {
    String::from_utf8_lossy(stdout)
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .unwrap_or_else(|| panic!("missing {prefix} in {}", String::from_utf8_lossy(stdout)))
        .to_string()
}

fn output_text(output: &Output) -> String {
    format!(
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}
