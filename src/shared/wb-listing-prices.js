export function wbListingPrice(basePrice,saleMultiplier=1,oldMultiplier=2){
 const base=Number(basePrice),saleFactor=Number(saleMultiplier),oldFactor=Number(oldMultiplier);
 if(!Number.isFinite(base)||base<=0||!Number.isFinite(saleFactor)||saleFactor<=0||!Number.isFinite(oldFactor)||oldFactor<=0)throw Error('请填写大于零的已有售价和倍率。');
 const sale=Math.round(base*saleFactor),old=Math.round(base*oldFactor);
 if(!Number.isSafeInteger(sale)||!Number.isSafeInteger(old))throw Error('价格超出可计算范围。');
 if(sale<1||old<sale)throw Error('计算后的售价须大于零，划线价不能低于售价。');
 const discount=Math.round((1-sale/old)*100),effective=Math.round(old*(1-discount/100)*100)/100;
 return {sale_price:sale,old_price:old,wb_price:old,discount,effective_price:effective,exact:Math.abs(effective-sale)<0.005};
}
