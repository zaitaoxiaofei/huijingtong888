# Ozon ERP Windows Host

This folder is for the "my Windows PC is the cloud host" deployment mode.

Recommended topology:

1. Build a release artifact with `npm run package:deploy`
2. Run the ERP server from `dist/deploy`
3. Expose `http://127.0.0.1:8787` through Cloudflare Tunnel
4. Let teammates use `https://erp.hjt888.xyz`

## 1. Build the deployable artifact

From the project root:

```powershell
npm run package:deploy
```

This refreshes `dist/deploy`.

## 2. Prepare the deploy directory

Inside `dist/deploy`, create a real `.env` from `.env.example` or from your current server settings.

Minimum recommended values:

```env
HOST=127.0.0.1
PORT=8787
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=ozon_erp
DB_USER=ozon_app
DB_PASSWORD=replace-me
APP_BASE_URL=https://erp.hjt888.xyz
LISTING_MEDIA_PUBLIC_BASE_URL=https://erp.hjt888.xyz
SITE_ACCESS_PASSWORD=replace-with-a-long-random-password
HEALTH_CHECK_USERNAME=health-check-user
HEALTH_CHECK_PASSWORD=replace-with-a-strong-password
```

## 3. Start the ERP server

Use the helper:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows-host\start-erp-server.ps1
```

It starts `node src/server.js` from `dist/deploy` and writes logs under `dist/deploy/logs`.

## 4. Configure Cloudflare Tunnel

1. Copy `deploy/cloudflared/config.example.yml`
2. Fill in your real tunnel UUID and credential file
3. Save it as:

```text
%USERPROFILE%\.cloudflared\config.yml
```

Your ingress should point to:

```yaml
- hostname: erp.hjt888.xyz
  service: http://127.0.0.1:8787
```

## 5. Start Cloudflare Tunnel

Use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\cloudflared\start-tunnel.ps1
```

## 6. Start everything together

If the deploy artifact already exists, you can use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows-host\start-host-stack.ps1
```

This will:

- verify `dist/deploy` exists
- start the ERP server
- start the Cloudflare Tunnel

## 7. Recommended operations

- Keep Node server bound to `127.0.0.1`, not public interfaces
- Only expose the app through Cloudflare Tunnel
- Keep `SITE_ACCESS_PASSWORD` enabled
- Back up MySQL on a schedule
- Keep this PC always on
- Add startup tasks only after manual startup works cleanly

## 8. Suggested next step

After manual startup is stable:

1. Create a Windows Scheduled Task for `start-host-stack.ps1`
2. Create a separate daily MySQL backup task
3. Move teammates to `https://erp.hjt888.xyz`


## 9. Update the running host

When the ERP is already running from `dist/deploy`, do not rebuild over the live folder manually.
Use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows-host\update-host-stack.ps1
```

If you need to bypass preflight checks for an emergency release:

```powershell
$env:SKIP_DEPLOY_PREFLIGHT="1"
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows-host\update-host-stack.ps1
```

This will:

- run preflight checks before any stop/restart work:
  - `npm test`
  - `npm run check:deploy-preflight`
- create a deployment lock at `dist/deploy.lock` so two publish runs cannot overlap
- create a MySQL backup before stopping the running service, when an existing `dist/deploy` folder is present
- stop the current ERP service
- stop Cloudflare Tunnel
- rebuild `dist/deploy`
- restore the previous hosted `.env` into the new `dist/deploy` when available
- start the ERP service again
- start Cloudflare Tunnel again
- run a local deployment health check against `http://127.0.0.1:8787` using `HEALTH_CHECK_USERNAME` / `HEALTH_CHECK_PASSWORD` from `dist/deploy/.env`
- run a public deployment health check against `APP_BASE_URL` from `dist/deploy/.env`, normally `https://erp.hjt888.xyz`
- roll back to the previous `dist/deploy` automatically if startup or health check fails

If a previous publish crashed and no publish is currently running, delete `dist/deploy.lock` and retry.

Emergency switches:

```powershell
$env:SKIP_DEPLOY_PREFLIGHT="1"              # skip npm test and environment preflight
$env:SKIP_DEPLOY_DB_BACKUP="1"              # skip the pre-deploy MySQL backup
$env:SKIP_DEPLOY_PUBLIC_HEALTH_CHECK="1"    # skip the public erp.hjt888.xyz health check
$env:PUBLIC_HEALTH_CHECK_BASE_URL="https://erp.hjt888.xyz"
```
