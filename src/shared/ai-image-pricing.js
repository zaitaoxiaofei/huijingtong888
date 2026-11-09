// Customer tariff, in integer points/cents. Supplier invoices remain separate.
export const AI_POINTS_PER_YUAN = 100;
export const AI_IMAGE_POINTS = 10;
export const AI_IMAGE_PRICE_KEY = "image.generate";
export const AI_IMAGE_PRICE_VERSION = 20261110;
export function aiImageCharge(successfulImages) {
  if (!Number.isSafeInteger(successfulImages) || successfulImages < 0) throw new Error("Invalid successful image count");
  return { successfulImages, points: successfulImages * AI_IMAGE_POINTS, amountCents: successfulImages * AI_IMAGE_POINTS };
}
