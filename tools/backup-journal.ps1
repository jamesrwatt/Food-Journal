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
# A recipe carries two pictures in two buckets: the AI plating strip, and the photo of
# what was actually cooked. Each is saved into its own folder and checked against the
# field that references it. The personal bucket may not exist yet, which is not a
# failure - there is simply nothing of that kind to save.
$Buckets = @(
    [ordered]@{ Name = 'recipe-photos';   Field = 'image';         Folder = 'photos' },
    [ordered]@{ Name = 'personal-photos'; Field = 'personalImage'; Folder = 'photos-personal' }
)
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
$map = @{}
$totalOk = 0
$totalObjects = 0
$failed = @()

foreach ($b in $Buckets) {
    $bucketName = $b.Name
    $field      = $b.Field
    $destDir    = Join-Path $out $b.Folder

    $listUri = "$SupabaseUrl/storage/v1/object/list/$bucketName"
    try {
        $listResp = Invoke-WebRequest -Uri $listUri -Headers $headers -Method POST -ContentType 'application/json' -Body '{"prefix":"","limit":1000}' -UseBasicParsing -TimeoutSec 60
    } catch {
        # A bucket that has not been created yet is not a failure. One that exists and
        # will not answer is, so only a 404 is forgiven.
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
            Write-Host ("  {0}: no such bucket, skipped" -f $bucketName)
            continue
        }
        throw
    }
    $listed = $listResp.Content | ConvertFrom-Json
    $objects = @($listed | Where-Object { $_.name -and -not $_.name.StartsWith('.') })
    Write-Host ("  {0}: {1} entries listed, {2} are photos" -f $bucketName, $listed.Count, $objects.Count)

    # A backup that quietly saves no photos is worse than one that fails, because it
    # looks like it worked. If the table references photos in this bucket, the bucket
    # must not come back empty.
    $referenced = @($rows | Where-Object { $_.data.$field -and "$($_.data.$field)".Contains('/storage/v1/object/public/') })
    if ($referenced.Count -gt 0 -and $objects.Count -eq 0) {
        throw "$($referenced.Count) recipes reference photos in $bucketName but its listing was empty. Refusing to write a backup with no photos."
    }

    if ($objects.Count -gt 0) { New-Item -ItemType Directory -Force $destDir | Out-Null }
    $ok = 0
    foreach ($o in $objects) {
        $url = "$SupabaseUrl/storage/v1/object/public/$bucketName/" + [Uri]::EscapeDataString($o.name)
        $dest = Join-Path $destDir $o.name
        try {
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 120
            $ok++
        } catch {
            $failed += "$bucketName/$($o.name)"
        }
    }
    Write-Host ("  photos : {0} of {1} downloaded from {2}" -f $ok, $objects.Count, $bucketName)
    $totalOk += $ok
    $totalObjects += $objects.Count

    # Records which photo belongs to which recipe, so a restore can rebuild the links
    # even though the rows store absolute URLs that would change on a new project.
    foreach ($r in $rows) {
        $img = $r.data.$field
        if ($img -and ("$img").Contains('/storage/v1/object/public/')) {
            if (-not $map.ContainsKey($r.id)) { $map[$r.id] = [ordered]@{} }
            $map[$r.id][$field] = [ordered]@{
                bucket = $bucketName
                file   = [Uri]::UnescapeDataString(("$img" -split '/')[-1])
            }
        }
    }
}
if ($failed.Count) { Write-Host ("  FAILED : {0}" -f ($failed -join ', ')) -ForegroundColor Red }
$ok = $totalOk
$objects = @(1..$totalObjects)

# ---- Manifest ----------------------------------------------------------------
$manifest = [ordered]@{
    takenAt        = (Get-Date).ToString('o')
    supabaseUrl    = $SupabaseUrl
    buckets        = @($Buckets | ForEach-Object { $_.Name })
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

  recipes.json     every row exactly as stored, tombstones included
  recipes.txt      the same recipes in plain text, readable without any tooling
  photos\          every object in the recipe-photos bucket (AI plating strips)
  photos-personal\ every object in the personal-photos bucket (photos of the
                   finished dish). Absent if that bucket does not exist yet.
  manifest.json    counts, and which photo file belongs to which recipe id

To restore into a Supabase project:

  1. Upload photos\ to recipe-photos, and photos-personal\ to personal-photos.
  2. For each entry in recipes.json, upsert { id, data } into the recipes table.
     If the project ref changed, rewrite data.image and data.personalImage to
     point at the new project's public URLs. manifest.json maps each recipe id
     to the bucket and filename behind each of its two pictures.
  3. Recipes whose data.deleted is true are tombstones. Keep them. Dropping them
     lets any device still holding that recipe push it back.

Verify a backup by opening recipes.txt and spot-checking both photo folders. If those two
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
