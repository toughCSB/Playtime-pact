#!/usr/bin/env node
/**
 * Operator CLI for the signed permission-control endpoints.
 * The environment's worker base URL comes from the local release inventory; the
 * signing key is supplied as a local private JWK path and is never printed.
 */
import { getControls, localJwkSigner, parsePermissions, setControls } from './controlPermissions.mjs'
import { resolveEnvironment } from './renderConfig.mjs'

function parseArgv(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--env') options.env = argv[++index]
    else if (flag === '--inputs') options.inputsPath = argv[++index]
    else if (flag === '--scope') options.scope = argv[++index]
    else if (flag === '--household-id') options.householdId = argv[++index]
    else if (flag === '--permissions') options.permissions = parsePermissions(argv[++index])
    else if (flag === '--expected-version') options.expectedVersion = Number(argv[++index])
    else if (flag === '--operator-actor') options.operatorActor = argv[++index]
    else if (flag === '--operator-key') options.operatorKeyPath = argv[++index]
    else if (flag === '--set') options.set = true
    else throw new Error(`BAD_ARGUMENT: unrecognized argument ${flag}`)
  }
  if (!options.env) throw new Error('BAD_ARGUMENT: --env is required')
  if (!options.operatorKeyPath) throw new Error('BAD_ARGUMENT: --operator-key is required')
  return options
}

async function main() {
  const options = parseArgv(process.argv.slice(2))
  const environment = resolveEnvironment(options.env, { inputsPath: options.inputsPath })
  const signer = await localJwkSigner({
    actorId: options.operatorActor ?? environment.operatorAuthorityActorId,
    privateJwkPath: options.operatorKeyPath,
  })
  const baseUrl = environment.workerBaseUrl
  if (options.set) {
    return setControls({ baseUrl, scope: options.scope, householdId: options.householdId, permissions: options.permissions, expectedVersion: options.expectedVersion, signer })
  }
  return getControls({ baseUrl, householdId: options.householdId, signer })
}

main()
  .then((result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`) })
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
