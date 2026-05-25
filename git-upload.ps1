$ErrorActionPreference = "Stop"

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $repoDir

function Run-Git {
  param(
    [Parameter(Mandatory = $true)][string[]]$Args,
    [Parameter(Mandatory = $true)][string]$Label
  )

  & git @Args
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed."
  }
}

Run-Git -Args @("rev-parse", "--is-inside-work-tree") -Label "Git repository check" | Out-Null

$branch = (& git branch --show-current).Trim()
if (-not $branch) {
  throw "No current branch found. Please checkout a branch first."
}

$status = & git status --short
if (-not $status) {
  Write-Host "No changes to commit."
  exit 0
}

Write-Host "Repository: $repoDir"
Write-Host "Branch: $branch"
Write-Host ""
Write-Host "Changes to upload:"
$status | ForEach-Object { Write-Host $_ }
Write-Host ""

$message = Read-Host "Enter commit message"
$message = $message.Trim()
if (-not $message) {
  Write-Host "Commit message is empty. Nothing was uploaded."
  exit 1
}

Write-Host ""
Write-Host "Staging all changes..."
Run-Git -Args @("add", "-A") -Label "Git add"

$staged = & git diff --cached --name-only
if (-not $staged) {
  Write-Host "No staged changes after git add."
  exit 0
}

Write-Host "Creating commit..."
Run-Git -Args @("commit", "-m", $message) -Label "Git commit"

& git rev-parse --abbrev-ref --symbolic-full-name "@{u}" *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Pushing to upstream..."
  Run-Git -Args @("push") -Label "Git push"
} else {
  Write-Host "No upstream branch found. Pushing and setting upstream to origin/$branch..."
  Run-Git -Args @("push", "-u", "origin", $branch) -Label "Git push"
}

Write-Host ""
Write-Host "Done."
