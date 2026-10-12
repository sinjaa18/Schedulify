$ErrorActionPreference = 'Stop'
$readmePath = Join-Path (Get-Location) 'README.md'
if (-not (Test-Path $readmePath)) { throw 'Run this script from the root of your Schedulify repository (README.md was not found).' }
$content = [System.IO.File]::ReadAllText($readmePath)
$content = $content -replace "`r`n", "`n"
$changes = 0
function Replace-Exact([string]$old, [string]$new, [string]$label) {
  if (-not $script:content.Contains($old)) { throw "Could not find the expected README section: $label. No file was changed." }
  $script:content = $script:content.Replace($old, $new)
  $script:changes++
}
Replace-Exact @'
# Schedulify

Schedulify addresses
'@ @'
# Schedulify

**Live demo:** [schedulify-portfolio-demo.onrender.com](https://schedulify-portfolio-demo.onrender.com) · **Source:** [GitHub](https://github.com/sinjaa18/Schedulify)

> Portfolio demo only. It uses fictional demonstration data, may sleep on the free hosting tier, and must not be used for real student information or critical timetabling.

Schedulify addresses
'@ 'project intro'
Replace-Exact @'
GitHub Actions in `.github/workflows/ci.yml` runs unit tests, lint, PostgreSQL 18 integration tests, a full dependency audit, Chromium E2E, and the build. It preserves browser traces on failure. CI has read-only repository permissions and uses disposable test credentials. The hosted run for pre-fix commit `93edbc3e80b6706485179d97c7c25bcd807bf213` failed in E2E because Tailwind's PostCSS dependency was missing. The dependency/configuration correction described in this repository passed local verification; a hosted run for the corrected snapshot is still required. CI does not deploy production.
'@ @'
GitHub Actions in `.github/workflows/ci.yml` runs unit tests, lint, PostgreSQL 18 integration tests, a full dependency audit, Chromium E2E, and the build. It preserves browser traces on failure. CI has read-only repository permissions and uses disposable test credentials. The hosted run for pre-fix commit `93edbc3e80b6706485179d97c7c25bcd807bf213` failed in E2E because Tailwind's PostCSS dependency was missing. The corrected deployment-ready commit passed the hosted workflow: [CI run 38218428908](https://github.com/sinjaa18/Schedulify/actions/runs/38218428908). CI verifies code; it does not deploy production.
'@ 'CI status'
Replace-Exact @'
On the deployment host, copy `.env.production.example` to the ignored `.env.production` file and set real host values. Build the services and apply migrations before switching traffic:
'@ @'
For the self-managed Docker/Nginx route, copy `.env.production.example` to the ignored `.env.production` file and set real host values. Build the services and apply migrations before switching traffic:
'@ 'self-managed deployment instructions'
Replace-Exact @'
Set `PUBLIC_APP_ORIGIN` to the exact HTTPS browser origin, `COOKIE_SECURE=true`, and `DATABASE_SSL=true` when required by the managed database. Use an API-only least-privilege role; never use a database owner credential for the application. Run migrations as a controlled release step after a backup, not automatically on each API startup. Check readiness and complete an Admin login after deployment. This configuration has been prepared locally; no image or live service has been deployed or verified.
'@ @'
Set `PUBLIC_APP_ORIGIN` to the exact HTTPS browser origin, `COOKIE_SECURE=true`, and `DATABASE_SSL=true` when required by the managed database. Use an API-only least-privilege role; never use a database owner credential for the application. Run migrations as a controlled release step after a backup, not automatically on each API startup. Check readiness and complete an Admin login after deployment. The portfolio deployment is live at [https://schedulify-portfolio-demo.onrender.com](https://schedulify-portfolio-demo.onrender.com), managed by Render and backed by Neon PostgreSQL. Render reports it Live on deployment commit `86e35bd0aa3709a395af6678fadcd006fafcde00`. Database verification confirms a current-revision candidate with 16 assignments and no validation violations, plus an HOD-approved timetable. Managed backup/recovery and production-scale reliability have not been verified.
'@ 'deployment status'
Replace-Exact @'
The browser journey configures batches, subjects, teachers, rooms, requirements, and eligibility in the Admin UI; confirms a supported Copilot rule through a deterministic provider fixture; handles missing and malformed provider responses; generates and validates; rejects a stale candidate; exercises HOD rejection and publication; and checks scoped Teacher/Student views even with forged query parameters. Additional browser cases verify revoked sessions cannot read protected data, API-unavailable messaging, injected database connection failure and recovery, and infeasible generation feedback. Unit and PostgreSQL tests also cover expired sessions, readiness failures, authorization, rejected transitions, and persistence. These are local E2E results, not CI or live-deployment results. No live provider key was used.
'@ @'
The browser journey configures batches, subjects, teachers, rooms, requirements, and eligibility in the Admin UI; confirms a supported Copilot rule through a deterministic provider fixture; handles missing and malformed provider responses; generates and validates; rejects a stale candidate; exercises HOD rejection and publication; and checks scoped Teacher/Student views even with forged query parameters. Additional browser cases verify revoked sessions cannot read protected data, API-unavailable messaging, injected database connection failure and recovery, and infeasible generation feedback. Unit and PostgreSQL tests also cover expired sessions, readiness failures, authorization, rejected transitions, and persistence. The browser journey is covered by the automated E2E suite and hosted CI. AI interpretation remains optional; manual scheduling does not require a provider key.
'@ 'E2E status'
Replace-Exact 'no production deployment or managed backup configuration.' 'no managed backup/recovery configuration or production-scale reliability verification.' 'limitations'
$architecturePattern = '(?s)(### Problem and architecture\s+.*?```mermaid\s*).*?(\s*```\s*(?=### Engineering decisions))'
$architectureDiagram = @'
flowchart LR
  U[Admin, HOD, Teacher, Student<br/>React 19 browser] -->|HTTPS, same origin| A[Render Node.js service<br/>static frontend + /api]
  A <--> D[(Neon PostgreSQL<br/>users · domain · rules · versions)]
  A -->|structured interpretation request| L[Optional AI provider]
  L -->|JSON rule proposal| A
'@
if ([regex]::IsMatch($content, $architecturePattern)) {
  $content = [regex]::Replace($content, $architecturePattern, ('$1' + $architectureDiagram + '$2'), 1)
  $changes++
} else {
  Write-Warning 'Could not locate the architecture diagram; deployment and CI updates will still be applied.'
}
$backup = "$readmePath.before-portfolio-update.bak"
if (Test-Path $backup) { throw "Backup already exists: $backup. Rename or remove it before rerunning." }
Copy-Item $readmePath $backup
[System.IO.File]::WriteAllText($readmePath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "Updated README.md ($changes replacements). Backup: $backup"
Write-Host 'Next: add your real UI screenshots under docs/screenshots and embed them in the README.'
