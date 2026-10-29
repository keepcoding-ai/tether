# Abre o Claude num "slot" com os hooks do spike.
# Uso: .\start-claude.ps1 [-Slot A] [-Cwd D:\pasta] [qualquer argumento do claude...]
# Ex.: .\start-claude.ps1 -Slot B -Cwd D:\sources\api --resume <id>
$Slot = 'A'; $Cwd = (Get-Location).Path; $ClaudeArgs = @()
for ($i = 0; $i -lt $args.Count; $i++) {
  switch -exact ($args[$i]) {
    '-Slot' { $Slot = $args[++$i] }
    '-Cwd'  { $Cwd = $args[++$i] }
    default { $ClaudeArgs += $args[$i] }
  }
}
$here = $PSScriptRoot
$events = Join-Path $here 'events.jsonl'
$report = (Join-Path $here 'report.mjs').Replace('\', '/')
$settings = Join-Path $here 'settings.generated.json'
@{ hooks = @{
    SessionStart = @(@{ hooks = @(@{ type = 'command'; command = "node `"$report`" SessionStart" }) })
    SessionEnd   = @(@{ hooks = @(@{ type = 'command'; command = "node `"$report`" SessionEnd" }) })
} } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $settings
# Sem isso o claude não grava a sessão quando lançado de dentro de outro Claude Code.
Get-ChildItem env: | Where-Object Name -like 'CLAUDE*' | ForEach-Object { Remove-Item "env:$($_.Name)" }
$env:TETHER_SLOT_ID = $Slot
$env:TETHER_EVENTS = $events
Push-Location $Cwd
try { & claude --settings $settings @ClaudeArgs } finally { Pop-Location }
