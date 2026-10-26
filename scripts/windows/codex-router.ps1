#Requires -Version 5.1
<#
.SYNOPSIS
    Codex Router CLI: установка, ключи провайдеров, запуск, статус, удаление.

.DESCRIPTION
    %USERPROFILE%\.codex\codex-router:
      codex-router.mjs          мост
      codex-router.config.json  порт
      keys.dpapi                ключи провайдеров (JSON), DPAPI CurrentUser + ACL
      node-path.txt             путь к node.exe
      utils\supervise.vbs       супервизор без окна
      logs\                     журналы

    Автозапуск: HKCU\...\Run -> wscript supervise.vbs.

.EXAMPLE
    .\codex-router.ps1 install -Force
    .\codex-router.ps1 key -Provider minimax -Key sk-...
    .\codex-router.ps1 status
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'key')]
    [string]$Action,

    [string]$CodexHome = (Join-Path $env:USERPROFILE '.codex'),
    [int]$Port = 8788,
    [ValidateSet('deepseek', 'minimax')]
    [string]$Provider = 'deepseek',
    [string]$Key,
    [string]$KeyFile,
    [string]$MinimaxKey,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue

$InstallDir = Join-Path $CodexHome 'codex-router'
$RouterJs   = Join-Path $InstallDir 'codex-router.mjs'
$Vault      = Join-Path $InstallDir 'keys.dpapi'
$LegacyKey  = Join-Path $InstallDir 'secret.dpapi'
$NodeFile   = Join-Path $InstallDir 'node-path.txt'
$PauseFlag  = Join-Path $InstallDir 'paused.flag'
$ConfigToml = Join-Path $CodexHome 'config.toml'
$Catalog    = Join-Path $CodexHome 'models.mixed.json'
$Utils      = Join-Path $InstallDir 'utils'
$Vbs        = Join-Path $Utils 'supervise.vbs'
$RunKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName    = 'CodexRouter'
$WScript    = Join-Path $env:SystemRoot 'System32\wscript.exe'
$RepoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

# ---------- базовое ----------

function Get-NodePath {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) {
        $node = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node') -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $node) { throw 'node.exe не найден.' }
    $node
}

function Test-PortBusy { [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) }

function Get-RouterHealth {
    try { (Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 4).Content | ConvertFrom-Json }
    catch { $null }
}

# ---------- хранилище ключей ----------

function Protect-WithDpapi([string]$plain) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
    $prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
    [Convert]::ToBase64String($prot)
}

function Unprotect-WithDpapi([string]$blob) {
    $bytes = [Convert]::FromBase64String($blob)
    [System.Text.Encoding]::UTF8.GetString(
        [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'))
}

function Read-Vault {
    $map = @{}
    if (-not (Test-Path -LiteralPath $Vault)) { return $map }
    try {
        $json = Unprotect-WithDpapi ([System.IO.File]::ReadAllText($Vault).Trim())
        $obj = $json | ConvertFrom-Json
        foreach ($p in $obj.PSObject.Properties) { $map[$p.Name] = [string]$p.Value }
    } catch {
        Write-Host "Не удалось прочитать хранилище ключей: $($_.Exception.Message)"
    }
    $map
}

function Write-Vault([hashtable]$map) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $json = ($map | ConvertTo-Json -Compress)
    $blob = Protect-WithDpapi $json
    if ((Unprotect-WithDpapi $blob) -ne $json) { throw 'Проверка шифрования хранилища не прошла.' }
    [System.IO.File]::WriteAllText($Vault, $blob, $Utf8NoBom)
    & icacls.exe $Vault /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
}

function Set-ProviderKey([string]$name, [string]$plain) {
    if (-not $plain -or $plain.Length -lt 16) { throw "Ключ для $name подозрительно короткий." }
    $map = Read-Vault
    $map[$name] = $plain
    Write-Vault $map
    Write-Host "Ключ $name сохранён в $Vault"
}

function Get-Masked([string]$k) {
    if ($k.Length -lt 12) { return '***' }
    $k.Substring(0, 5) + ('*' * 8) + $k.Substring($k.Length - 4)
}

# ---------- процесс ----------

function Start-Router {
    if (Test-PortBusy) { Write-Host "Порт $Port уже слушает."; return }
    if (-not (Test-Path -LiteralPath $RouterJs)) { throw "Нет $RouterJs. Сначала install." }
    $logs = Join-Path $InstallDir 'logs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $node = if (Test-Path -LiteralPath $NodeFile) { (Get-Content -LiteralPath $NodeFile -Raw).Trim() } else { Get-NodePath }
    $p = Start-Process -FilePath $node -ArgumentList @("`"$RouterJs`"") -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logs 'router.out.log') `
        -RedirectStandardError (Join-Path $logs 'router.err.log')
    Start-Sleep -Seconds 2
    $h = Get-RouterHealth
    if ($h) { Write-Host "Codex Router запущен (pid $($p.Id), порт $Port)." }
    else {
        Write-Host 'Роутер не ответил. Лог:'
        Get-Content (Join-Path $logs 'router.err.log') -ErrorAction SilentlyContinue | Select-Object -Last 10
    }
}

function Stop-Router {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { Write-Host 'Роутер не запущен.' }
    foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 400
}

function Get-Supervisors {
    Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*supervise.vbs*' }
}

function Start-Supervisor {
    if (-not (Test-Path -LiteralPath $Vbs)) { throw "Нет $Vbs. Сначала install." }
    if (Test-Path -LiteralPath $PauseFlag) { Remove-Item -LiteralPath $PauseFlag -Force }
    if (Get-Supervisors) { Write-Host 'Супервизор уже работает.'; return }
    Start-Process -FilePath $WScript -ArgumentList @("`"$Vbs`"") -WindowStyle Hidden
    Write-Host 'Супервизор запущен.'
}

function Stop-Supervisor {
    New-Item -ItemType File -Force -Path $PauseFlag | Out-Null
    foreach ($s in Get-Supervisors) { Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host 'Супервизор остановлен.'
}

# ---------- автозапуск ----------

function Install-Autostart {
    New-Item -Path $RunKey -Force | Out-Null
    $value = "`"$WScript`" `"$Vbs`""
    New-ItemProperty -Path $RunKey -Name $RunName -Value $value -PropertyType String -Force | Out-Null
    Write-Host "Автозапуск: $value"
}

function Remove-Autostart {
    Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
    Write-Host 'Автозапуск удалён.'
}

# ---------- каталог Codex ----------

function Build-Catalog {
    $node = Get-NodePath
    & $node (Join-Path $RepoRoot 'tools\build-catalog.mjs') `
        --codex-home $CodexHome `
        --template (Join-Path $RepoRoot 'templates\model-template.json') `
        --out $Catalog
    if ($LASTEXITCODE -ne 0) { throw 'build-catalog.mjs завершился с ошибкой' }
}

function Update-CodexConfig {
    $node = Get-NodePath
    & $node (Join-Path $RepoRoot 'tools\patch-config.mjs') `
        --config $ConfigToml --catalog $Catalog --port $Port
    if ($LASTEXITCODE -ne 0) { throw 'patch-config.mjs завершился с ошибкой' }
}
# ---------- действия ----------

switch ($Action) {
    'install' {
        if (-not (Test-Path -LiteralPath $ConfigToml)) { throw "Нет $ConfigToml. Запустите Codex и войдите в аккаунт." }

        New-Item -ItemType Directory -Force -Path $InstallDir, $Utils, (Join-Path $InstallDir 'logs') | Out-Null
        Copy-Item (Join-Path $RepoRoot 'src\codex-router.mjs') $RouterJs -Force
        Copy-Item (Join-Path $PSScriptRoot 'supervise.vbs') $Vbs -Force
        foreach ($stale in 'ensure.ps1', 'launch-hidden.vbs') {
            $sp = Join-Path $Utils $stale
            if (Test-Path -LiteralPath $sp) { Remove-Item -LiteralPath $sp -Force }
        }
        [System.IO.File]::WriteAllText($NodeFile, (Get-NodePath), $Utf8NoBom)

        $cfgFile = Join-Path $InstallDir 'codex-router.config.json'
        if (-not (Test-Path -LiteralPath $cfgFile)) {
            [System.IO.File]::WriteAllText($cfgFile,
                ([ordered]@{ port = $Port } | ConvertTo-Json -Depth 5), $Utf8NoBom)
        }

        # миграция старых ключей в общее хранилище
        $vaultMap = Read-Vault
        if (Test-Path -LiteralPath $LegacyKey) {
            try {
                $raw = Unprotect-WithDpapi ([System.IO.File]::ReadAllText($LegacyKey).Trim())
                if (-not $vaultMap['deepseek']) { $vaultMap['deepseek'] = $raw.Trim() }
                Remove-Item -LiteralPath $LegacyKey -Force
                Write-Host 'Старый одиночный ключ перенесён в хранилище.'
            } catch { Write-Host 'Старый одиночный ключ не прочитан, пропускаю.' }
        }
        if ($Key) { $vaultMap[$Provider] = $Key }
        if ($KeyFile) { $vaultMap[$Provider] = (Get-Content -LiteralPath $KeyFile -Raw).Trim() }
        if ($MinimaxKey) { $vaultMap['minimax'] = $MinimaxKey }
        if ($env:DEEPSEEK_API_KEY -and -not $vaultMap['deepseek']) { $vaultMap['deepseek'] = $env:DEEPSEEK_API_KEY.Trim() }
        if ($env:MINIMAX_API_KEY -and -not $vaultMap['minimax']) { $vaultMap['minimax'] = $env:MINIMAX_API_KEY.Trim() }

        if (-not $vaultMap['deepseek'] -and -not $vaultMap['minimax']) {
            $secure = Read-Host 'Вставьте ключ DeepSeek (ввод скрыт)' -AsSecureString
            $vaultMap['deepseek'] = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
                [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        }
        Write-Vault $vaultMap
        foreach ($k in $vaultMap.Keys) { Write-Host ("  ключ {0}: {1}" -f $k, (Get-Masked $vaultMap[$k])) }

        Build-Catalog
        Update-CodexConfig
        Install-Autostart
        Stop-Supervisor | Out-Null
        Stop-Router | Out-Null
        Start-Supervisor
        Start-Sleep -Seconds 3
        $h = Get-RouterHealth
        if ($h) { Write-Host 'Мост поднят.' } else { Write-Host 'Мост не ответил, смотрите logs.' }
        Write-Host ''
        Write-Host 'Готово. Перезапустите Codex, чтобы он прочитал конфиг.'
    }

    'start'   { Start-Supervisor; Start-Sleep -Seconds 3; if (Test-PortBusy) { Write-Host "Порт $Port слушает." } }
    'stop'    { Stop-Supervisor; Stop-Router }
    'restart' { Stop-Supervisor; Stop-Router; Start-Supervisor; Start-Sleep -Seconds 3; if (Get-RouterHealth) { Write-Host 'Мост снова работает.' } }

    'status' {
        $h = Get-RouterHealth
        if ($h) {
            Write-Host "Codex Router: работает на :$($h.port)"
            foreach ($p in $h.providers.PSObject.Properties) {
                $v = $p.Value
                Write-Host ("  {0,-8} {1}  ключ={2} ({3})  reasoning={4}" -f $p.Name, $v.base, $v.key, $v.keySource, $v.reasoning)
                $v.models.PSObject.Properties | ForEach-Object { Write-Host ("             {0} -> {1}" -f $_.Name, $_.Value) }
            }
            Write-Host ("  openai   {0}" -f $h.openai.base)
            $log = (Invoke-WebRequest "http://127.0.0.1:$Port/router/log?limit=6" -UseBasicParsing -TimeoutSec 4).Content | ConvertFrom-Json
            Write-Host '  последние маршруты:'
            $log.routes | ForEach-Object { Write-Host ("    {0}  {1,-24} -> {2,-8} {3} {4}ms" -f $_.t, $_.model, $_.target, $_.status, $_.ms) }
        } else {
            Write-Host "Codex Router не отвечает на :$Port"
        }
        $run = (Get-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue).$RunName
        Write-Host ("  автозапуск: " + $(if ($run) { 'настроен' } else { 'нет' }))
        Write-Host ("  супервизор: " + $(if (Get-Supervisors) { 'работает' } else { 'остановлен' }))
    }

    'logs' {
        $logs = Join-Path $InstallDir 'logs'
        foreach ($f in 'router.err.log', 'routes.jsonl') {
            $p = Join-Path $logs $f
            if (Test-Path -LiteralPath $p) { Write-Host "--- $f ---"; Get-Content -LiteralPath $p -Tail 20 }
        }
    }

    'key' {
        if ($Key -or $KeyFile) {
            $plain = if ($Key) { $Key } else { (Get-Content -LiteralPath $KeyFile -Raw).Trim() }
            Set-ProviderKey $Provider $plain
            Stop-Supervisor | Out-Null
            Stop-Router
            Start-Supervisor
            break
        }
        $map = Read-Vault
        if (-not $map.Count) { Write-Host 'Хранилище пустое.'; break }
        foreach ($k in $map.Keys) {
            Write-Host ("{0}: {1}" -f $k, (Get-Masked $map[$k]))
            if ($Force) { Write-Host ("  открытым текстом: {0}" -f $map[$k]) }
        }
    }

    'uninstall' {
        Remove-Autostart
        Stop-Supervisor | Out-Null
        Stop-Router
        if (Test-Path -LiteralPath $InstallDir) {
            Remove-Item -LiteralPath $InstallDir -Recurse -Force
            Write-Host "Удалена папка $InstallDir"
        }
        Write-Host 'Конфиг Codex не тронут.'
    }
}
