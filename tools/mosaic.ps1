<#
给截图里的几块区域打马赛克：别的玩家昵称、聊天、物品打造通知这类 README / 主页上不该出现的东西。

    pwsh tools/mosaic.ps1 -In 截图.png -Out 截图-码.png -Rects "1997,712,2560,821" "664,1084,1250,1122"

-Rects 每一项是 "x0,y0,x1,y1"（原图像素，左上角到右下角）。-Block 是马赛克格子边长，默认 14。
要和 relabel_shot.ps1 一起用时，**先改英文再打码**：打码会把那块的文字毁掉，反过来做的话改字找不到原来的字。

PowerShell 变量名不分大小写——参数和内部变量要起不同的名字（见 relabel_shot.ps1 开头记的坑）。
#>
param(
  [Parameter(Mandatory)][string]$In,
  [Parameter(Mandatory)][string]$Out,
  [Parameter(Mandatory)][string[]]$Rects,
  [int]$Block = 14
)
$ErrorActionPreference = 'Stop'
$srcPath = [System.IO.Path]::GetFullPath($In); $dstPath = [System.IO.Path]::GetFullPath($Out)
if ($srcPath -eq $dstPath) { throw "输出不能覆盖输入：$Out" }
Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Bitmap]::FromFile($srcPath); $bmp = New-Object System.Drawing.Bitmap $img; $img.Dispose()
$g = [System.Drawing.Graphics]::FromImage($bmp)
foreach ($spec in $Rects) {
  $p = $spec.Split(',') | ForEach-Object { [int]$_.Trim() }
  if ($p.Count -ne 4) { throw "矩形要写成 x0,y0,x1,y1：$spec" }
  $rx = $p[0]; $ry = $p[1]; $rw = $p[2] - $p[0]; $rh = $p[3] - $p[1]
  if ($rw -le 0 -or $rh -le 0) { throw "矩形大小不对：$spec" }
  # 先缩到每格一个像素（取平均色），再用最近邻放回原大小 = 马赛克
  $sw = [Math]::Max(1, [int][Math]::Ceiling($rw / $Block)); $sh = [Math]::Max(1, [int][Math]::Ceiling($rh / $Block))
  $small = New-Object System.Drawing.Bitmap $sw, $sh
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = 'HighQualityBilinear'; $sg.PixelOffsetMode = 'HighQuality'
  $sg.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $sw, $sh), (New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh), 'Pixel')
  $sg.Dispose()
  $g.InterpolationMode = 'NearestNeighbor'; $g.PixelOffsetMode = 'Half'
  $g.DrawImage($small, (New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh), (New-Object System.Drawing.Rectangle 0, 0, $sw, $sh), 'Pixel')
  $small.Dispose()
}
$g.Dispose()
$bmp.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
"已生成 $Out（打码 $($Rects.Count) 块）"
