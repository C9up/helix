//! Worker pool implementation.
//!
//! The TS worker entry (`src/runtime/cli-worker.ts`) writes its framed
//! `__HELIX_RESULT__...` line on **stderr**, so we read from the child's
//! stderr (not stdout). Stdout is drained in parallel so a chatty
//! `console.log` cannot fill the pipe buffer and block the worker.

use futures::stream::{FuturesUnordered, StreamExt};
use napi::bindgen_prelude::*;
use ream_test_core::ipc::{FileResult, WorkerError, WorkerOutgoing};
use ream_test_core::reporter::Reporter;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
// Only the `#[cfg(unix)]` `fill_os_random` uses `Read::read_exact` (on
// `/dev/urandom`); gating the import keeps the Windows build warning-clean
// under `-D warnings`.
#[cfg(unix)]
use std::io::Read as _;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::sync::Semaphore;

pub struct PoolConfig {
    pub node_bin: String,
    pub node_args: Vec<String>,
    pub worker_entry: String,
    pub threads: usize,
    pub timeout: Duration,
    /// Stop the run once a file reports a failure (helix `--bail`). Files
    /// already spawned finish; files still queued are never started.
    pub bail: bool,
}

pub async fn run_pool(
    files: Vec<PathBuf>,
    cfg: PoolConfig,
    reporter: Arc<Mutex<Box<dyn Reporter + Send>>>,
) -> Result<(Vec<FileResult>, Vec<WorkerError>)> {
    let semaphore = Arc::new(Semaphore::new(cfg.threads.max(1)));
    let cfg = Arc::new(cfg);
    // Under `--bail`, the first failing file closes the gate and whatever is
    // still queued never starts.
    let gate_closed = Arc::new(AtomicBool::new(false));

    let mut tasks = FuturesUnordered::new();
    for file in files {
        let sem = semaphore.clone();
        let cfg = cfg.clone();
        let reporter = reporter.clone();
        let gate_closed = gate_closed.clone();
        tasks.push(tokio::spawn(async move {
            // If the semaphore was closed (shouldn't happen in normal flow),
            // surface as a worker error rather than panicking the task.
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => {
                    return Err(WorkerError {
                        file: Some(file.to_string_lossy().into_owned()),
                        message: "pool semaphore was closed".into(),
                        stack: None,
                    });
                }
            };
            // Checked AFTER the permit: an earlier file may have failed while
            // this one waited for a slot.
            if cfg.bail && gate_closed.load(Ordering::SeqCst) {
                return Ok(None);
            }
            let path_str = file.to_string_lossy().into_owned();
            {
                let mut r = reporter.lock().await;
                r.on_file_start(&path_str);
            }
            let outcome = run_one_file(&file, &cfg).await;
            let mut r = reporter.lock().await;
            match &outcome {
                Ok(result) => {
                    r.on_file_result(result);
                    if cfg.bail && result.totals.fail > 0 {
                        gate_closed.store(true, Ordering::SeqCst);
                    }
                }
                Err(err) => {
                    r.on_file_error(err);
                    if cfg.bail {
                        gate_closed.store(true, Ordering::SeqCst);
                    }
                }
            }
            outcome.map(Some)
        }));
    }

    let mut results = Vec::new();
    let mut errors = Vec::new();
    while let Some(join) = tasks.next().await {
        let outcome =
            join.map_err(|e| Error::from_reason(format!("worker task join failed: {}", e)))?;
        match outcome {
            // `None` = the file was never started because the bail gate closed.
            Ok(Some(fr)) => results.push(fr),
            Ok(None) => {}
            Err(err) => errors.push(err),
        }
    }
    Ok((results, errors))
}

async fn run_one_file(
    file: &std::path::Path,
    cfg: &PoolConfig,
) -> std::result::Result<FileResult, WorkerError> {
    let path_str = file.to_string_lossy().into_owned();
    let mut cmd = Command::new(&cfg.node_bin);
    for a in &cfg.node_args {
        cmd.arg(a);
    }
    cmd.arg(&cfg.worker_entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| WorkerError {
        file: Some(path_str.clone()),
        message: format!("spawn failed: {}", e),
        stack: None,
    })?;
    let mut stdin = child.stdin.take().ok_or_else(|| WorkerError {
        file: Some(path_str.clone()),
        message: "no stdin on worker".into(),
        stack: None,
    })?;
    let stdout = child.stdout.take().ok_or_else(|| WorkerError {
        file: Some(path_str.clone()),
        message: "no stdout on worker".into(),
        stack: None,
    })?;
    let stderr = child.stderr.take().ok_or_else(|| WorkerError {
        file: Some(path_str.clone()),
        message: "no stderr on worker".into(),
        stack: None,
    })?;

    // Drain stdout in a background task so the worker can freely
    // `console.log` without filling the 64 KiB pipe buffer.
    tokio::spawn(async move {
        let mut reader = stdout;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    });

    // Per-invocation nonce — the worker echoes it so malicious `console.error`
    // lines in a fixture cannot spoof the frame.
    let nonce = format!("{}-{}", std::process::id(), rand_suffix());

    let instr = serde_json::json!({
        "type": "run",
        "file": path_str,
        "timeoutMs": cfg.timeout.as_millis() as u64,
        "nonce": nonce,
    });
    let mut line = serde_json::to_string(&instr).map_err(|e| WorkerError {
        file: Some(path_str.clone()),
        message: format!("serialize instruction: {}", e),
        stack: None,
    })?;
    line.push('\n');
    if let Err(e) = stdin.write_all(line.as_bytes()).await {
        return Err(WorkerError {
            file: Some(path_str.clone()),
            message: format!("stdin write failed: {}", e),
            stack: None,
        });
    }
    drop(stdin);

    let reader = BufReader::new(stderr);
    let outcome = tokio::time::timeout(
        cfg.timeout + Duration::from_secs(5),
        read_frame(reader, &nonce),
    )
    .await
    .map_err(|_| WorkerError {
        file: Some(path_str.clone()),
        message: format!("worker timed out after {}ms", cfg.timeout.as_millis()),
        stack: None,
    })?;

    let _ = child.wait().await;

    outcome.map_err(|e| WorkerError {
        file: Some(path_str.clone()),
        message: e,
        stack: None,
    })
}

const FRAME_PREFIX: &str = "__HELIX_RESULT__";

const PRE_HANDSHAKE_NONCE: &str = "__helix_pre_handshake__";
/// Hard cap on stderr we'll buffer before giving up — mirrors the TS pool.
const MAX_STDERR_BUFFER_BYTES: usize = 4 * 1024 * 1024;

async fn read_frame<R: tokio::io::AsyncRead + Unpin>(
    mut reader: BufReader<R>,
    expected_nonce: &str,
) -> std::result::Result<FileResult, String> {
    // `read_until(b'\n', Vec<u8>)` is lossy-UTF-8 tolerant — a single
    // invalid byte on stderr from a native addon won't kill the task.
    let mut raw = Vec::<u8>::new();
    let mut total: usize = 0;
    loop {
        raw.clear();
        let n = reader
            .read_until(b'\n', &mut raw)
            .await
            .map_err(|e| format!("read failed: {}", e))?;
        if n == 0 {
            return Err("worker closed stderr before emitting a framed result".into());
        }
        total = total.saturating_add(n);
        if total > MAX_STDERR_BUFFER_BYTES {
            return Err(format!(
                "worker stderr exceeded {} bytes without emitting a frame",
                MAX_STDERR_BUFFER_BYTES
            ));
        }
        let line = String::from_utf8_lossy(&raw);
        let trimmed = line.trim_end();
        let Some(payload) = trimmed.strip_prefix(FRAME_PREFIX) else {
            continue;
        };
        let msg: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Validate nonce. Accept the pre-handshake magic only for errors
        // (fixtures still can't claim a fake success).
        let nonce_ok = match msg.get("nonce").and_then(|v| v.as_str()) {
            Some(n) if n == expected_nonce => true,
            Some(PRE_HANDSHAKE_NONCE) => msg.get("type").and_then(|v| v.as_str()) == Some("error"),
            _ => false,
        };
        if !nonce_ok {
            continue;
        }
        let typed: WorkerOutgoing = match serde_json::from_value(msg) {
            Ok(v) => v,
            Err(e) => return Err(format!("invalid worker message: {}", e)),
        };
        match typed {
            WorkerOutgoing::Result { result } => return Ok(result),
            WorkerOutgoing::Error(err) => return Err(err.message),
        }
    }
}

/// Cryptographically-unpredictable nonce suffix. A fixture running under
/// the worker cannot read `/dev/urandom` (or `BCryptGenRandom`) and guess
/// this in a reasonable window, so it cannot spoof `__HELIX_RESULT__`
/// frames — the whole point of the nonce. Falls back to `SystemTime`
/// nanos only if the OS RNG is unavailable (flagged visibly via the
/// `unsafe-time-` prefix).
fn rand_suffix() -> String {
    let mut bytes = [0u8; 16];
    if fill_os_random(&mut bytes) {
        let mut out = String::with_capacity(32);
        for b in bytes {
            out.push_str(&format!("{:02x}", b));
        }
        return out;
    }
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("unsafe-time-{:x}", nanos)
}

#[cfg(unix)]
fn fill_os_random(buf: &mut [u8]) -> bool {
    match std::fs::File::open("/dev/urandom") {
        Ok(mut f) => f.read_exact(buf).is_ok(),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn fill_os_random(_buf: &mut [u8]) -> bool {
    // Without the `rand` crate we can't call BCryptGenRandom here.
    // Fall through to the time-based fallback; Windows CI users should
    // expect an advisory in logs. (Long-term: depend on `getrandom`.)
    false
}

#[cfg(not(any(unix, windows)))]
fn fill_os_random(_buf: &mut [u8]) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use ream_test_core::summary::Summary;
    use std::io::Write as _;

    /// A stand-in worker: reads the instruction, echoes the nonce, and reports
    /// a failure for any file whose name contains "red". Written to disk so the
    /// pool spawns it exactly as it spawns the real one.
    fn fake_worker(dir: &std::path::Path) -> String {
        let entry = dir.join("fake-worker.mjs");
        let mut f = std::fs::File::create(&entry).unwrap();
        f.write_all(
            br#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const instr = JSON.parse(raw.trim());
  const fails = instr.file.includes("red");
  const result = {
    file: instr.file,
    suites: [],
    tests: [],
    totals: { pass: fails ? 0 : 1, fail: fails ? 1 : 0, skip: 0, todo: 0 },
    durationMs: 1,
  };
  process.stderr.write(
    "__HELIX_RESULT__" +
      JSON.stringify({ type: "result", nonce: instr.nonce, result }) +
      "\n",
  );
});
"#,
        )
        .unwrap();
        entry.to_string_lossy().into_owned()
    }

    /// Records what the pool announced. The log is shared so the test can read
    /// it back — the reporter itself is behind a `dyn` box by then.
    struct RecordingReporter {
        started: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl Reporter for RecordingReporter {
        fn on_file_start(&mut self, file: &str) {
            self.started.lock().unwrap().push(file.to_string());
        }
        fn on_file_result(&mut self, _result: &FileResult) {}
        fn on_file_error(&mut self, _error: &WorkerError) {}
        fn on_summary(&mut self, _summary: &Summary) {}
    }

    fn config(entry: String, bail: bool) -> PoolConfig {
        PoolConfig {
            node_bin: "node".into(),
            node_args: vec![],
            worker_entry: entry,
            // One at a time, so "queued behind a failure" is deterministic
            // rather than a race with the thread count.
            threads: 1,
            timeout: Duration::from_secs(20),
            bail,
        }
    }

    /// A reporter plus the log it writes to.
    #[allow(clippy::type_complexity)]
    fn recorder() -> (
        Arc<Mutex<Box<dyn Reporter + Send>>>,
        Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let reporter: Arc<Mutex<Box<dyn Reporter + Send>>> =
            Arc::new(Mutex::new(Box::new(RecordingReporter {
                started: log.clone(),
            })));
        (reporter, log)
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("helix-pool-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `green`, then `red`, then two more — the last two are what bail must drop.
    fn files(dir: &std::path::Path) -> Vec<PathBuf> {
        [
            "a-green.test.ts",
            "b-red.test.ts",
            "c-green.test.ts",
            "d-green.test.ts",
        ]
        .iter()
        .map(|name| dir.join(name))
        .collect()
    }

    #[tokio::test]
    async fn runs_every_file_without_bail() {
        let dir = temp_dir("nobail");
        let entry = fake_worker(&dir);
        let (reporter, _log) = recorder();

        let (results, errors) = run_pool(files(&dir), config(entry, false), reporter)
            .await
            .unwrap();

        assert_eq!(errors.len(), 0);
        assert_eq!(results.len(), 4);
        assert_eq!(results.iter().filter(|r| r.totals.fail > 0).count(), 1);
    }

    #[tokio::test]
    async fn bail_drops_the_files_queued_behind_a_failure() {
        let dir = temp_dir("bail");
        let entry = fake_worker(&dir);
        let (reporter, _log) = recorder();

        let (results, errors) = run_pool(files(&dir), config(entry, true), reporter)
            .await
            .unwrap();

        assert_eq!(errors.len(), 0);
        // The green file, then the red one that closed the gate. The two behind
        // it are dropped, not reported — helix runs one process per file, so
        // naming them would mean spawning them.
        assert_eq!(results.len(), 2);
        assert_eq!(results.iter().filter(|r| r.totals.fail > 0).count(), 1);
    }

    #[tokio::test]
    async fn a_dropped_file_is_never_announced() {
        let dir = temp_dir("announce");
        let entry = fake_worker(&dir);
        let (reporter, log) = recorder();

        run_pool(files(&dir), config(entry, true), reporter)
            .await
            .unwrap();

        // `on_file_start` for a file the gate dropped would print a banner for
        // a test that never ran — the reporter must not see it at all.
        let started = log.lock().unwrap();
        assert_eq!(started.len(), 2);
        assert!(started[0].ends_with("a-green.test.ts"));
        assert!(started[1].ends_with("b-red.test.ts"));
    }

    #[tokio::test]
    async fn a_worker_that_never_frames_becomes_an_error_not_a_silent_pass() {
        let dir = temp_dir("noframe");
        let entry = dir.join("silent-worker.mjs");
        std::fs::write(&entry, b"process.exit(0)\n").unwrap();
        let (reporter, _log) = recorder();

        let (results, errors) = run_pool(
            vec![dir.join("a.test.ts")],
            config(entry.to_string_lossy().into_owned(), false),
            reporter,
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 0);
        assert_eq!(errors.len(), 1);
    }
}
