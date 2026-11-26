// The native notice of the machine (fio-spec 3.2 (d), 3.4): every pairing begun, every ceremony failed after P2 and every
// device paired shows on the machine, whatever the app's screen shows, so a process that imitates the app cannot pair in
// silence. Windows: a toast through the WinRT notification API (no module to install). The texts are this file's
// constants, never data from a device. Bench: under TETHER_TEST_REMOTE=1 with TETHER_TEST_REMOTE_NOTICE=<file> the line
// is appended to that file instead (a test never pops a toast on the person's screen).
import { spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'

const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

function toastScript(title: string, body: string): string {
  const quote = "'"
  const q = (s: string): string => quote + s.split(quote).join(quote + quote) + quote
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$t = $x.GetElementsByTagName("text")',
    `$t.Item(0).AppendChild($x.CreateTextNode(${q(title)})) | Out-Null`,
    `$t.Item(1).AppendChild($x.CreateTextNode(${q(body)})) | Out-Null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${q(APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('; ')
}

export function makeNotice(env: NodeJS.ProcessEnv, log: (msg: string) => void): (text: string) => void {
  const file = env.TETHER_TEST_REMOTE === '1' ? env.TETHER_TEST_REMOTE_NOTICE : undefined
  if (file) return (text) => { appendFile(file, `${new Date().toISOString()} ${text}\n`).catch(() => { /* bench only */ }) }
  return (text) => {
    if (process.platform !== 'win32') { log(`notice: ${text}`); return }
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', toastScript('Tether: acesso remoto', text)],
        { windowsHide: true, stdio: 'ignore', detached: false })
      child.on('error', (e) => log(`notice: the toast failed (${e.message})`))
    } catch (e) { log(`notice: the toast failed (${(e as Error).message})`) }
  }
}
