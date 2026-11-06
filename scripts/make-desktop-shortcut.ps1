$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'DeepSeek Harness Web.lnk'
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($linkPath)
$shortcut.TargetPath = 'C:\Users\Segapro\deepseek-harness\scripts\start-web.bat'
$shortcut.WorkingDirectory = 'C:\Users\Segapro\deepseek-harness'
$shortcut.WindowStyle = 1
$shortcut.Save()
Write-Output "Created: $linkPath"
