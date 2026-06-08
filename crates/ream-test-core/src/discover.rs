//! Test-file discovery. Walks a root directory respecting `.gitignore` /
//! `.ignore` (via the `ignore` crate) and matches filenames against
//! include/exclude glob patterns.
//!
//! Defaults are tuned for the JS/TS ecosystem: `*.test.{ts,tsx,js,mjs,cjs}`
//! and `*.spec.{ts,tsx,js,mjs,cjs}` under the root. `node_modules/` and
//! build outputs are excluded upfront.

use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct DiscoveryOptions {
    /// Filename suffixes that mark a test file. Matched case-sensitively
    /// against the file's `.file_name()`. E.g. `.test.ts`.
    pub suffixes: Vec<String>,
    /// Directory names (relative to root) to prune from the walk. Applied
    /// in addition to `.gitignore` semantics.
    pub hard_excludes: Vec<String>,
    /// If true, also descend into `node_modules/` (default: false).
    pub include_node_modules: bool,
}

impl Default for DiscoveryOptions {
    fn default() -> Self {
        Self {
            suffixes: vec![
                ".test.ts".into(),
                ".test.tsx".into(),
                ".test.js".into(),
                ".test.mjs".into(),
                ".test.cjs".into(),
                ".spec.ts".into(),
                ".spec.tsx".into(),
                ".spec.js".into(),
                ".spec.mjs".into(),
                ".spec.cjs".into(),
            ],
            hard_excludes: vec![
                "node_modules".into(),
                "dist".into(),
                "build".into(),
                "coverage".into(),
                ".git".into(),
                ".wolf".into(),
                "target".into(),
            ],
            include_node_modules: false,
        }
    }
}

/// Walk `root` and return every test file, sorted lexicographically.
///
/// The walker uses `ignore::WalkBuilder` which honours `.gitignore`, `.ignore`,
/// and global ignore files. Hidden files (dotfiles) are also skipped.
pub fn discover(root: &Path, opts: &DiscoveryOptions) -> std::io::Result<Vec<PathBuf>> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .follow_links(false)
        .require_git(false);

    // Filter out hard-excluded directories early so we don't even descend.
    let excludes: Vec<String> = opts.hard_excludes.clone();
    let allow_node_modules = opts.include_node_modules;
    builder.filter_entry(move |entry| {
        let name = match entry.file_name().to_str() {
            Some(n) => n,
            None => return true,
        };
        if !allow_node_modules && name == "node_modules" {
            return false;
        }
        !excludes.iter().any(|ex| ex == name)
    });

    let mut out: Vec<PathBuf> = Vec::new();
    for entry in builder.build() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Some(t) => t,
            None => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let name = match entry.file_name().to_str() {
            Some(n) => n,
            None => continue,
        };
        if opts.suffixes.iter().any(|s| name.ends_with(s.as_str())) {
            out.push(entry.into_path());
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(path).unwrap();
        writeln!(f, "// test fixture").unwrap();
    }

    #[test]
    fn finds_test_files_and_ignores_node_modules() {
        let tmp = tempfile_dir();
        touch(&tmp.join("a/foo.test.ts"));
        touch(&tmp.join("a/bar.spec.ts"));
        touch(&tmp.join("a/not-a-test.ts"));
        touch(&tmp.join("node_modules/x/baz.test.ts"));
        touch(&tmp.join("dist/built.test.ts"));

        let opts = DiscoveryOptions::default();
        let files = discover(&tmp, &opts).unwrap();
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"foo.test.ts".to_string()));
        assert!(names.contains(&"bar.spec.ts".to_string()));
        assert!(!names.contains(&"not-a-test.ts".to_string()));
        assert!(!names.contains(&"baz.test.ts".to_string()));
        assert!(!names.contains(&"built.test.ts".to_string()));
    }

    #[test]
    fn results_are_sorted() {
        let tmp = tempfile_dir();
        touch(&tmp.join("z.test.ts"));
        touch(&tmp.join("a.test.ts"));
        touch(&tmp.join("m.test.ts"));
        let files = discover(&tmp, &DiscoveryOptions::default()).unwrap();
        assert!(files.len() == 3);
        assert!(files[0].ends_with("a.test.ts"));
        assert!(files[1].ends_with("m.test.ts"));
        assert!(files[2].ends_with("z.test.ts"));
    }

    fn tempfile_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let id = format!(
            "helix-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        dir.push(id);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
