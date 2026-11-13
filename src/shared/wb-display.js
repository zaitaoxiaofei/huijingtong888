const COLORS={'черный':'黑色','чёрный':'黑色','белый':'白色','красный':'红色','синий':'蓝色','голубой':'浅蓝色','серый':'灰色','зеленый':'绿色','зелёный':'绿色','желтый':'黄色','жёлтый':'黄色','розовый':'粉红色','коричневый':'棕色','бежевый':'米色','фиолетовый':'紫色','оранжевый':'橙色','золотистый':'金色','серебристый':'银色','мультиколор':'多色','китай':'中国','россия':'俄罗斯'};
export function wbValueLabel(value){return COLORS[String(value).trim().toLowerCase()]||String(value??'');}
export function wbAttributeLabel(attribute){const id=Number(attribute.charcID),name=String(attribute.name||'').split('/')[0].trim();if(id===15000001||/^(feacn|тнвэд)$/i.test(name))return '海关编码（ТНВЭД）';if(id===15004139||name==='HS编码')return '海关编码（HS）';if(id===15003293)return 'Ozon 关联货号（选填）';if(name==='产品最小的出库单位')return '最小发货单位';const unit=({'г':'g','кг':'kg','см':'cm','шт':'件','мл':'ml','л':'L'})[attribute.unitName]||attribute.unitName;return name+(unit&&!name.includes(unit)?`（${unit}）`:'');}
export function wbLocalizedOptions(raw,localized,kind){
 const key=item=>typeof item==='object'&&item?(item.id??item.tnved??item.code??null):null;
 const value=item=>typeof item==='string'||typeof item==='number'?String(item):String(kind==='tnved'?item.tnved||item.code||'':item.name||item.value||'');
 const localizedById=new Map(localized.filter(item=>key(item)!==null).map(item=>[String(key(item)),item]));
 return raw.map((item,index)=>{const original=value(item),translated=key(item)!==null?localizedById.get(String(key(item))):raw.length===localized.length?localized[index]:null;return {value:original,label:kind==='vat'&&/^\d+(\.\d+)?$/.test(original)?original+'%':kind==='tnved'?original+(item.isKiz?'（需强制标识）':''):translated?value(translated):wbValueLabel(original)};}).filter(item=>item.value);
}
