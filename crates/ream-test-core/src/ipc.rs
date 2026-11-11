//! IPC contract with `src/runtime/worker.ts main()`. The TypeScript worker
//! sends two message shapes: a `result` with a `FileResult` payload, or an
//! `error` when loading or running the file fails unrecoverably.
//!
//! These types are the Rust mirror of the TS definitions in
//! `packages/helix/src/runtime/run.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedError {
    pub name: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TestStatus {
    Pass,
    Fail,
    Skip,
    Todo,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SuiteStatus {
    Pass,
    Fail,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub name: String,
    pub full_name: String,
    pub status: TestStatus,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SerializedError>,
    /// The lifecycle phase `error` was raised in (`setup`, `test`,
    /// `teardown`…), as the worker reports it. Kept as text: a phase this
    /// mirror does not know yet must not turn a whole result into a broken
    /// frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_phase: Option<String>,
}

/// A suite's child: a nested describe or a test.
///
/// Untagged, so serde tries the arms in order and takes the first that
/// fits. `Suite` comes first because it is the stricter shape: a test has no
/// `children`, so it cannot be read as a suite, while a suite carries every
/// field a test requires and, read as one, would lose its children and its
/// hook errors without a word.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SuiteChild {
    Suite(SuiteResult),
    Test(TestResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteResult {
    pub name: String,
    pub full_name: String,
    pub children: Vec<SuiteChild>,
    pub status: SuiteStatus,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub hook_errors: Vec<SerializedError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTotals {
    pub pass: u64,
    pub fail: u64,
    pub skip: u64,
    pub todo: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub file: String,
    pub suites: Vec<SuiteResult>,
    pub tests: Vec<TestResult>,
    pub totals: FileTotals,
    #[serde(default)]
    pub duration_ms: u64,
}

/// Messages sent FROM the worker TO the parent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkerOutgoing {
    #[serde(rename = "result")]
    Result { result: FileResult },
    #[serde(rename = "error")]
    Error(WorkerError),
    /// An error nobody handled (a floating rejection, a timer that threw),
    /// raised while the file ran or after it reported. Not the end of the
    /// worker: the file carries on, and the parent counts it as a file error.
    #[serde(rename = "unhandled")]
    Unhandled(WorkerError),
}

/// A non-result error from the worker (load failure, uncaught, timeout
/// synthesised by the parent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerError {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

/// Messages sent FROM the parent TO the worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkerIncoming {
    #[serde(rename = "run")]
    Run {
        file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn nested_frame() -> Value {
        json!({
            "type": "result",
            "result": {
                "file": "/a.test.ts",
                "suites": [{
                    "name": "outer",
                    "fullName": "outer",
                    "status": "fail",
                    "durationMs": 3,
                    "hookErrors": [],
                    "children": [
                        {
                            "name": "inner",
                            "fullName": "outer > inner",
                            "status": "fail",
                            "durationMs": 2,
                            "hookErrors": [{ "name": "Error", "message": "afterAll broke" }],
                            "children": [{
                                "name": "leaf",
                                "fullName": "outer > inner > leaf",
                                "status": "fail",
                                "durationMs": 1,
                                "error": { "name": "Error", "message": "boom" },
                                "errorPhase": "teardown"
                            }]
                        },
                        {
                            "name": "sibling",
                            "fullName": "outer > sibling",
                            "status": "pass",
                            "durationMs": 1
                        }
                    ]
                }],
                "tests": [],
                "totals": { "pass": 1, "fail": 1, "skip": 0, "todo": 0 },
                "durationMs": 3
            }
        })
    }

    fn file_result(frame: Value) -> FileResult {
        match serde_json::from_value::<WorkerOutgoing>(frame) {
            Ok(WorkerOutgoing::Result { result }) => result,
            other => panic!("expected a result frame, got {:?}", other),
        }
    }

    #[test]
    fn a_nested_suite_stays_a_suite_with_its_children_and_hook_errors() {
        let result = file_result(nested_frame());
        let outer = &result.suites[0];
        let Some(SuiteChild::Suite(inner)) = outer.children.first() else {
            panic!(
                "the nested describe was read as a test: {:?}",
                outer.children
            );
        };
        assert_eq!(inner.full_name, "outer > inner");
        assert_eq!(inner.hook_errors.len(), 1);
        assert_eq!(inner.hook_errors[0].message, "afterAll broke");
        let Some(SuiteChild::Test(leaf)) = inner.children.first() else {
            panic!("the leaf was not read as a test");
        };
        assert_eq!(leaf.full_name, "outer > inner > leaf");
        assert!(matches!(outer.children.get(1), Some(SuiteChild::Test(_))));
    }

    #[test]
    fn re_serialising_keeps_the_tree_and_the_error_phase() {
        let result = file_result(nested_frame());
        let out = serde_json::to_value(&result).expect("serialises");
        let inner = &out["suites"][0]["children"][0];
        assert_eq!(inner["children"][0]["name"], "leaf");
        assert_eq!(inner["children"][0]["errorPhase"], "teardown");
        assert_eq!(inner["hookErrors"][0]["message"], "afterAll broke");
        // A test with no phase does not grow a null one.
        assert!(out["suites"][0]["children"][1].get("errorPhase").is_none());
    }

    /// A describe tree nested `levels` deep, as the worker would frame it.
    /// Built as text: a `Value` that deep would itself recurse to drop.
    fn deep_frame(levels: usize) -> String {
        let mut text = String::from(
            r#"{"type":"result","result":{"file":"/d.test.ts","tests":[],"totals":{"pass":1,"fail":0,"skip":0,"todo":0},"durationMs":0,"suites":["#,
        );
        for level in 0..levels {
            text.push_str(&format!(
                r#"{{"name":"s{level}","fullName":"s{level}","status":"pass","durationMs":0,"hookErrors":[],"children":["#
            ));
        }
        text.push_str(r#"{"name":"leaf","fullName":"leaf","status":"pass","durationMs":0}"#);
        for _ in 0..levels {
            text.push_str("]}");
        }
        text.push_str("]}}");
        text
    }

    #[test]
    fn a_deep_but_legal_tree_survives_the_pool_parse_path() {
        // The pool parses a frame into a Value, then into the typed message.
        let value: Value = serde_json::from_str(&deep_frame(40)).expect("parses");
        let result = file_result(value);
        let mut depth = 0;
        let mut suite = &result.suites[0];
        while let Some(SuiteChild::Suite(child)) = suite.children.first() {
            suite = child;
            depth += 1;
        }
        assert_eq!(depth, 39);
        serde_json::to_string(&result).expect("re-serialises");
    }

    #[test]
    fn a_tree_past_the_nesting_limit_is_an_error_not_a_crash() {
        // Run on a small stack: an unbounded recursion would overflow it and
        // abort the process, which across NAPI takes the whole CLI down.
        let outcome = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                let text = deep_frame(10_000);
                (
                    serde_json::from_str::<Value>(&text).is_err(),
                    serde_json::from_str::<WorkerOutgoing>(&text).is_err(),
                )
            })
            .expect("spawns")
            .join()
            .expect("no panic, no overflow");
        assert_eq!(outcome, (true, true));
    }
}
