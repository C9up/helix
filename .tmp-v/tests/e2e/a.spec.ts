import { test } from "@c9up/helix/runtime"
test("both configure paths ran, plugin saw the config", () => {
  const missing = []
  if (process.env.PER_SUITE !== "1") missing.push("per-suite configure")
  if (process.env.FROM_BOOTSTRAP !== "1") missing.push("bootstrap configureSuite")
  for (const k of ["SAW_CWD","SAW_CONFIGURE_SUITE","SAW_REPORTERS","SAW_REFINER"]) {
    if (process.env[k] !== "true") missing.push(k)
  }
  if (missing.length) throw new Error("manquant: " + missing.join(", "))
})
