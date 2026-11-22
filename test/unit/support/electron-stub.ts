// Stands in for 'electron' in unit tests that load modules importing it (process-host.ts): just enough surface to import and activate.
import { EventEmitter } from 'node:events'

export const app = new EventEmitter()
export const screen = new EventEmitter()
export const session = {}
export const shell = {}
export default { app, screen, session, shell }
