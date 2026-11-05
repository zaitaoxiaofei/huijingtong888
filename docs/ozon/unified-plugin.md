# Unified Ozon browser plugin

Implementation version: collector plugin 1.5.0. The release is pending ECS rollout approval and production package acceptance.

## One installation and one connection input

`ozon-erp-collector-plugin` is the unified installation. Its main popup provides product collection and shop analytics tabs. The only editable connection field is the enterprise plugin key. The service URL is fixed to `https://erp.hjt888.xyz`; the existing authenticated `GET /api/local-plugin/plugin/status` supplies the enterprise selector from the verified token principal. A read-only production check confirmed this endpoint accepts the enterprise token alone, without a separate site-access token or cookie.

The canonical key remains `ozon-erp-local-plugin-token`. Existing product-extension settings can be reused when updating the same extension installation. A separate extension's private Chrome storage cannot be silently imported; an operator coming from the standalone analytics extension pastes the enterprise key once. Do not introduce a new manifest key or promise extension ID preservation when loading an unpacked package from a different folder.

Local saving is independent of remote validation. Failed validation does not leave the popup at saving, expose the key, or authorize a different enterprise. Concurrent saves preserve the latest accepted intent even when hashing or storage completes out of order. Connection metadata is bound to a key fingerprint. A key associated with another historical ERP origin requires explicit re-entry; content and background paths cannot forward it to a different service. Explicitly empty canonical keys never fall back to a separate analytics key.

The popup always shows the installed manifest version and the latest server version. Optional updates are visible without turning them into mandatory updates. This addresses the old product popup's `update_required`-only rendering, which hid normal available updates.

## Runtime and session ownership

The standalone `pivot-table-master` source remains compatible. `scripts/sync-unified-analytics.mjs` generates an IIFE-wrapped analytics runtime and copied assets under the unified plugin's `analytics/` directory. Do not concatenate both original backgrounds into global scope: they share top-level declarations. Keep MAIN-world document-start relay/analytics ordering, isolated relay messaging, and existing frame behavior. Do not inject into about:blank relay parser frames.

Both runtimes use `unified-config.js` for the same service, enterprise and key. `unified-runtime.js` coordinates Seller navigation with product requests. Analytics preparation waits for active product work, blocks new product claims, and retains its gate until the underlying preparation actually completes. Legacy Seller bridge requests also participate. A timeout while waiting must not release a gate around navigation that is still executing. The unified analytics adapter bounds remote fetch/body waits so a stalled binding probe cannot monopolize the shared preparation gate.

The unified ERP bridge advertises collector and sellerAnalytics capabilities and its actual extension instance ID. App and analytics-page handshakes prefer that live instance, correlate store-check results by instance, and discard late responses after a switch. Tenant and live-company guards remain authoritative. After switching to the unified package, disable the separate old analytics extension and refresh ERP/Seller pages; old installed code cannot be changed by the new extension.

## Distribution and compatibility

`capabilities.json` is the explicit server distribution boundary. When both capabilities are true, the existing `plugin` and `analytics_plugin` update fields advertise one version and the same `ozon-baodan-erp-plugin-1.5.0.zip`. Unversioned legacy download aliases resolve to the canonical unified archive. Explicit old versioned analytics archives retain their actual old manifest version. Existing minimum-version/system-bug policies remain explicit; merging features does not force every old installation to update.

`npm run package:plugin` first regenerates analytics assets, then creates one versioned ZIP and byte-identical aliases. `COLLECTOR_PLUGIN_OUTPUT_DIR` can isolate local packages. Windows uses native tar with explicit top-level entries, so `manifest.json` is a root archive entry. The normal deployment packager always rebuilds the collector ZIP and selects versioned packages by source manifests, instead of reusing stale aliases or selecting an unrelated higher-version file from a sibling task. Verify all package files against source and keep the sibling source mirror at the same manifest version. A release still requires the normal remote-release merge, fresh ECS approval, and verification of production metadata and downloaded archive contents.

Local tests cover one-key save/validation, stale and concurrent saves, both real background scripts loading together, task/navigation coordination, instance selection, store checks, update compatibility, download aliases, and the existing HTTP coordinator on local 8788. Chrome/Ozon/tenant fixtures are synthetic except for the explicitly noted read-only production identity endpoint check. Popup visual verification uses a separate headless test session, not the operator's logged-in browser.
