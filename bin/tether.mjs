#!/usr/bin/env node
// Node >= 24 runs the TypeScript sources directly (type stripping).
import { main } from '../src/cli/main.ts'

process.exitCode = await main(process.argv.slice(2))
