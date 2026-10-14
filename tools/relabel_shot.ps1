<#
把中文客户端的游戏截图改成"英文客户端"的样子，给英文 README / 主页用。

    pwsh tools/relabel_shot.ps1 -In devdata/shots/中文.png -Out devdata/shots/中文-en.png -Hero "OUTWORLD DESTROYER"

截图上带客户端文字的有五处，这里换掉四处：
  1. 左上角  击/死/助、正/反   → K / D / A、LH / DN（后面的数字跟着左移到英文版的位置）
  2. 右上角  输入/输出丢失     → LOSS IN/OUT
  3. 底部    英雄名            → -Hero 给的英文名（大写，和英文客户端一样，比如 "MONKEY KING"）
  4. 右下角  快速购买提示      → Drag or shift-click items to add to Quickbuy.（快速购买栏空着时才有）
第五处（右下角金钱上方的买活框）截图时避开：**别按 Alt**，它只在按住 Alt 时出现。

做法：先把中文字抹掉、用周围背景补上，再把英文原版文字相对背景的"笔画增量"叠上去——
背景还是这张图自己的，不会出现一块颜色不同的补丁。1、2、4 的英文原版取自 tools/relabel_ref/ 里
从英文客户端实战截图裁下的三小块；英雄名英文截图里不一定有同一个英雄，只能用字体写，
字体对着原版 "MONKEY KING" 校准过（Segoe UI 加粗 19px、字距 3.2）。

**坐标都是按 2560×1600 量的**（用户的屏幕）。别的分辨率直接报错，不要硬套——
要支持就按屏高等比换算重新量，见 docs/design/dev-tools.md「README 截图改英文」。

写这个脚本踩过的坑（PowerShell 特有，改的时候小心）：
  - **变量名不分大小写**：参数叫 $Out、内部又写 $out 会互相覆盖。第一版就这样把输入截图覆盖掉了
  - **别用 Erase / Clear 之类当函数名**：Erase 是 Remove-Item 的别名
  - 新版 PowerShell（.NET 6+）里 Add-Type 要显式引用 System.Drawing.Common / Primitives
#>
param(
  [Parameter(Mandatory)][string]$In,
  [Parameter(Mandatory)][string]$Out,
  [Parameter(Mandatory)][string]$Hero
)
$ErrorActionPreference = 'Stop'
$inFull = [System.IO.Path]::GetFullPath($In); $outFull = [System.IO.Path]::GetFullPath($Out)
if ($inFull -eq $outFull) { throw "输出不能覆盖输入：$Out" }
$refDir = Join-Path $PSScriptRoot "relabel_ref"

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing.Common, System.Drawing.Primitives, System.Runtime.InteropServices, System.Collections -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging;
public static class Relabel {
  public static int[] Read(Bitmap b) {
    var d = b.LockBits(new Rectangle(0,0,b.Width,b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var a = new int[b.Width*b.Height]; System.Runtime.InteropServices.Marshal.Copy(d.Scan0, a, 0, a.Length); b.UnlockBits(d); return a; }
  public static void Write(Bitmap b, int[] a) {
    var d = b.LockBits(new Rectangle(0,0,b.Width,b.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    System.Runtime.InteropServices.Marshal.Copy(a, 0, d.Scan0, a.Length); b.UnlockBits(d); }
  static int R(int c){return (c>>16)&255;} static int G(int c){return (c>>8)&255;} static int B(int c){return c&255;}
  static int Lum(int c){return (R(c)*30+G(c)*59+B(c)*11)/100;}
  static int Clamp(int v){return v<0?0:v>255?255:v;}
  static int Pack(int r,int g,int b){return unchecked((int)0xFF000000)|(Clamp(r)<<16)|(Clamp(g)<<8)|Clamp(b);}
  static bool Gold(int c){return R(c)>150 && R(c)-B(c)>45;}

  /// 抹掉 [x0,x1)×[y0,y1) 里的文字：比这块的亮度中位数亮 45 以上（字）、暗 30 以上（字的阴影）或偏金黄（英雄名）
  /// 的像素算文字，往外扩三圈盖住抗锯齿和阴影，再一圈一圈用外面已知像素的平均值往里补。
  /// 阴影门槛原先是 45、扩两圈，数字的阴影会漏掉一点，补完在数字后面留个黑点（斧王那张）。
  public static void EraseText(int[] a,int W,int x0,int y0,int x1,int y1,bool gold){
    int w=x1-x0,h=y1-y0; var lums=new int[w*h]; int k=0;
    for(int y=y0;y<y1;y++)for(int x=x0;x<x1;x++)lums[k++]=Lum(a[y*W+x]);
    var s=(int[])lums.Clone(); Array.Sort(s); int med=s[s.Length/2];
    var m=new bool[w*h];
    for(int y=0;y<h;y++)for(int x=0;x<w;x++){int c=a[(y+y0)*W+x+x0];
      m[y*w+x]=Lum(c)>med+45 || Lum(c)<med-30 || (gold && Gold(c));}
    for(int i=0;i<3;i++){var n=(bool[])m.Clone();
      for(int y=0;y<h;y++)for(int x=0;x<w;x++)if(m[y*w+x])for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){
        int yy=y+dy,xx=x+dx; if(yy>=0&&yy<h&&xx>=0&&xx<w)n[yy*w+xx]=true;} m=n;}
    var buf=new int[w*h]; var set=new bool[w*h];
    for(int pass=0;pass<500;pass++){ bool left=false, changed=false; Array.Clear(set,0,set.Length);
      for(int y=0;y<h;y++)for(int x=0;x<w;x++){if(!m[y*w+x])continue; left=true; int r=0,g=0,b=0,n=0;
        for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){int yy=y+dy,xx=x+dx;
          bool inside=yy>=0&&yy<h&&xx>=0&&xx<w; if(inside&&m[yy*w+xx])continue;
          int c=a[(yy+y0)*W+xx+x0]; r+=R(c);g+=G(c);b+=B(c);n++;}
        if(n>=3){buf[y*w+x]=Pack(r/n,g/n,b/n); set[y*w+x]=true;}}
      for(int i=0;i<w*h;i++)if(set[i]){a[(i/w+y0)*W+i%w+x0]=buf[i]; m[i]=false; changed=true;}
      if(!left||!changed)break;}
  }

  /// dst 的 (dx0+x, dy0+y) += src(sx0+x, sy0+y) − srcBg(同位置)：只搬"文字相对背景的增量"，背景用 dst 自己的
  public static void AddText(int[] dst,int DW,int dx0,int dy0,int w,int h,int[] src,int[] srcBg,int SW,int sx0,int sy0){
    for(int y=0;y<h;y++)for(int x=0;x<w;x++){int i=(dy0+y)*DW+dx0+x, j=(sy0+y)*SW+sx0+x;
      int c=dst[i],p=src[j],q=srcBg[j]; dst[i]=Pack(R(c)+R(p)-R(q),G(c)+G(p)-G(q),B(c)+B(p)-B(q));}
  }
  /// 整个矩形都当成要补的，从四周往里补。英雄名用这个：中文名的阴影边缘颜色和背景接近，按笔画识别会漏，
  /// 短英文名（比如 AXE）盖不住原来的位置，漏掉的阴影就露成一块污迹
  public static void FillRect(int[] a,int W,int x0,int y0,int x1,int y1){
    int w=x1-x0,h=y1-y0; var m=new bool[w*h]; for(int i=0;i<m.Length;i++)m[i]=true;
    var buf=new int[w*h]; var set=new bool[w*h];
    for(int pass=0;pass<500;pass++){ bool left=false, changed=false; Array.Clear(set,0,set.Length);
      for(int y=0;y<h;y++)for(int x=0;x<w;x++){if(!m[y*w+x])continue; left=true; int r=0,g=0,b=0,n=0;
        for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){int yy=y+dy,xx=x+dx;
          bool inside=yy>=0&&yy<h&&xx>=0&&xx<w; if(inside&&m[yy*w+xx])continue;
          int c=a[(yy+y0)*W+xx+x0]; r+=R(c);g+=G(c);b+=B(c);n++;}
        if(n>=3){buf[y*w+x]=Pack(r/n,g/n,b/n); set[y*w+x]=true;}}
      for(int i=0;i<w*h;i++)if(set[i]){a[(i/w+y0)*W+i%w+x0]=buf[i]; m[i]=false; changed=true;}
      if(!left||!changed)break;}
  }
  public static void CopyRect(int[] dst,int[] src,int W,int x0,int y0,int x1,int y1){
    for(int y=y0;y<y1;y++)Array.Copy(src,y*W+x0,dst,y*W+x0,x1-x0); }

  /// 底部英雄名那一行里，含金黄 / 橙色像素的列，按间隔切成几段：[start,end] 交替。
  /// 第一段是名字左边的橙色徽章，后面挨着的几段是名字本身。
  public static int[] GoldRuns(int[] a,int W,int x0,int x1,int y0,int y1){
    var runs=new System.Collections.Generic.List<int>(); int start=-1,last=-100;
    for(int x=x0;x<x1;x++){int n=0; for(int y=y0;y<y1;y++)if(Gold(a[y*W+x]))n++;
      if(n>=2){ if(start<0){start=x;} else if(x-last>6){runs.Add(start);runs.Add(last);start=x;} last=x; }}
    if(start>=0){runs.Add(start);runs.Add(last);}
    return runs.ToArray(); }
}
"@

$img = [System.Drawing.Bitmap]::FromFile($inFull); $bmp = New-Object System.Drawing.Bitmap $img; $img.Dispose()
$W = $bmp.Width; $H = $bmp.Height
if (-not (($W -eq 2560 -or $W -eq 2559) -and ($H -eq 1600 -or $H -eq 1599))) {
  throw "坐标是按 2560×1600 量的，这张是 ${W}×${H}。见 docs/design/dev-tools.md「README 截图改英文」"
}
function Load-Pixels($path) {
  $i = [System.Drawing.Bitmap]::FromFile($path); $b = New-Object System.Drawing.Bitmap $i; $i.Dispose()
  @{ px = [Relabel]::Read($b); w = $b.Width; h = $b.Height }
}

$src = [Relabel]::Read($bmp)
$bg = $src.Clone()
[Relabel]::EraseText($bg, $W, 6, 94, 240, 154, $false)       # 只到 x=240：再往右是净资产的金币图标
[Relabel]::EraseText($bg, $W, 2296, 29, 2466, 57, $false)
[Relabel]::EraseText($bg, $W, 2134, 1456, 2434, 1499, $false)  # 快速购买提示；右边 2438 起是锁形图标，不碰。抹到 2434 才盖住「入」字最后一笔的淡尾巴
$res = $src.Clone()
[Relabel]::CopyRect($res, $bg, $W, 6, 94, 240, 154)
[Relabel]::CopyRect($res, $bg, $W, 2296, 29, 2466, 57)
[Relabel]::CopyRect($res, $bg, $W, 2134, 1456, 2434, 1499)

# 1) 左上角。英文参照图左上角对应截图的 (0,90)。英文标签止于 x≈97、数字从 120 起；中文标签止于 118、数字从 143 起
$kda = Load-Pixels (Join-Path $refDir "en_kda.png")
$kdaBg = $kda.px.Clone(); [Relabel]::EraseText($kdaBg, $kda.w, 6, 4, 240, 64, $false)
[Relabel]::AddText($res, $W, 6, 94, 106, 60, $kda.px, $kdaBg, $kda.w, 6, 4)
[Relabel]::AddText($res, $W, 116, 94, 101, 60, $src, $bg, $W, 139, 94)     # 这张图自己的数字，左移 23

# 2) 右上角第二行标签（两列数字不动）。英文参照图左上角对应截图的 (2290,25)
$net = Load-Pixels (Join-Path $refDir "en_netgraph.png")
$netBg = $net.px.Clone(); [Relabel]::EraseText($netBg, $net.w, 6, 4, 176, 32, $false)
[Relabel]::AddText($res, $W, 2296, 29, 170, 28, $net.px, $netBg, $net.w, 6, 4)

# 4) 右下角快速购买提示。英文参照图左上角对应截图的 (2130,1452)。参照截图是按着 Alt 截的，
#    提示框下面贴着 BUYBACK 框，只取到 y=1495（参照图里的 43），免得把它的边带进来；"Quickbuy." 的下沿会少一截。
#    以后有不按 Alt 的英文截图，重裁 en_quickbuy.png（截图的 (2130,1452) 起 300×48）就能补上
$qb = Load-Pixels (Join-Path $refDir "en_quickbuy.png")
$qbBg = $qb.px.Clone(); [Relabel]::EraseText($qbBg, $qb.w, 4, 4, 298, 43, $false)
[Relabel]::AddText($res, $W, 2136, 1458, 280, 37, $qb.px, $qbBg, $qb.w, 6, 6)   # 英文止于 x≈2412；再宽会把右边的东西也叠过来

# 3) 英雄名：自动找徽章和中文名的位置。不同英雄底部面板宽度不同（技能个数不一样），名字位置跟着变
$runs = [Relabel]::GoldRuns($res, $W, 560, 1150, 1355, 1383)
if ($runs.Count -lt 4) { throw "没找到英雄名（底部 y 1355~1383 这一行里金色的徽章和名字）。截图里英雄面板被挡住了？" }
$emblemEnd = $runs[1]
$nameStart = $runs[2]; $nameEnd = $runs[3]
for ($r = 4; $r -lt $runs.Count; $r += 2) { if ($runs[$r] - $nameEnd -gt 30) { break }; $nameEnd = $runs[$r + 1] }
if ($emblemEnd - $runs[0] -lt 25 -or $emblemEnd - $runs[0] -gt 90) { throw "徽章宽度不对（$($runs[0])~$emblemEnd），自动定位失败" }
[Relabel]::FillRect($res, $W, $nameStart - 5, 1356, $nameEnd + 6, 1383)
[Relabel]::Write($bmp, $res)

$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = 'AntiAliasGridFit'; $g.SmoothingMode = 'AntiAlias'
$font = New-Object System.Drawing.Font "Segoe UI", 19, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$goldBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 232, 184, 112))
$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 8, 6, 4))
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$penX = $emblemEnd + 15; $penY = 1355                    # 原版文字离徽章右缘约 13~15px
foreach ($ch in $Hero.ToUpperInvariant().ToCharArray()) {
  $glyph = [string]$ch
  if ($glyph -eq ' ') { $penX += 9; continue }
  $g.DrawString($glyph, $font, $shadowBrush, $penX + 1.5, $penY + 2, $fmt)
  $g.DrawString($glyph, $font, $goldBrush, $penX, $penY, $fmt)
  $penX += $g.MeasureString($glyph, $font, 100, $fmt).Width + 3.2
}
$g.Dispose()
$bmp.Save($outFull, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
"已生成 $Out（徽章 $($runs[0])~$emblemEnd，中文名 $nameStart~$nameEnd，英文名写到 x=$([int]$penX)）"
