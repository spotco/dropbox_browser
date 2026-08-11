<#
Install the Windows runtime tool pack using only Windows PowerShell 5.1 and
the .NET Framework it ships with. Do not add module dependencies here: this
script must work before portable Python or any other runtime is installed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [string]$ManifestPath = '',
    [string]$ArchivePath = ''
)

$ErrorActionPreference = 'Stop'

function Test-SafeArchiveEntries {
    param(
        [Parameter(Mandatory = $true)] [string]$ArchivePath,
        [Parameter(Mandatory = $true)] [string]$ExtractRoot,
        [Parameter(Mandatory = $true)] [string]$PlatformId
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entries = @($archive.Entries)
        if ($entries.Count -eq 0) {
            throw "Tool pack archive is empty: $ArchivePath"
        }
        $rootWithSeparator = [System.IO.Path]::GetFullPath($ExtractRoot).TrimEnd('\') + '\'
        foreach ($entry in $entries) {
            $name = $entry.FullName.Replace('/', '\')
            $parts = @($name.Split('\', [System.StringSplitOptions]::RemoveEmptyEntries))
            if (
                [string]::IsNullOrWhiteSpace($name) -or
                [System.IO.Path]::IsPathRooted($name) -or
                $parts.Count -eq 0 -or
                $parts[0] -ne $PlatformId -or
                ($parts -contains '..')
            ) {
                throw "Unsafe tool pack archive member: $($entry.FullName)"
            }
            $destination = [System.IO.Path]::GetFullPath((Join-Path $ExtractRoot $name))
            if (-not $destination.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Tool pack archive member escapes extraction root: $($entry.FullName)"
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

$repo = [System.IO.Path]::GetFullPath($RepoRoot)
$manifestPath = if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    Join-Path $repo 'tools\runtime_manifest.json'
} else {
    [System.IO.Path]::GetFullPath($ManifestPath)
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Tool pack manifest is missing: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.format -ne 'dropbox-browser-tool-packs-v1') {
    throw "Unsupported tool pack manifest format: $($manifest.format)"
}

$platformId = 'windows-x64'
$entry = $manifest.platforms.$platformId
if ($null -eq $entry -or [string]::IsNullOrWhiteSpace([string]$entry.asset) -or [string]::IsNullOrWhiteSpace([string]$entry.sha256)) {
    throw "The manifest has no complete $platformId pack entry."
}
$url = [string]$entry.url
if ([string]::IsNullOrWhiteSpace($url)) {
    $baseUrl = ([string]$manifest.base_url).TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $repository = if ([string]::IsNullOrWhiteSpace([string]$manifest.repository)) { 'spotco/dropbox_browser' } else { [string]$manifest.repository }
        $releaseTag = if ([string]::IsNullOrWhiteSpace([string]$manifest.release_tag)) { 'tools-v1' } else { [string]$manifest.release_tag }
        $baseUrl = "https://github.com/$repository/releases/download/$releaseTag"
    }
    $url = "$baseUrl/$($entry.asset)"
}

$temporaryDirectory = $null
$archive = $null
if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
    $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("dropbox-browser-tools-" + [Guid]::NewGuid().ToString('N'))
    $archive = Join-Path $temporaryDirectory ([string]$entry.asset)
} else {
    $archive = [System.IO.Path]::GetFullPath($ArchivePath)
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        throw "Specified tool pack archive is missing: $archive"
    }
}
$extractRoot = Join-Path $repo '.tools'
$platformRoot = Join-Path $extractRoot $platformId

try {
    if ($null -ne $temporaryDirectory) {
        New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
        # GitHub requires TLS 1.2; the API exists in Windows PowerShell 5.1.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Host "Downloading $platformId tool pack..."
        Write-Host "  $url"
        $client = New-Object System.Net.WebClient
        try {
            $client.DownloadFile($url, $archive)
        }
        finally {
            $client.Dispose()
        }
    }

    $expectedSha256 = ([string]$entry.sha256).Trim().ToLowerInvariant()
    $actualSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        throw "SHA-256 mismatch for $($entry.asset). Expected $expectedSha256, got $actualSha256."
    }

    Test-SafeArchiveEntries -ArchivePath $archive -ExtractRoot $extractRoot -PlatformId $platformId
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    if (Test-Path -LiteralPath $platformRoot) {
        Remove-Item -LiteralPath $platformRoot -Recurse -Force
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Write-Host "Extracting to $platformRoot..."
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $extractRoot)
    [System.IO.File]::WriteAllText((Join-Path $platformRoot '.pack-sha256'), "$expectedSha256`n", (New-Object System.Text.UTF8Encoding($false)))
}
finally {
    if ($null -ne $temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $platformRoot 'python\python.exe') -PathType Leaf)) {
    throw "Tool pack extraction completed, but portable Python is missing from $platformRoot"
}
Write-Host "Installed: $platformRoot"
