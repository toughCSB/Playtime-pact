#!/usr/bin/env node
import { renderConfig, validateDeploymentPreflight, validateRenderedConfig } from './renderConfig.mjs'

function parseArgv(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--env') options.env = argv[++index]
    else if (flag === '--inputs') options.inputsPath = argv[++index]
    else if (flag === '--out') options.outputPath = argv[++index]
    else if (flag === '--validate') options.validate = true
    else if (flag === '--external-preflight') options.externalPreflight = true
    else throw new Error(`BAD_ARGUMENT: unrecognized argument ${flag}`)
  }
  if (!options.env) throw new Error('BAD_ARGUMENT: --env is required')
  return options
}

try {
  const { validate, externalPreflight, ...options } = parseArgv(process.argv.slice(2))
  if (externalPreflight && !validate) throw new Error('BAD_ARGUMENT: --external-preflight requires --validate')
  const result = validate
    ? externalPreflight ? await validateDeploymentPreflight(options) : validateRenderedConfig(options)
    : renderConfig(options)
  const { contents, ...printable } = result
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
