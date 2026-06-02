use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_command(command: &RuntimeCommand) -> io::Result<RuntimeOutput> {
    let output = Command::new(&command.program)
        .args(&command.args)
        .current_dir(&command.cwd)
        .output()?;

    Ok(RuntimeOutput {
        status: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

pub fn run_shell_command(command: &str, cwd: impl Into<PathBuf>) -> io::Result<RuntimeOutput> {
    let output = if cfg!(windows) {
        Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", command])
            .current_dir(cwd.into())
            .output()?
    } else {
        Command::new("/bin/sh")
            .args(["-c", command])
            .current_dir(cwd.into())
            .output()?
    };

    Ok(RuntimeOutput {
        status: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn runs_command_without_shell() {
        let output = run_command(&RuntimeCommand {
            program: OsString::from("node"),
            args: vec![
                OsString::from("-e"),
                OsString::from("process.stdout.write(process.cwd())"),
            ],
            cwd: env::current_dir().expect("cwd"),
        })
        .expect("run command");

        assert_eq!(output.status, 0);
        assert!(!output.stdout.trim().is_empty());
        assert_eq!(output.stderr, "");
    }

    #[test]
    fn runs_shell_command() {
        let output = run_shell_command("printf shell-ok", env::current_dir().expect("cwd"))
            .expect("run shell");

        assert_eq!(output.status, 0);
        assert_eq!(output.stdout, "shell-ok");
    }
}
