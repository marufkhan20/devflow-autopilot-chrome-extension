Add-Type -AssemblyName System.Drawing

$src     = "C:\Users\suhai\.gemini\antigravity\brain\7449d650-78ba-4fe0-a1a8-e456537b54b7\devflow_icon_1773060342351.png"
$destDir = "d:\maruf\devflow-autopilot\icons"

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

foreach ($size in @(16, 32, 48, 128)) {
    $img = [System.Drawing.Image]::FromFile($src)
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save("$destDir\icon$size.png")
    $bmp.Dispose()
    $img.Dispose()
    Write-Host "Saved icon$size.png"
}

Write-Host "Done."
