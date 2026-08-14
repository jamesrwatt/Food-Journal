<#
    Adds a recipe straight to the database.

    Replaces the old way, where a recipe was written into SEED_RECIPES in index.html and
    published as a code change. That meant a deploy for every recipe, a page that grew
    with each one, and a device holding stale seeds that could overwrite good server data.
    The database has been the source of truth since sync landed.

    Writes two rows: the recipe itself, shared by everyone, and a per-profile row putting
    it on someone's To Make shelf. Devices pick it up on their next sync, within about
    thirty seconds. No deploy.

    Keep this file pure ASCII: Windows PowerShell reads .ps1 as ANSI without a BOM.

    Usage:
        .\add-recipe.ps1 -Path recipe.json
        .\add-recipe.ps1 -Path recipe.json -Profile lucy
        .\add-recipe.ps1 -Path recipe.json -WhatIf      # show what would be sent

    The JSON is one recipe object:
        {
          "title": "Ginger Lemon Cookies",
          "tags": ["Dessert"],
          "oven": "350 F", "bakeTime": "10 min", "prepTime": "20 min",
          "servings": "24", "source": "handwritten card (photo capture)",
          "ingredients": ["..."], "instructions": ["..."],
          "notes": "optional"
        }
    id is derived from the title unless given. Shelf, rating and photo are deliberately
    not settable here: shelf and rating belong to a person, and photos are added in the app.
#>
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$ProfileId = 'dad',
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$SupabaseUrl = 'https://uhicczuwqolnowonqwfq.supabase.co'
$PublishableKey = 'sb_publishable_SlLvi4eVDROg3pEfiI1xfg_aUhr6I0u'
$headers = @{ apikey = $PublishableKey; Authorization = "Bearer $PublishableKey" }

if (-not (Test-Path $Path)) { throw "No such file: $Path" }
$r = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json

if (-not $r.title) { throw "The recipe needs a title." }
if (-not $r.ingredients -or @($r.ingredients).Count -eq 0) { throw "The recipe needs ingredients." }
if (-not $r.instructions -or @($r.instructions).Count -eq 0) { throw "The recipe needs instructions." }

function Get-Slug($s) {
    ($s.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
}
$id = if ($r.id) { $r.id } else { Get-Slug $r.title }

# A repeated title would otherwise silently overwrite the earlier recipe.
$existing = (Invoke-WebRequest -Uri "$SupabaseUrl/rest/v1/recipes?id=eq.$id&select=id" -Headers $headers -UseBasicParsing).Content | ConvertFrom-Json
if (@($existing).Count -gt 0 -and -not $r.id) {
    $id = "$id-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    Write-Host "  a recipe with that name exists, using id: $id"
}

$data = [ordered]@{
    id           = $id
    title        = $r.title
    tags         = @($r.tags)
    ingredients  = @($r.ingredients)
    instructions = @($r.instructions)
    oven         = if ($r.oven) { $r.oven } else { '' }
    bakeTime     = if ($r.bakeTime) { $r.bakeTime } else { '' }
    prepTime     = if ($r.prepTime) { $r.prepTime } else { '' }
    servings     = if ($r.servings) { $r.servings } else { '' }
    dateAdded    = (Get-Date).ToString('yyyy-MM-dd')
    image        = $null
    imageStatus  = 'pending'
}
if ($r.source) { $data.source = $r.source }
if ($r.notes)  { $data.notes  = $r.notes }

$recipeRow = (@{ id = $id; data = $data } | ConvertTo-Json -Depth 20 -Compress)
$stateRow  = (@(@{ profile_id = $ProfileId; recipe_id = $id; shelf = 'To Make'; rating = $null; hidden = $false }) | ConvertTo-Json -Depth 10 -Compress)

Write-Host "Adding '$($r.title)' as $id"
Write-Host ("  {0} ingredients, {1} steps, tags: {2}" -f @($r.ingredients).Count, @($r.instructions).Count, ((@($r.tags)) -join ', '))
Write-Host "  to profile: $ProfileId (To Make shelf, no rating)"

if ($WhatIf) {
    Write-Host "-WhatIf: nothing sent. Row would be:"
    Write-Host $recipeRow
    return
}

Invoke-WebRequest -Uri "$SupabaseUrl/rest/v1/recipes?on_conflict=id" -Headers ($headers + @{ Prefer = 'resolution=merge-duplicates,return=minimal' }) `
    -Method POST -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes("[$recipeRow]")) -UseBasicParsing | Out-Null

Invoke-WebRequest -Uri "$SupabaseUrl/rest/v1/profile_recipes?on_conflict=profile_id,recipe_id" -Headers ($headers + @{ Prefer = 'resolution=merge-duplicates,return=minimal' }) `
    -Method POST -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($stateRow)) -UseBasicParsing | Out-Null

# Read it back rather than trusting the write.
$check = (Invoke-WebRequest -Uri "$SupabaseUrl/rest/v1/recipes?id=eq.$id&select=data" -Headers $headers -UseBasicParsing).Content | ConvertFrom-Json
if (@($check).Count -eq 0) { throw "The recipe did not land. Nothing was saved." }
$saved = $check[0].data
Write-Host ("Saved: {0} - {1} ingredients, {2} steps" -f $saved.title, @($saved.ingredients).Count, @($saved.instructions).Count)
Write-Host "It will appear on devices within about 30 seconds."
