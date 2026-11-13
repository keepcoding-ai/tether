// Native crashes leave a trace: Crashpad writes a minidump to <home>/crashes (never uploaded), and every child process or
// renderer that goes away is a line in tether-app.log with its reason and exit code. Called once per Electron process, before
// `ready` (the crash reporter must start early to cover the process's own startup).
import { join } from 'node:path'
import { app, crashReporter } from 'electron'

export function startCrashReports(home: string, processName: string, log: (msg: string) => void): void {
  try {
    app.setPath('crashDumps', join(home, 'crashes'))
    crashReporter.start({ uploadToServer: false, submitURL: '', compress: true, globalExtra: { process: processName } })
  } catch (e) {
    log(`crashReporter não iniciou (${(e as Error).message})`)
  }
  app.on('child-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return
    log(`processo filho parou: ${d.type}${d.name ? ` (${d.name})` : ''}, ${d.reason}, código ${d.exitCode}`)
  })
  app.on('render-process-gone', (_e, wc, d) => {
    log(`renderer parou: webContents ${wc.id}, ${d.reason}, código ${d.exitCode}`)
  })
}
