# Mostra os eventos ao vivo, um por linha: hora, slot, evento, origem, sessão.
$events = Join-Path $PSScriptRoot 'events.jsonl'
if (-not (Test-Path $events)) { New-Item -ItemType File $events | Out-Null }
Write-Host "Aguardando eventos em $events (Ctrl+C para sair)..." -ForegroundColor DarkGray
Get-Content $events -Wait | ForEach-Object {
  $j = $_ | ConvertFrom-Json
  $why = if ($j.payload.source) { $j.payload.source } else { $j.payload.reason }
  '{0}  slot={1,-4} {2,-12} {3,-18} {4}' -f ([datetime]$j.ts).ToLocalTime().ToString("HH:mm:ss"), $j.slot, $j.event, $why, $j.payload.session_id
}
