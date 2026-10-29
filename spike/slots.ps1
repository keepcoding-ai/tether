# Mostra o vínculo atual de cada slot (último SessionStart) e o comando para retomá-lo.
$events = Join-Path $PSScriptRoot 'events.jsonl'
Get-Content $events | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object event -eq 'SessionStart' |
  Group-Object slot | ForEach-Object {
    $last = $_.Group[-1]
    [pscustomobject]@{ Slot = $_.Name; Sessao = $last.payload.session_id; Pasta = $last.payload.cwd
      Retomar = ".\start-claude.ps1 -Slot $($_.Name) -Cwd `"$($last.payload.cwd)`" --resume $($last.payload.session_id)" }
  } | Format-List
