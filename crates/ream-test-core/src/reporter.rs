//! Reporter trait + three built-in implementations.
//!
//! Reporters receive lifecycle callbacks as each file completes. They
//! write to a `std::io::Write` sink (usually stdout for `Dot`/`Spec`,
//! stderr for `Json` diagnostics).

use crate::ipc::{FileResult, TestStatus, WorkerError};
use crate::summary::Summary;
use std::io::Write;

pub trait Reporter {
    fn on_file_start(&mut self, file: &str);
    fn on_file_result(&mut self, result: &FileResult);
    fn on_file_error(&mut self, error: &WorkerError);
    fn on_summary(&mut self, summary: &Summary);
}

/// Minimal reporter: one char per test (`.`/`F`/`-`/`*`), final summary.
pub struct DotReporter<W: Write> {
    pub sink: W,
}

impl<W: Write> DotReporter<W> {
    pub fn new(sink: W) -> Self {
        Self { sink }
    }
}

impl<W: Write> Reporter for DotReporter<W> {
    fn on_file_start(&mut self, _file: &str) {}

    fn on_file_result(&mut self, result: &FileResult) {
        for t in &result.tests {
            let c = match t.status {
                TestStatus::Pass => '.',
                TestStatus::Fail => 'F',
                TestStatus::Skip => '-',
                TestStatus::Todo => '*',
            };
            let _ = write!(self.sink, "{}", c);
        }
        let _ = self.sink.flush();
    }

    fn on_file_error(&mut self, _error: &WorkerError) {
        let _ = write!(self.sink, "E");
        let _ = self.sink.flush();
    }

    fn on_summary(&mut self, summary: &Summary) {
        let _ = writeln!(self.sink);
        print_summary(&mut self.sink, summary);
    }
}

/// Verbose nested view, one file per section. Failures render a small diff.
pub struct SpecReporter<W: Write> {
    pub sink: W,
    use_colors: bool,
}

impl<W: Write> SpecReporter<W> {
    pub fn new(sink: W, use_colors: bool) -> Self {
        Self { sink, use_colors }
    }
}

fn dim(s: &str, use_colors: bool) -> String {
    if use_colors {
        format!("\x1b[90m{}\x1b[0m", s)
    } else {
        s.to_string()
    }
}
fn green(s: &str, use_colors: bool) -> String {
    if use_colors {
        format!("\x1b[32m{}\x1b[0m", s)
    } else {
        s.to_string()
    }
}
fn red(s: &str, use_colors: bool) -> String {
    if use_colors {
        format!("\x1b[31m{}\x1b[0m", s)
    } else {
        s.to_string()
    }
}
fn yellow(s: &str, use_colors: bool) -> String {
    if use_colors {
        format!("\x1b[33m{}\x1b[0m", s)
    } else {
        s.to_string()
    }
}

impl<W: Write> Reporter for SpecReporter<W> {
    fn on_file_start(&mut self, file: &str) {
        let _ = writeln!(
            self.sink,
            "{} {}",
            dim("▶", self.use_colors),
            dim(file, self.use_colors)
        );
    }

    fn on_file_result(&mut self, result: &FileResult) {
        for t in &result.tests {
            let (marker, name) = match t.status {
                TestStatus::Pass => (green("✔", self.use_colors), t.full_name.as_str()),
                TestStatus::Fail => (red("✘", self.use_colors), t.full_name.as_str()),
                TestStatus::Skip => (yellow("○", self.use_colors), t.full_name.as_str()),
                TestStatus::Todo => (dim("☐", self.use_colors), t.full_name.as_str()),
            };
            let _ = writeln!(self.sink, "  {} {}", marker, name);
            if let Some(err) = &t.error {
                let _ = writeln!(self.sink, "      {}", red(&err.message, self.use_colors));
                if let (Some(a), Some(e)) = (&err.actual, &err.expected) {
                    let _ = writeln!(
                        self.sink,
                        "      {} {}",
                        dim("actual:  ", self.use_colors),
                        a
                    );
                    let _ = writeln!(
                        self.sink,
                        "      {} {}",
                        dim("expected:", self.use_colors),
                        e
                    );
                }
            }
        }
    }

    fn on_file_error(&mut self, error: &WorkerError) {
        let file = error.file.as_deref().unwrap_or("<unknown>");
        let _ = writeln!(
            self.sink,
            "{} {}: {}",
            red("✘", self.use_colors),
            file,
            error.message
        );
    }

    fn on_summary(&mut self, summary: &Summary) {
        let _ = writeln!(self.sink);
        print_summary(&mut self.sink, summary);
    }
}

/// NDJSON reporter: one JSON object per line, machine-readable.
pub struct JsonReporter<W: Write> {
    pub sink: W,
}

impl<W: Write> JsonReporter<W> {
    pub fn new(sink: W) -> Self {
        Self { sink }
    }
}

impl<W: Write> Reporter for JsonReporter<W> {
    fn on_file_start(&mut self, file: &str) {
        let _ = writeln!(
            self.sink,
            "{}",
            serde_json::json!({ "event": "file:start", "file": file })
        );
    }

    fn on_file_result(&mut self, result: &FileResult) {
        let _ = writeln!(
            self.sink,
            "{}",
            serde_json::json!({ "event": "file:end", "result": result })
        );
    }

    fn on_file_error(&mut self, error: &WorkerError) {
        let _ = writeln!(
            self.sink,
            "{}",
            serde_json::json!({ "event": "file:error", "error": error })
        );
    }

    fn on_summary(&mut self, summary: &Summary) {
        let _ = writeln!(
            self.sink,
            "{}",
            serde_json::json!({ "event": "summary", "summary": summary })
        );
    }
}

fn print_summary<W: Write>(sink: &mut W, summary: &Summary) {
    let t = &summary.totals;
    let _ = writeln!(sink, "──────────────────────────────────────");
    let _ = writeln!(
        sink,
        "  {} passed | {} failed | {} skipped | {} todo | {} file errors",
        t.pass, t.fail, t.skip, t.todo, t.file_errors,
    );
    let _ = writeln!(sink, "  {} ms", summary.duration.as_millis());
}
