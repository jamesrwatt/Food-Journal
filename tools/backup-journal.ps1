<#
    Food Journal backup.

    Dumps every recipe row and downloads every photo to a timestamped folder, so the
    journal survives a mistake in Supabase, an accidental sweep, or a schema migration.
    The photos are the part that matters: a recipe can be re-imported from its source,
    but a picture of a meal you cooked cannot be retaken.

    Backups are written OUTSIDE the git repo (default: a backups folder beside it),
    because photos have no business in version control.

    Only the publishable key is used, which is already public in the app. No secret
    key is needed or wanted here.

    NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as ANSI unless
    it has a UTF-8 BOM, so smart quotes and dashes become mojibake and can break parsing.

    Usage:
        .\backup-journal.ps1
        .\backup-journal.ps1 -OutRoot D:\somewhere
#>
param(
    [string]$OutRoot = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'backups'),
    # Roughly two months of weekly runs. Unbounded growth is fine by hand and not fine on
    # a schedule, and old copies of a journal that changes slowly are worth little.
    [int]$Keep = 8
)

$ErrorActionPreference = 'Stop'

$SupabaseUrl = 'https://uhicczuwqolnowonqwfq.supabase.co'
$PublishableKey = 'sb_publishable_SlLvi4eVDROg3pEfiI1xfg_aUhr6I0u'
$Bucket = 'recipe-photos'

$headers = @{ apikey = $PublishableKey; Authorization = "Bearer $PublishableKey" }
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$out = Join-Path $OutRoot $stamp
$photoDir = Join-Path $out 'photos'
New-Item -ItemType Directory -Force $photoDir | Out-Null

Write-Host "Backing up to $out"

# ---- Recipes -----------------------------------------------------------------
$resp = Invoke-WebRequest -Uri "$SupabaseUrl/rest/v1/recipes?select=id,data,updated_at" -Headers $headers -UseBasicParsing -TimeoutSec 60
$raw = $resp.Content
[IO.File]::WriteAllText((Join-Path $out 'recipes.json'), $raw, [Text.Encoding]::UTF8)

# Assign the parsed array to a variable before filtering. ConvertFrom-Json emits the
# whole array as ONE pipeline item, so piping it straight into Where-Object tests the
# array itself rather than its elements - which silently matches nothing.
$rows = $raw | ConvertFrom-Json
$live = @($rows | Where-Object { -not $_.data.deleted })
$dead = @($rows | Where-Object { $_.data.deleted })
Write-Host ("  recipes: {0} live, {1} deleted (tombstones kept)" -f $live.Count, $dead.Count)

# A plain-text copy too, so the recipes stay readable without any of this tooling.
$txt = New-Object Text.StringBuilder
foreach ($r in ($live | Sort-Object { $_.data.title })) {
    $d = $r.data
    $rating = '-'
    if ($null -ne $d.rating) { $rating = "$($d.rating)/10" }
    [void]$txt.AppendLine(("=" * 70))
    [void]$txt.AppendLine($d.title)
    [void]$txt.AppendLine(("=" * 70))
    [void]$txt.AppendLine("Shelf: $($d.shelf)   Rating: $rating")
    if ($d.oven)     { [void]$txt.AppendLine("Oven: $($d.oven)") }
    if ($d.bakeTime) { [void]$txt.AppendLine("Bake: $($d.bakeTime)") }
    if ($d.prepTime) { [void]$txt.AppendLine("Prep: $($d.prepTime)") }
    if ($d.servings) { [void]$txt.AppendLine("Serves: $($d.servings)") }
    if ($d.source)   { [void]$txt.AppendLine("Source: $($d.source)") }
    [void]$txt.AppendLine("")
    [void]$txt.AppendLine("INGREDIENTS")
    foreach ($i in $d.ingredients) { [void]$txt.AppendLine("  - $i") }
    [void]$txt.AppendLine("")
    [void]$txt.AppendLine("INSTRUCTIONS")
    $n = 1
    foreach ($s in $d.instructions) { [void]$txt.AppendLine("  $n. $s"); $n++ }
    [void]$txt.AppendLine("")
}
[IO.File]::WriteAllText((Join-Path $out 'recipes.txt'), $txt.ToString(), [Text.Encoding]::UTF8)

# ---- Photos ------------------------------------------------------------------
$listUri = "$SupabaseUrl/storage/v1/object/list/$Bucket"
$listResp = Invoke-WebRequest -Uri $listUri -Headers $headers -Method POST -ContentType 'application/json' -Body '{"prefix":"","limit":1000}' -UseBasicParsing -TimeoutSec 60
$listed = $listResp.Content | ConvertFrom-Json
$objects = @($listed | Where-Object { $_.name -and -not $_.name.StartsWith('.') })
Write-Host ("  bucket : {0} entries listed, {1} are photos" -f $listed.Count, $objects.Count)

# A backup that quietly saves no photos is worse than one that fails, because it looks
# like it worked. If the table references photos, the bucket must not come back empty.
$referenced = @($rows | Where-Object { $_.data.image -and "$($_.data.image)".Contains('/storage/v1/object/public/') })
if ($referenced.Count -gt 0 -and $objects.Count -eq 0) {
    throw "$($referenced.Count) recipes reference photos but the bucket listing was empty. Refusing to write a backup with no photos."
}

$ok = 0
$failed = @()
foreach ($o in $objects) {
    $url = "$SupabaseUrl/storage/v1/object/public/$Bucket/" + [Uri]::EscapeDataString($o.name)
    $dest = Join-Path $photoDir $o.name
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 120
        $ok++
    } catch {
        $failed += $o.name
    }
}
Write-Host ("  photos : {0} of {1} downloaded" -f $ok, $objects.Count)
if ($failed.Count) { Write-Host ("  FAILED : {0}" -f ($failed -join ', ')) -ForegroundColor Red }

# ---- Manifest ----------------------------------------------------------------
# Records which photo belongs to which recipe, so a restore can rebuild the links even
# though the rows store absolute URLs that would change on a new project.
$map = @{}
foreach ($r in $rows) {
    $img = $r.data.image
    if ($img -and ("$img").Contains('/storage/v1/object/public/')) {
        $map[$r.id] = [Uri]::UnescapeDataString(("$img" -split '/')[-1])
    }
}
$manifest = [ordered]@{
    takenAt        = (Get-Date).ToString('o')
    supabaseUrl    = $SupabaseUrl
    bucket         = $Bucket
    recipesTotal   = $rows.Count
    recipesLive    = $live.Count
    recipesDeleted = $dead.Count
    photosExpected = $objects.Count
    photosSaved    = $ok
    photosFailed   = $failed
    recipePhotoMap = $map
}
[IO.File]::WriteAllText((Join-Path $out 'manifest.json'), ($manifest | ConvertTo-Json -Depth 10), [Text.Encoding]::UTF8)

$readme = @"
Food Journal backup - $stamp

  recipes.json   every row exactly as stored, tombstones included
  recipes.txt    the same recipes in plain text, readable without any tooling
  photos\        every object in the $Bucket bucket
  manifest.json  counts, and which photo file belongs to which recipe id

To restore into a Supabase project:

  1. Upload the files in photos\ to the $Bucket bucket.
  2. For each entry in recipes.json, upsert { id, data } into the recipes table.
     If the project ref changed, rewrite each data.image to point at the new
     project's public URL. manifest.json maps recipe id to photo filename.
  3. Recipes whose data.deleted is true are tombstones. Keep them. Dropping them
     lets any device still holding that recipe push it back.

Verify a backup by opening recipes.txt and spot-checking photos\. If those two
look right, the journal can be rebuilt.
"@
[IO.File]::WriteAllText((Join-Path $out 'README.txt'), $readme, [Text.Encoding]::UTF8)

# ---- Retention ---------------------------------------------------------------
# Only prunes after this run has written its files, so a failure part way through can
# never take the older copies with it.
if ($Keep -gt 0) {
    $all = @(Get-ChildItem $OutRoot -Directory | Sort-Object Name -Descending)
    $old = @($all | Select-Object -Skip $Keep)
    foreach ($d in $old) {
        Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($old.Count) { Write-Host ("  pruned : {0} old backup(s), keeping {1}" -f $old.Count, $Keep) }
}

Write-Host "Done: $out"
