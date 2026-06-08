//! ream-test-core — pure Rust library for the Helix test orchestrator.
//!
//! Contains:
//!   * `discover` — file-system walk honouring .gitignore / .ignore semantics
//!     via the `ignore` crate, filtering by include/exclude glob lists.
//!   * Serde types for the IPC contract with `src/runtime/worker.ts main()`.
//!   * The `Reporter` trait and the aggregator `Summary` type.
//!
//! The `WorkerPool` lives here as a trait definition; the concrete spawning
//! implementation (Node subprocess + IPC) is in the NAPI crate where we
//! have direct access to the event loop via `tokio`/`napi::bindgen_prelude`.

pub mod discover;
pub mod ipc;
pub mod reporter;
pub mod summary;

pub use discover::{discover, DiscoveryOptions};
pub use ipc::{FileResult, SerializedError, SuiteResult, TestResult, WorkerError, WorkerOutgoing};
pub use reporter::{DotReporter, JsonReporter, Reporter, SpecReporter};
pub use summary::{Summary, Totals};
