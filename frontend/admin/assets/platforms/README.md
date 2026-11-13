# Platform icons

Public official-site icons, verified 2026-11-12:

- `ozon.svg`: https://ir-20.ozone.ru/s3/fe-favicon/favicon.svg , declared by https://seller.ozon.ru/ . Original SVG, unchanged.
- `wb.png`: native 32×32 frame extracted losslessly from https://seller.wildberries.ru/favicon.ico , declared by https://seller.wildberries.ru/ . Artwork unchanged; unused icon sizes are omitted.

Both assets together are 2,337 bytes. `PlatformBadge.vue` bundles these assets locally, provides accessible platform names and tooltips, and uses a neutral unknown state. No remote image dependency or per-shop copy is required.

Homepage inventory ranking badges represent effective sales within the selected date range, matching its SKU details; they do not claim that every currently linked platform sold this product that day. The original aggregate SQL supplies the platform set without additional per-card requests.
