export default {
  suites: [{
    name: "e2e",
    files: "tests/e2e/**/*.spec.ts",
    configure: (s) => s.setup(() => { process.env.PER_SUITE = "1" }),
  }],
}
