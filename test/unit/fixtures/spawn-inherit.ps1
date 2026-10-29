# Handle-inheritance probe for spawnDaemon (test/unit/daemon.spawn.test.ts). Plays the app's part: holds a RAW
# inheritable pipe handle (as Electron holds Playwright's CDP pipe; Node only un-inherits CRT fds) and starts a
# node "mid" with CreateProcess(bInheritHandles=TRUE), which calls spawnDaemon and exits. The pipe reaches EOF
# only when every process holding the client handle is gone: right after mid when the daemon did not inherit
# it, only after the daemon dies when it did.
param([string]$node, [string]$mid, [string]$tetherHome, [string]$tetherPipe, [string]$sleeper)
$server = New-Object System.IO.Pipes.AnonymousPipeServerStream([System.IO.Pipes.PipeDirection]::In, [System.IO.HandleInheritability]::Inheritable)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = "`"$mid`" `"$tetherHome`" `"$tetherPipe`" `"$sleeper`""
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$p = [System.Diagnostics.Process]::Start($psi)
$server.DisposeLocalCopyOfClientHandle()
$t0 = Get-Date
$out = $p.StandardOutput.ReadToEnd()
$p.WaitForExit()
$midMs = [int]((Get-Date) - $t0).TotalMilliseconds
$buf = New-Object byte[] 1
$null = $server.Read($buf, 0, 1)
$eofMs = [int]((Get-Date) - $t0).TotalMilliseconds
Write-Output "midMs=$midMs eofMs=$eofMs out=$($out.Trim())"
