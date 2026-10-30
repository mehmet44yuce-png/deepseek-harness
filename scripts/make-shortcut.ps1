$startup = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startup 'DeepSeekHarnessWeb.lnk'
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($linkPath)
$shortcut.TargetPath = 'C:\Users\Segapro\deepseek-harness\scripts\start-web.bat'
$shortcut.WorkingDirectory = 'C:\Users\Segapro\deepseek-harness'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output "Created: $linkPath"
