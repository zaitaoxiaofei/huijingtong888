import { calculateWithdrawalFee } from '../pricingFormula.js';

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const finalMileRate = 0.025;

export function saleFees(saleCny, freight) {
  const lastMile = round(saleCny * finalMileRate);
  const withdrawalFee = calculateWithdrawalFee({ saleRmb: saleCny, freightAmount: freight, finalMileBankFee: lastMile });
  return { lastMile, withdrawalFee };
}
