//! `ream-test-napi` — NAPI bindings for the Helix test orchestrator.
//!
//! Exposes a single async function `run(config)` that:
//!   1. Discovers test files (or uses the explicit list from `config.files`).
//!   2. Spawns a pool of Node worker processes via `node --import tsx worker-entry.ts`.
//!   3. Routes `{ type: "run", file }` messages to idle workers and collects
//!      the resulting `{ type: "result", result }` / `{ type: "error", ... }`
//!      replies.
//!   4. Streams progress through a Reporter (dot/spec/json).
//!   5. Returns a `Summary` with aggregated totals + per-file results.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use ream_test_core::ipc::{FileResult, WorkerError};
use ream_test_core::{
    discover, reporter::Reporter, DiscoveryOptions, DotReporter, JsonReporter, SpecReporter,
    Summary,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

mod pool;

#[napi(object)]
pub struct RunConfig {
    /// Absolute root directory to discover from. Required.
    pub root: String,
    /// Explicit files to run (skips discovery if non-empty).
    #[napi(ts_type = "string[] | undefined")]
    pub files: Option<Vec<String>>,
    /// Number of concurrent workers. Defaults to `num_cpus::get()`.
    pub threads: Option<u32>,
    /// Per-file timeout in milliseconds. Default 60 000.
    pub timeout_ms: Option<u32>,
    /// `"dot" | "spec" | "json"`. Default `"spec"`.
    pub reporter: Option<String>,
    /// Activate several reporters at once (Japa `--reporters=spec,json`).
    /// Takes precedence over `reporter` when it holds more than one name.
    #[napi(ts_type = "string[] | undefined")]
    pub reporters: Option<Vec<String>>,
    /// Stop the run at the first failing file (Japa `--bail`).
    pub bail: Option<bool>,
    /// Path to the compiled worker entry (points at the JS shim that calls
    /// `runtime/worker.ts#main()`). Required — there's no sensible default
    /// from Rust's perspective.
    pub worker_entry: String,
    /// Optional `node` executable path. Defaults to `"node"` on `PATH`.
    pub node_bin: Option<String>,
    /// Extra args passed to the node binary (before the worker entry). For
    /// example, `["--import", "tsx"]` to enable TS loading.
    pub node_args: Option<Vec<String>>,
    /// ANSI colours in the Spec reporter. Default true when stdout is TTY.
    pub use_colors: Option<bool>,
}

#[napi(object)]
pub struct SummaryPayload {
    pub pass: u32,
    pub fail: u32,
    pub skip: u32,
    pub todo: u32,
    pub file_errors: u32,
    pub duration_ms: i64,
    pub exit_code: u32,
    /// Full summary as a JSON string (clients that want detail parse this).
    pub json: String,
}

/// One reporter from its CLI-style name; unknown names fall back to Spec,
/// same as the TypeScript factory.
fn make_reporter(kind: &str, use_colors: bool) -> Box<dyn Reporter + Send> {
    match kind {
        "dot" => Box::new(DotReporter::new(std::io::stdout())),
        "json" => Box::new(JsonReporter::new(std::io::stdout())),
        _ => Box::new(SpecReporter::new(std::io::stdout(), use_colors)),
    }
}

/// Fans every reporter callback out to a list of reporters — the Rust side of
/// Japa's `--reporters=spec,json`.
struct MultiReporter {
    reporters: Vec<Box<dyn Reporter + Send>>,
}

impl MultiReporter {
    fn new(reporters: Vec<Box<dyn Reporter + Send>>) -> Self {
        Self { reporters }
    }
}

impl Reporter for MultiReporter {
    fn on_file_start(&mut self, file: &str) {
        for r in &mut self.reporters {
            r.on_file_start(file);
        }
    }

    fn on_file_result(&mut self, result: &FileResult) {
        for r in &mut self.reporters {
            r.on_file_result(result);
        }
    }

    fn on_file_error(&mut self, error: &WorkerError) {
        for r in &mut self.reporters {
            r.on_file_error(error);
        }
    }

    fn on_summary(&mut self, summary: &Summary) {
        for r in &mut self.reporters {
            r.on_summary(summary);
        }
    }
}

#[napi]
pub async fn run(config: RunConfig) -> Result<SummaryPayload> {
    let started = std::time::Instant::now();
    let root = PathBuf::from(&config.root);
    if !root.is_absolute() {
        return Err(Error::from_reason(format!(
            "run: `root` must be absolute, got {:?}",
            config.root
        )));
    }

    let files: Vec<PathBuf> = match config.files {
        Some(ref list) if !list.is_empty() => list.iter().map(PathBuf::from).collect(),
        _ => {
            let opts = DiscoveryOptions::default();
            discover(&root, &opts)
                .map_err(|e| Error::from_reason(format!("discovery failed: {}", e)))?
        }
    };

    let threads = config
        .threads
        .map(|n| n as usize)
        .unwrap_or_else(num_cpus::get)
        .min(files.len().max(1));
    let timeout = Duration::from_millis(config.timeout_ms.unwrap_or(60_000) as u64);

    let use_colors = config.use_colors.unwrap_or(true);
    // A list wins over the single name; either way an empty list falls back to
    // the default reporter.
    let kinds: Vec<String> = match config.reporters {
        Some(list) if !list.is_empty() => list,
        _ => vec![config.reporter.unwrap_or_else(|| "spec".to_string())],
    };
    let built: Vec<Box<dyn Reporter + Send>> = kinds
        .iter()
        .map(|kind| make_reporter(kind, use_colors))
        .collect();
    let reporter: Arc<Mutex<Box<dyn Reporter + Send>>> = if built.len() == 1 {
        Arc::new(Mutex::new(built.into_iter().next().expect("one reporter")))
    } else {
        Arc::new(Mutex::new(Box::new(MultiReporter::new(built))))
    };

    let pool_cfg = pool::PoolConfig {
        node_bin: config.node_bin.unwrap_or_else(|| "node".into()),
        node_args: config.node_args.unwrap_or_default(),
        worker_entry: config.worker_entry,
        threads,
        timeout,
        bail: config.bail.unwrap_or(false),
    };

    let (files_ok, errors) = pool::run_pool(files, pool_cfg, reporter.clone()).await?;

    let duration = started.elapsed();
    let summary = Summary::from_results(files_ok, errors, duration);

    {
        let mut r = reporter.lock().await;
        r.on_summary(&summary);
    }

    let json = serde_json::to_string(&summary)
        .map_err(|e| Error::from_reason(format!("summary serialization failed: {}", e)))?;

    Ok(SummaryPayload {
        pass: summary.totals.pass as u32,
        fail: summary.totals.fail as u32,
        skip: summary.totals.skip as u32,
        todo: summary.totals.todo as u32,
        file_errors: summary.totals.file_errors as u32,
        duration_ms: summary.duration.as_millis() as i64,
        exit_code: summary.exit_code() as u32,
        json,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ream_test_core::ipc::FileTotals;
    use std::sync::{Arc, Mutex};

    /// Appends every callback it receives to a shared log.
    struct Spy {
        tag: &'static str,
        log: Arc<Mutex<Vec<String>>>,
    }

    impl Reporter for Spy {
        fn on_file_start(&mut self, file: &str) {
            self.log.lock().unwrap().push(format!("{}:start:{}", self.tag, file));
        }
        fn on_file_result(&mut self, result: &FileResult) {
            self.log
                .lock()
                .unwrap()
                .push(format!("{}:result:{}", self.tag, result.file));
        }
        fn on_file_error(&mut self, error: &WorkerError) {
            self.log
                .lock()
                .unwrap()
                .push(format!("{}:error:{}", self.tag, error.message));
        }
        fn on_summary(&mut self, _summary: &Summary) {
            self.log.lock().unwrap().push(format!("{}:summary", self.tag));
        }
    }

    fn file_result() -> FileResult {
        FileResult {
            file: "a.test.ts".into(),
            suites: vec![],
            tests: vec![],
            totals: FileTotals { pass: 1, fail: 0, skip: 0, todo: 0 },
            duration_ms: 1,
        }
    }

    #[test]
    fn multi_reporter_reaches_every_reporter_in_order() {
        // `--reporters=spec,json` must feed BOTH; a fan-out that stopped at the
        // first would silently drop the machine-readable half of the output.
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut multi = MultiReporter::new(vec![
            Box::new(Spy { tag: "a", log: log.clone() }),
            Box::new(Spy { tag: "b", log: log.clone() }),
        ]);

        multi.on_file_start("a.test.ts");
        multi.on_file_result(&file_result());
        multi.on_file_error(&WorkerError {
            file: None,
            message: "boom".into(),
            stack: None,
        });
        multi.on_summary(&Summary::default());

        assert_eq!(
            log.lock().unwrap().as_slice(),
            [
                "a:start:a.test.ts",
                "b:start:a.test.ts",
                "a:result:a.test.ts",
                "b:result:a.test.ts",
                "a:error:boom",
                "b:error:boom",
                "a:summary",
                "b:summary",
            ]
        );
    }

    #[test]
    fn a_single_reporter_still_receives_everything() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut multi = MultiReporter::new(vec![Box::new(Spy { tag: "only", log: log.clone() })]);

        multi.on_file_start("a.test.ts");
        multi.on_summary(&Summary::default());

        assert_eq!(log.lock().unwrap().as_slice(), ["only:start:a.test.ts", "only:summary"]);
    }

}
