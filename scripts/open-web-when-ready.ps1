# Waits for the web UI to bind :3080, then opens it in the default browser.
# Prefers the tokenised URL dsh prints on startup; a plain URL only authenticates
# when the browser still holds a valid session cookie.
param(
  [int]    $Port           = 3080,
  [string] $LogPath        = '',
  [int]    $TimeoutSeconds = 120
)

function Test-Listening {
  $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (-not (Test-Listening) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
}
if (-not (Test-Listening)) { exit 1 }

# The banner is written just before the listener opens, so give it a moment to land.
$url = "http://127.0.0.1:$Port/"
if ($LogPath -and (Test-Path $LogPath)) {
  $pattern = "http://127\.0\.0\.1:$Port/\S*"
  foreach ($attempt in 1..20) {
    $match = Select-String -Path $LogPath -Pattern $pattern -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($match) { $url = $match.Matches[0].Value; break }
    Start-Sleep -Milliseconds 500
  }
}

Start-Process $url
