export const configureSuite = (s) => { s.setup(() => { process.env.FROM_BOOTSTRAP = "1" }) }
export const plugins = [
  ({ config }) => {
    // Un plugin lit la config Japa complète et ajoute un filtre via le refiner
    process.env.SAW_CWD = String(typeof config.cwd === "string")
    process.env.SAW_CONFIGURE_SUITE = String(typeof config.configureSuite === "function")
    process.env.SAW_REPORTERS = String(Array.isArray(config.reporters?.activated))
    process.env.SAW_REFINER = String(typeof config.refiner?.add === "function")
  },
]
