$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSCommandPath
$searchRoot = Split-Path -Parent $root
$candidates = @(where.exe /r $searchRoot *.mp4 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$src = $candidates | Where-Object { $_ -like '*完了*.mp4' } | Select-Object -First 1
if (-not $src) {
  $src = $candidates | Select-Object -First 1
}

if (-not $src) {
  throw "mp4が見つかりません: $searchRoot （キャラクター動画生成の完了.mp4 を同フォルダ階層に置いてください）"
}

$dstDir = Join-Path $root 'public\videos'
New-Item -ItemType Directory -Force -Path $dstDir | Out-Null

$dstTalk = Join-Path $dstDir 'sora-talk.mp4'
$dstExplain = Join-Path $dstDir 'sora-explain.mp4'
Copy-Item -LiteralPath $src -Destination $dstTalk -Force
Copy-Item -LiteralPath $src -Destination $dstExplain -Force

Get-Item -LiteralPath $dstExplain | Select-Object FullName, Length

