param(
    [string]$RemoteRoot = "dropbox:dropbox_browser",
    [string]$WorkspaceRoot = "E:\dev\dropbox_browser",
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSStyle.OutputRendering = "PlainText"
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rclonePath = Join-Path $WorkspaceRoot "rclone.exe"
$tempRoot = Join-Path $WorkspaceRoot "Temp\rclone-real-repro"
$fullwidthQuestion = [string][char]0xFF1F
$goodSource = Join-Path $tempRoot "plain-question-control.txt"
$badSource = Join-Path $tempRoot ("contains{0}question.txt" -f $fullwidthQuestion)
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$remoteBase = "$RemoteRoot/rclone-unicode-repro/$runStamp"
$remoteWorkaroundBase = "$RemoteRoot/rclone-unicode-repro-workaround/$runStamp"
$encodingWithoutQuestion = "Slash,LtGt,DoubleQuote,Asterisk,Pipe,BackSlash,Ctl,RightSpace,RightPeriod,InvalidUtf8,Dot"

function Invoke-Rclone {
    param(
        [string]$Label,
        [string[]]$Arguments
    )

    $safeLabel = $Label -replace '[^A-Za-z0-9_-]', '-'
    $stdoutPath = Join-Path $tempRoot "$runStamp-$safeLabel.stdout.log"
    $stderrPath = Join-Path $tempRoot "$runStamp-$safeLabel.stderr.log"

    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

    Write-Host "==> $Label"
    Write-Host ("    rclone {0}" -f (($Arguments | ForEach-Object {
                if ($_ -match '\s') {
                    '"' + $_ + '"'
                }
                else {
                    $_
                }
            }) -join " "))

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process `
        -FilePath $rclonePath `
        -ArgumentList $Arguments `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $timedOut = $false
    try {
        Wait-Process -Id $process.Id -Timeout $TimeoutSeconds -ErrorAction Stop
        $process.WaitForExit()
    }
    catch [System.TimeoutException] {
        $timedOut = $true
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit()
    }

    $stopwatch.Stop()
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { @(Get-Content -LiteralPath $stdoutPath) } else { @() }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { @(Get-Content -LiteralPath $stderrPath) } else { @() }

    [ordered]@{
        label = $Label
        arguments = $Arguments
        timeout_seconds = $TimeoutSeconds
        timed_out = $timedOut
        duration_ms = $stopwatch.ElapsedMilliseconds
        exit_code = if ($timedOut) { $null } else { $process.ExitCode }
        stdout_path = $stdoutPath
        stderr_path = $stderrPath
        stdout = $stdout
        stderr = $stderr
    }
}

function Invoke-RcloneCopyTo {
    param(
        [string]$Label,
        [string[]]$ExtraArgs = @(),
        [string]$Source,
        [string]$Destination
    )

    $result = Invoke-Rclone -Label $Label -Arguments (@("copyto") + $ExtraArgs + @("--", $Source, $Destination))
    [ordered]@{
        source = $Source
        destination = $Destination
        exit_code = $result.exit_code
        timed_out = $result.timed_out
        duration_ms = $result.duration_ms
        timeout_seconds = $result.timeout_seconds
        stdout_path = $result.stdout_path
        stderr_path = $result.stderr_path
        stdout = $result.stdout
        stderr = $result.stderr
    }
}

function Invoke-RcloneLsJson {
    param(
        [string]$Label,
        [string]$Target
    )

    $result = Invoke-Rclone -Label $Label -Arguments @("lsjson", "--", $Target)
    [ordered]@{
        target = $Target
        exit_code = $result.exit_code
        timed_out = $result.timed_out
        duration_ms = $result.duration_ms
        timeout_seconds = $result.timeout_seconds
        stdout_path = $result.stdout_path
        stderr_path = $result.stderr_path
        stdout = $result.stdout
        stderr = $result.stderr
    }
}

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
Set-Content -LiteralPath $goodSource -Value "good-source-name test" -Encoding utf8
Set-Content -LiteralPath $badSource -Value "bad-source-name test" -Encoding utf8

$results = [ordered]@{
    workspace_root = $WorkspaceRoot
    temp_root = $tempRoot
    timeout_seconds = $TimeoutSeconds
    remote_root = $RemoteRoot
    remote_base = $remoteBase
    remote_workaround_base = $remoteWorkaroundBase
    sources = [ordered]@{
        good = $goodSource
        bad = $badSource
        good_exists = Test-Path -LiteralPath $goodSource
        bad_exists = Test-Path -LiteralPath $badSource
    }
    remote_control = Invoke-RcloneCopyTo `
        -Label "remote-control" `
        -Source $goodSource `
        -Destination "$remoteBase/plain-question-control.txt"
    remote_failure = Invoke-RcloneCopyTo `
        -Label "remote-failure" `
        -Source $badSource `
        -Destination ("$remoteBase/contains{0}question.txt" -f $fullwidthQuestion)
    remote_failure_listing = Invoke-RcloneLsJson `
        -Label "remote-failure-listing" `
        -Target $remoteBase
    workaround_remote_default_minus_question = Invoke-RcloneCopyTo `
        -Label "workaround-remote-default-minus-question" `
        -ExtraArgs @("--local-encoding", $encodingWithoutQuestion) `
        -Source $badSource `
        -Destination "$remoteWorkaroundBase/default-minus-question.txt"
    workaround_remote_none = Invoke-RcloneCopyTo `
        -Label "workaround-remote-none" `
        -ExtraArgs @("--local-encoding", "None") `
        -Source $badSource `
        -Destination "$remoteWorkaroundBase/none.txt"
    workaround_remote_listing = Invoke-RcloneLsJson `
        -Label "workaround-remote-listing" `
        -Target $remoteWorkaroundBase
}

$results | ConvertTo-Json -Depth 6
