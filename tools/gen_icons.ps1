$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# U+8BD1 = Chinese character for "translate"
$glyph = [string][char]0x8BD1

function New-Icon {
  param([int]$size, [string]$path)
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  # rounded square background (blue)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $d = [Math]::Max(4, [int]($size * 0.44))
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $gp.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $gp.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $gp.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $gp.CloseFigure()
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 59, 130, 246))
  $g.FillPath($brush, $gp)

  # white glyph centered
  $font = New-Object System.Drawing.Font('Microsoft YaHei UI', ($size * 0.6), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $layout = New-Object System.Drawing.RectangleF(0, (-$size * 0.02), $size, $size)
  $g.DrawString($glyph, $font, [System.Drawing.Brushes]::White, $layout, $sf)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host "created $path"
}

New-Icon 16 (Join-Path $dir 'icon16.png')
New-Icon 32 (Join-Path $dir 'icon32.png')
New-Icon 48 (Join-Path $dir 'icon48.png')
New-Icon 128 (Join-Path $dir 'icon128.png')
Write-Host 'ALL DONE'
