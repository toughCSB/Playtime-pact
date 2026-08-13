#!/usr/bin/env node
import { runAuthorityCommand } from './bootstrapAuthorities.mjs'

function parseArgv(argv) {
  const options = { local: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--env') options.env = argv[++index]
    else if (flag === '--inputs') options.inputsPath = argv[++index]
    else if (flag === '--setup-actor') options.setupActor = argv[++index]
    else if (flag === '--setup-jwk') options.setupJwkPath = argv[++index]
    else if (flag === '--operator-actor') options.operatorActor = argv[++index]
    else if (flag === '--operator-jwk') options.operatorJwkPath = argv[++index]
    else if (flag === '--local') options.local = true
    else if (flag === '--verify') options.verify = true
    else throw new Error(`BAD_ARGUMENT: unrecognized argument ${flag}`)
  }
  if (!options.env) throw new Error('BAD_ARGUMENT: --env is required')
  return options
}

const { verify, ...options } = parseArgv(process.argv.slice(2))
runAuthorityCommand(verify ? 'verify' : 'bootstrap', options)
  .then((result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`) })
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
