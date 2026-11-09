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
    /// Per-test timeout handed to the worker, above `configure({ timeout })`.
    /// Sent only when set, so the worker can tell "nobody chose" from a choice.
    pub test_timeout_ms: Option<u64>,
    /// Per-test timeout below `configure({ timeout })` (the config file's).
    pub default_test_timeout_ms: Option<u64>,
    /// How long one file may run before its worker is killed.
    pub file_timeout: Duration,
    /// Stop the run once a file reports a failure (helix `--bail`). Files
    /// already spawned finish; files still queued are never started.
    pub bail: bool,
    /// Drop what the tests print instead of forwarding it (`--silent`).
    pub silent: bool,
    /// Forward the tests' stdout to stderr, so a reporter writing
    /// machine-readable output on stdout (`json`) stays parseable.
    pub output_to_stderr: bool,
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
            if !cfg.silent {
                forward_output(&file, &outcome, cfg.output_to_stderr);
            }
            if let Some(result) = &outcome.result {
                r.on_file_result(result);
                if cfg.bail && result.totals.fail > 0 {
                    gate_closed.store(true, Ordering::SeqCst);
                }
            }
            for err in &outcome.errors {
                r.on_file_error(err);
                if cfg.bail {
                    gate_closed.store(true, Ordering::SeqCst);
                }
            }
            Ok(Some(outcome))
        }));
    }

    let mut results = Vec::new();
    let mut errors = Vec::new();
    while let Some(join) = tasks.next().await {
        let outcome =
            join.map_err(|e| Error::from_reason(format!("worker task join failed: {}", e)))?;
        match outcome {
            // `None` = the file was never started because the bail gate closed.
            Ok(Some(file)) => {
                results.extend(file.result);
                errors.extend(file.errors);
            }
            Ok(None) => {}
            Err(err) => errors.push(err),
        }
    }
    Ok((results, errors))
}

/// What one file produced: its result when the worker reported one, and every
/// error that belongs to it — a fatal one instead of the result, or ones raised
/// beside it (an unhandled rejection, a late throw, an unexpected exit).
pub struct FileOutcome {
    pub result: Option<FileResult>,
    pub errors: Vec<WorkerError>,
    /// What the worker printed on stdout.
    pub stdout: String,
    /// What the worker printed on stderr, outside the frames.
    pub stderr: String,
}

/// How much of what one file prints is kept, per stream. Past it the rest is
/// counted, not kept: a test logging in a loop must not grow the CLI's memory
/// without bound. Mirrors the TS pool.
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// Bounded accumulator for one stream of a worker's output.
#[derive(Default)]
struct OutputBuffer {
    data: Vec<u8>,
    dropped: usize,
}

impl OutputBuffer {
    fn append(&mut self, chunk: &[u8]) {
        let room = MAX_OUTPUT_BYTES.saturating_sub(self.data.len());
        let kept = room.min(chunk.len());
        self.data.extend_from_slice(&chunk[..kept]);
        self.dropped += chunk.len() - kept;
    }

    fn text(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.data).into_owned();
        if self.dropped > 0 {
            text.push_str(&format!(
                "\n… {} more bytes of output dropped\n",
                self.dropped
            ));
        }
        text
    }
}

type SharedOutput = Arc<std::sync::Mutex<OutputBuffer>>;

fn take_output(buffer: &SharedOutput) -> String {
    buffer.lock().map(|b| b.text()).unwrap_or_default()
}

/// Write what a file printed, under a header naming it. Buffered per file and
/// written in one go, so files running in parallel do not interleave.
fn forward_output(file: &std::path::Path, outcome: &FileOutcome, stdout_to_stderr: bool) {
    use std::io::Write as _;
    let name = std::env::current_dir()
        .ok()
        .and_then(|cwd| file.strip_prefix(cwd).ok().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| file.to_path_buf());
    let name = name.to_string_lossy();
    let block = |label: &str, text: &str| -> Option<String> {
        if text.is_empty() {
            return None;
        }
        let newline = if text.ends_with('\n') { "" } else { "\n" };
        Some(format!("{} | {}\n{}{}", label, name, text, newline))
    };
    if let Some(out) = block("stdout", &outcome.stdout) {
        if stdout_to_stderr {
            let _ = std::io::stderr().lock().write_all(out.as_bytes());
        } else {
            let mut sink = std::io::stdout().lock();
            let _ = sink.write_all(out.as_bytes());
            let _ = sink.flush();
        }
    }
    if let Some(err) = block("stderr", &outcome.stderr) {
        let _ = std::io::stderr().lock().write_all(err.as_bytes());
    }
}

/// One frame the worker wrote on stderr, already checked against the nonce.
enum Frame {
    Result(FileResult),
    Fatal(WorkerError),
    Unhandled(WorkerError),
    /// The stream itself is unusable (an oversized line, a frame that does not
    /// parse): the pool diagnoses the file and stops.
    Broken(String),
}

async fn run_one_file(file: &std::path::Path, cfg: &PoolConfig) -> FileOutcome {
    let path_str = file.to_string_lossy().into_owned();
    let fail = |message: String| FileOutcome {
        result: None,
        errors: vec![WorkerError {
            file: Some(path_str.clone()),
            message,
            stack: None,
        }],
        stdout: String::new(),
        stderr: String::new(),
    };
    let mut cmd = Command::new(&cfg.node_bin);
    for a in &cfg.node_args {
        cmd.arg(a);
    }
    cmd.arg(&cfg.worker_entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return fail(format!("spawn failed: {}", e)),
    };
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill().await;
        return fail("worker spawned without its stdio pipes".into());
    };

    // Read stdout in a background task so the worker can freely
    // `console.log` without filling the 64 KiB pipe buffer; it is forwarded
    // once the file settles.
    let stdout_buffer: SharedOutput = Arc::default();
    let stderr_buffer: SharedOutput = Arc::default();
    let mut drain = AbortOnDrop(tokio::spawn({
        let sink = stdout_buffer.clone();
        async move {
            let mut reader = stdout;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut out) = sink.lock() {
                            out.append(&buf[..n]);
                        }
                    }
                }
            }
        }
    }));

    // Per-invocation nonce — the worker echoes it so malicious `console.error`
    // lines in a fixture cannot spoof the frame.
    let nonce = format!("{}-{}", std::process::id(), rand_suffix());

    let mut instr = serde_json::json!({
        "type": "run",
        "file": path_str,
        "nonce": nonce,
    });
    if let Some(ms) = cfg.test_timeout_ms {
        instr["timeoutMs"] = ms.into();
    }
    if let Some(ms) = cfg.default_test_timeout_ms {
        instr["defaultTimeoutMs"] = ms.into();
    }
    let mut line = match serde_json::to_string(&instr) {
        Ok(line) => line,
        Err(e) => {
            let _ = child.kill().await;
            return fail(format!("serialize instruction: {}", e));
        }
    };
    line.push('\n');
    if let Err(e) = stdin.write_all(line.as_bytes()).await {
        let _ = child.kill().await;
        return fail(format!("stdin write failed: {}", e));
    }
    drop(stdin);

    // Frames are read by their own task so the loop below can wait on them, on
    // the worker's exit and on a deadline at once.
    let (tx, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let _reader = AbortOnDrop(tokio::spawn(read_frames(
        BufReader::new(stderr),
        nonce,
        tx,
        stderr_buffer.clone(),
    )));

    let mut result: Option<FileResult> = None;
    let mut errors: Vec<WorkerError> = Vec::new();
    let mut frames_open = true;
    let mut exit: Option<std::process::ExitStatus> = None;
    let mut killed = false;
    // Until the worker reports, the per-file watchdog; then the exit grace;
    // once it has exited, a short window for the frames still in the pipe.
    let mut reported = false;
    let mut deadline = tokio::time::Instant::now() + cfg.file_timeout;

    while frames_open || exit.is_none() {
        tokio::select! {
            frame = frames.recv(), if frames_open => match frame {
                None => frames_open = false,
                Some(Frame::Result(r)) => {
                    if result.is_none() {
                        result = Some(r);
                    }
                    if !reported {
                        reported = true;
                        deadline = tokio::time::Instant::now() + EXIT_GRACE;
                    }
                }
                Some(Frame::Fatal(e)) => {
                    errors.push(e);
                    // No result came back, so there is nothing to flush and
                    // nothing to protect: waiting the grace out would only
                    // delay the diagnosis the worker just gave.
                    if result.is_none() {
                        let _ = child.kill().await;
                        killed = true;
                        break;
                    }
                }
                Some(Frame::Unhandled(e)) => errors.push(e),
                Some(Frame::Broken(message)) => {
                    errors.push(WorkerError { file: None, message, stack: None });
                    let _ = child.kill().await;
                    killed = true;
                    break;
                }
            },
            status = child.wait(), if exit.is_none() => {
                exit = status.ok();
                if exit.is_none() {
                    // The status is unreadable; there is nothing left to wait on.
                    break;
                }
                let drain = tokio::time::Instant::now() + EXIT_DRAIN;
                if drain < deadline {
                    deadline = drain;
                }
            },
            _ = tokio::time::sleep_until(deadline) => {
                if exit.is_some() {
                    // Exited; whatever still holds the pipe is a grandchild.
                    break;
                }
                if !reported {
                    errors.push(WorkerError {
                        file: None,
                        message: format!(
                            "worker timed out after {}ms — the file did not finish within its deadline (fileTimeoutMs)",
                            cfg.file_timeout.as_millis()
                        ),
                        stack: None,
                    });
                } else if result.is_some() {
                    // Wording is the TS pool's, verbatim, so the two paths are
                    // indistinguishable.
                    eprint!(
                        "helix: {} finished but its worker did not exit within {}ms — \
        something it started is still running (a server, a timer, a connection).\n\
        helix: killing it and keeping the result. Close it in a teardown hook to silence this.\n",
                        path_str,
                        EXIT_GRACE.as_millis()
                    );
                }
                let _ = child.kill().await;
                killed = true;
                break;
            }
        }
    }

    // A worker that reported and then died of a signal nobody sent, or exited
    // with a status other than the one its frames imply, had something go wrong
    // after its result — and the result alone would have read as green.
    if let (Some(r), Some(status), false) = (&result, exit, killed) {
        let expected = if r.totals.fail > 0 || !errors.is_empty() {
            1
        } else {
            0
        };
        match status.code() {
            Some(code) if code != 0 && code != expected => errors.push(WorkerError {
                file: None,
                message: format!(
                    "worker exited with code {} after the file reported its result",
                    code
                ),
                stack: None,
            }),
            Some(_) => {}
            None => errors.push(WorkerError {
                file: None,
                message: format!(
                    "worker was killed by {} after the file reported its result",
                    exit_signal(&status)
                ),
                stack: None,
            }),
        }
    }

    if result.is_none() && errors.is_empty() {
        errors.push(WorkerError {
            file: None,
            message: "worker exited without emitting a framed result".into(),
            stack: None,
        });
    }
    for err in &mut errors {
        if err.file.is_none() {
            err.file = Some(path_str.clone());
        }
    }
    // The last stdout bytes may still be in the pipe; a grandchild holding it
    // open must not keep the file from settling.
    let _ = tokio::time::timeout(EXIT_DRAIN, &mut drain.0).await;
    FileOutcome {
        result,
        errors,
        stdout: take_output(&stdout_buffer),
        stderr: take_output(&stderr_buffer),
    }
}

/// The signal that ended a worker, by name where it has a common one.
#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt as _;
    match status.signal() {
        Some(1) => "SIGHUP".into(),
        Some(2) => "SIGINT".into(),
        Some(6) => "SIGABRT".into(),
        Some(9) => "SIGKILL".into(),
        Some(11) => "SIGSEGV".into(),
        Some(15) => "SIGTERM".into(),
        Some(n) => format!("signal {}", n),
        None => "an unknown signal".into(),
    }
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> String {
    "an unknown signal".into()
}

/// Read the worker's stderr line by line and forward every frame carrying our
/// nonce. Ends at EOF, or on the first line the stream cannot be trusted past.
async fn read_frames<R: tokio::io::AsyncRead + Unpin>(
    mut reader: BufReader<R>,
    expected_nonce: String,
    tx: tokio::sync::mpsc::UnboundedSender<Frame>,
    output: SharedOutput,
) {
    // `read_until(b'\n', Vec<u8>)` is lossy-UTF-8 tolerant — a single
    // invalid byte on stderr from a native addon won't kill the task.
    let mut raw = Vec::<u8>::new();
    loop {
        raw.clear();
        // Bounded per line, like the TS pool: one endless line must not grow
        // this buffer without limit.
        let limit = MAX_STDERR_BUFFER_BYTES as u64 + 1;
        let n = match (&mut reader).take(limit).read_until(b'\n', &mut raw).await {
            Ok(n) => n,
            Err(_) => return,
        };
        if n == 0 {
            return;
        }
        if raw.len() > MAX_STDERR_BUFFER_BYTES {
            let _ = tx.send(Frame::Broken(format!(
                "worker stderr exceeded {} bytes without emitting a frame",
                MAX_STDERR_BUFFER_BYTES
            )));
            return;
        }
        let line = String::from_utf8_lossy(&raw);
        let trimmed = line.trim_end();
        let Some(payload) = trimmed.strip_prefix(FRAME_PREFIX) else {
            if let Ok(mut out) = output.lock() {
                out.append(&raw);
            }
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
        let frame = match serde_json::from_value::<WorkerOutgoing>(msg) {
            Ok(WorkerOutgoing::Result { result }) => Frame::Result(result),
            Ok(WorkerOutgoing::Error(err)) => Frame::Fatal(err),
            Ok(WorkerOutgoing::Unhandled(err)) => Frame::Unhandled(err),
            Err(e) => Frame::Broken(format!("invalid worker message: {}", e)),
        };
        let broken = matches!(frame, Frame::Broken(_));
        if tx.send(frame).is_err() || broken {
            return;
        }
    }
}

/// Stops the stdout reader when `run_one_file` returns, on every path out.
///
/// The task reads until EOF, and EOF only arrives once every holder of the
/// write end is gone. A worker we had to kill may have spawned something that
/// still holds it, so the task would go on waiting for a file that has already
/// been reported — one task leaked per such file, for the rest of the run.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// How long a worker may take to exit AFTER reporting its result.
///
/// It is only flushing `atExit` hooks by then, which is milliseconds. Anything
/// past this is a resource the test left running, and waiting on it turns a
/// passing run into a silent hang. Mirrors the TS pool's `EXIT_GRACE_MS`.
const EXIT_GRACE: Duration = Duration::from_millis(2000);

/// Default per-file deadline: ten minutes. Mirrors the TS pool.
pub const DEFAULT_FILE_TIMEOUT_MS: u64 = 600_000;

/// How long to keep reading a worker's frames after it exited. Its last ones
/// may still be in the pipe; a grandchild holding the pipe open would otherwise
/// keep the file from settling at all.
const EXIT_DRAIN: Duration = Duration::from_millis(250);

const FRAME_PREFIX: &str = "__HELIX_RESULT__";

const PRE_HANDSHAKE_NONCE: &str = "__helix_pre_handshake__";
/// Hard cap on one stderr line we'll buffer before giving up — mirrors the TS
/// pool.
const MAX_STDERR_BUFFER_BYTES: usize = 4 * 1024 * 1024;

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

    /// Records the moment the pool announced a file error. Spawning node costs
    /// whatever the machine costs — on a loaded CI runner, seconds — so a
    /// wall-clock ceiling measured from before the spawn cannot tell "killed
    /// at once" from "started slowly", which is the only thing the grace test
    /// is about.
    struct ErrorClock {
        at: Arc<std::sync::Mutex<Option<std::time::Instant>>>,
    }

    impl Reporter for ErrorClock {
        fn on_file_start(&mut self, _file: &str) {}
        fn on_file_result(&mut self, _result: &FileResult) {}
        fn on_file_error(&mut self, _error: &WorkerError) {
            *self.at.lock().unwrap() = Some(std::time::Instant::now());
        }
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
            test_timeout_ms: None,
            default_test_timeout_ms: None,
            file_timeout: Duration::from_secs(20),
            bail,
            silent: true,
            output_to_stderr: false,
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

    /// A worker can report a failure and then still refuse to exit — the file
    /// blew up *and* left something running. The exit grace exists to protect a
    /// result; there is none here, so paying it only delays the error the run
    /// already has, under a message claiming the file "finished".
    #[tokio::test]
    async fn a_failing_worker_that_will_not_exit_is_not_made_to_wait_out_the_grace() {
        let dir = temp_dir("errleak");
        let entry = dir.join("failing-leaking-worker.mjs");
        std::fs::write(
            &entry,
            br#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const instr = JSON.parse(raw.trim());
  process.stderr.write(
    "__HELIX_RESULT__" +
      JSON.stringify({
        type: "error",
        nonce: instr.nonce,
        message: "the suite could not be loaded",
      }) +
      "\n",
  );
  setInterval(() => {}, 1000);
});
"#,
        )
        .unwrap();
        let errored_at = Arc::new(std::sync::Mutex::new(None));
        let reporter: Arc<Mutex<Box<dyn Reporter + Send>>> =
            Arc::new(Mutex::new(Box::new(ErrorClock {
                at: errored_at.clone(),
            })));

        let (results, errors) = run_pool(
            vec![dir.join("a.test.ts")],
            config(entry.to_string_lossy().into_owned(), false),
            reporter,
        )
        .await
        .unwrap();
        let finished = std::time::Instant::now();

        // The worker's own diagnosis survives; nothing replaces it.
        assert_eq!(results.len(), 0);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].message, "the suite could not be loaded");

        // From the moment the error was known to the moment the run ended: the
        // grace is 2s, and paying it here only delays an error the run already
        // has. Measured from the announcement, so a slow `node` start-up cannot
        // look like a pool that waited.
        let announced = errored_at
            .lock()
            .unwrap()
            .expect("the pool never announced the file error");
        let waited = finished.duration_since(announced);
        assert!(
            waited < Duration::from_millis(1000),
            "the pool waited {waited:?} on a worker that had already failed"
        );
    }

    /// The failure mode with no diagnostic at all: the worker does everything
    /// right, reports its result, and then never exits because the test left a
    /// server or a timer running. The run used to wait on it forever — a green
    /// suite that reads as a crash, and in CI a budget burnt with nothing said.
    #[tokio::test]
    async fn a_worker_that_reports_then_refuses_to_exit_does_not_hang_the_run() {
        let dir = temp_dir("leak");
        let entry = dir.join("leaking-worker.mjs");
        std::fs::write(
            &entry,
            br#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const instr = JSON.parse(raw.trim());
  const result = {
    file: instr.file,
    suites: [],
    tests: [],
    totals: { pass: 1, fail: 0, skip: 0, todo: 0 },
    durationMs: 1,
  };
  process.stderr.write(
    "__HELIX_RESULT__" +
      JSON.stringify({ type: "result", nonce: instr.nonce, result }) +
      "\n",
  );
  // What an unclosed TestClient leaves behind: something keeping the loop alive.
  setInterval(() => {}, 1000);
});
"#,
        )
        .unwrap();
        let (reporter, _log) = recorder();

        let started = std::time::Instant::now();
        let (results, errors) = run_pool(
            vec![dir.join("a.test.ts")],
            config(entry.to_string_lossy().into_owned(), false),
            reporter,
        )
        .await
        .unwrap();

        // The result is kept: the test passed, only the cleanup did not.
        assert_eq!(errors.len(), 0);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].totals.pass, 1);

        // The grace is 2s and the per-file timeout in `config` is 20s. Landing
        // well under that ceiling is the assertion — before the fix this call
        // never returned at all.
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(15),
            "the pool waited {elapsed:?} on a worker that will never exit"
        );
    }

    /// A stand-in worker that reports a pass and then runs `after` — what a
    /// test leaves behind once its file has reported.
    fn reporting_worker(dir: &std::path::Path, name: &str, after: &str) -> String {
        let entry = dir.join(name);
        let body = format!(
            r#"
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {{ raw += c; }});
process.stdin.on("end", () => {{
  const instr = JSON.parse(raw.trim());
  const result = {{
    file: instr.file,
    suites: [],
    tests: [],
    totals: {{ pass: 1, fail: 0, skip: 0, todo: 0 }},
    durationMs: 1,
  }};
  const frame = (msg) => process.stderr.write(
    "__HELIX_RESULT__" + JSON.stringify({{ ...msg, nonce: instr.nonce }}) + "\n",
  );
  frame({{ type: "result", result }});
  {after}
}});
"#
        );
        std::fs::write(&entry, body).unwrap();
        entry.to_string_lossy().into_owned()
    }

    async fn run_single(entry: String, tag: &str) -> (Vec<FileResult>, Vec<WorkerError>) {
        let dir = temp_dir(tag);
        let (reporter, _log) = recorder();
        run_pool(vec![dir.join("a.test.ts")], config(entry, false), reporter)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn an_unhandled_frame_after_the_result_is_a_file_error_and_keeps_the_result() {
        let dir = temp_dir("late-unhandled");
        let entry = reporting_worker(
            &dir,
            "late-unhandled.mjs",
            r#"setTimeout(() => { frame({ type: "unhandled", message: "uncaughtException: BOOM-late" }); process.exitCode = 1; }, 100);"#,
        );
        let (results, errors) = run_single(entry, "late-unhandled-run").await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].totals.pass, 1);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("BOOM-late"));
        assert!(errors[0].file.is_some());
    }

    #[tokio::test]
    async fn a_worker_exiting_with_an_unannounced_status_is_a_file_error() {
        let dir = temp_dir("exit3");
        let entry = reporting_worker(&dir, "exit3.mjs", "setTimeout(() => process.exit(3), 100);");
        let (results, errors) = run_single(entry, "exit3-run").await;
        assert_eq!(results.len(), 1);
        assert_eq!(errors.len(), 1);
        assert!(
            errors[0].message.contains("code 3"),
            "unexpected message: {}",
            errors[0].message
        );
    }

    #[tokio::test]
    async fn a_worker_exiting_with_the_status_it_announced_is_clean() {
        let dir = temp_dir("exit0");
        let entry = reporting_worker(&dir, "exit0.mjs", "");
        let (results, errors) = run_single(entry, "exit0-run").await;
        assert_eq!(results.len(), 1);
        assert_eq!(errors.len(), 0);
    }

    #[tokio::test]
    async fn what_the_worker_prints_is_kept_for_the_file() {
        let dir = temp_dir("output");
        let entry = reporting_worker(
            &dir,
            "printing.mjs",
            r#"process.stdout.write("OUT-LINE\n"); process.stderr.write("ERR-LINE\n");"#,
        );
        let outcome = run_one_file(&dir.join("a.test.ts"), &config(entry, false)).await;
        assert!(outcome.result.is_some());
        assert!(outcome.stdout.contains("OUT-LINE"), "{:?}", outcome.stdout);
        assert!(outcome.stderr.contains("ERR-LINE"), "{:?}", outcome.stderr);
        // The frames themselves are protocol, not output.
        assert!(!outcome.stderr.contains("__HELIX_RESULT__"));
    }

    #[test]
    fn output_past_the_cap_is_counted_not_kept() {
        let mut buffer = OutputBuffer::default();
        buffer.append(&vec![b'x'; MAX_OUTPUT_BYTES + 10]);
        assert_eq!(buffer.data.len(), MAX_OUTPUT_BYTES);
        assert!(buffer.text().ends_with("10 more bytes of output dropped\n"));
    }
}
