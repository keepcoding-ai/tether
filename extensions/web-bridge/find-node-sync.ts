// `findNode` with the synchronous existence probe: for the CLI, the installer and Electron main (never tetherd, which uses
// findNodeAsync through `api.io`). Kept apart so the tetherd import graph stays free of synchronous fs.
import { existsSync } from 'node:fs'
import { findNode as findNodeWith } from './warmup.ts'

export const findNode = (env: NodeJS.ProcessEnv = process.env): string | undefined => findNodeWith(env, existsSync)
