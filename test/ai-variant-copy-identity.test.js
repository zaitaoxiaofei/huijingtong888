import test from 'node:test';
import assert from 'node:assert/strict';
import {variantVehicleIdentity, assertVariantCopyIdentity} from '../src/shared/variant-copy-identity.js';
import {buildVariantTitleFromSource, removeSourceModelFromProductSubject, normalizeBatchItems} from '../src/services/ai-variant-lab.js';
const source='Volkswagen Jetta，三按键钥匙';
const analysis={product_subject_ru:'Чехол для автомобильного ключа Volkswagen Jetta',product_type:'钥匙壳',source_variant_value:source};
test('operator annotations are excluded from model identity without damaging suffixes',()=>{
 assert.equal(variantVehicleIdentity(source),'Volkswagen Jetta');
 assert.equal(variantVehicleIdentity('TENET T4L (四键钥匙)'),'TENET T4L');
 assert.equal(variantVehicleIdentity('BMW X5 (G05)'),'BMW X5 (G05)');
 assert.equal(removeSourceModelFromProductSubject(analysis.product_subject_ru,source),'Чехол для автомобильного ключа');
 assert.equal(buildVariantTitleFromSource('Чехол Volkswagen Jetta, 3 кнопки',source,'VOLKSWAGEN Polo'),'Чехол VOLKSWAGEN Polo, 3 кнопки');
});
test('a valid AI title wins over the old template and invalid model copy is rebuilt coherently',()=>{
 const fallback={targets:['VOLKSWAGEN Polo'],sourceVariantValue:source,sourceTitle:'Чехол Volkswagen Jetta, 3 кнопки'};
 const [good]=normalizeBatchItems([{target_variant_value:'VOLKSWAGEN Polo',title_ru:'Чехол для автомобильного ключа VOLKSWAGEN Polo'}],analysis,fallback);
 assert.equal(good.title_ru,'Чехол для автомобильного ключа VOLKSWAGEN Polo');
 const [bad]=normalizeBatchItems([{target_variant_value:'VOLKSWAGEN Polo',title_ru:'Чехол Volkswagen Jetta для VOLKSWAGEN Polo',description_ru:'Jetta '.repeat(80),tags_ru:['#volkswagen_jetta']}],analysis,fallback);
 for(const text of [bad.title_ru,bad.description_ru,bad.tags_ru.join(' ')]){assert.doesNotMatch(text,/jetta/i);assert.match(text,/polo/i);}
 assert.doesNotMatch(bad.tags_ru.join(' '),/органайзер|хранение|интерьер/i);
 assert.ok(bad.tags_ru.every(tag=>tag.startsWith('#')&&tag.length<=25&&!/\s/.test(tag)));
});
test('server rejects contaminated saved copy but allows same-source targets and model prefixes',()=>{
 const valid={title:'Чехол VOLKSWAGEN Polo',description:'Чехол для VOLKSWAGEN Polo',tags:['#VOLKSWAGEN_Polo']};
 assert.doesNotThrow(()=>assertVariantCopyIdentity(valid,{source,target:'VOLKSWAGEN Polo'}));
 for(const field of ['title','description','tags'])assert.throws(()=>assertVariantCopyIdentity({...valid,[field]:field==='tags'?['#VOLKSWAGEN_Polo','#Volkswagen_Jetta']:valid[field]+' Volkswagen Jetta'},{source,target:'VOLKSWAGEN Polo'}),{status:422});
 assert.doesNotThrow(()=>assertVariantCopyIdentity({title:'Чехол TENET T4L',description:'Чехол TENET T4L',tags:['#TENET_T4L']},{source:'TENET T4',target:'TENET T4L'}));
});
test('long target names may use separate complete brand/model tags without truncating identity',()=>{
 assert.doesNotThrow(()=>assertVariantCopyIdentity({title:'Чехол MERCEDES-BENZ CLA C117',description:'Чехол MERCEDES-BENZ CLA C117',tags:['#MERCEDES_BENZ','#CLA_C117']},{source:'Volkswagen Jetta',target:'MERCEDES-BENZ CLA C117'}));
});
