import test from "node:test";
import assert from "node:assert/strict";
import { buildCopyFactsContract } from "../src/server/services/ai/copyFactsContract.js";
import { validateCopyBundle } from "../src/server/services/ai/copyQualityValidator.js";

test("copy facts contract flags stale sill-plate description on wiper pad draft", () => {
  const draft = {
    id: 342,
    product_name: "Защитные накладки на основание дворников HAVAL H9, 2 шт, резиновые, защита от пыли и листьев",
    manual_facts_json: JSON.stringify({
      title: "Защитные накладки на основание дворников HAVAL H9, 2 шт, резиновые, защита от пыли и листьев",
      description: "автоаксессуар для HAVAL H9 помогает защитить зону порогов от царапин и хорошо сочетается с интерьером салона.",
      attributes: [
        { name: "数量，件数", value: "2" },
        { name: "材料", value: "Резина" }
      ]
    }),
    template_payload_json: JSON.stringify({
      category_name: "汽车用品 / 汽车改装和外部装饰 / 汽车外部部件的保护"
    })
  };

  const contract = buildCopyFactsContract({ draft });
  const report = validateCopyBundle({
    title: contract.source.title,
    tags: [],
    description: contract.source.originalDescription
  }, contract);

  assert.equal(contract.productSubject.key, "wiper_base_pad");
  assert.equal(report.passed, false);
  assert.match(report.errors.join(","), /unrelated_subject_token:порог/);
  assert.match(report.errors.join(","), /unrelated_subject_token:салон/);
});

test("copy quality accepts clean ABS silver sill plate bundle", () => {
  const draft = {
    id: 295,
    product_name: "Накладка из нержавеющей стали для HAVAL M6, автоаксессуар для защиты и стиля салона",
    manual_facts_json: JSON.stringify({
      title: "Накладка из нержавеющей стали для HAVAL M6, автоаксессуар для защиты и стиля салона",
      description: "старое описание",
      attributes: [
        { name: "安装范围", value: "на пороги" },
        { name: "名称", value: "Накладки на пороги автомобиля" }
      ]
    }),
    template_payload_json: JSON.stringify({
      category_name: "汽车用品 / 汽车改装和外部装饰 / 汽车装饰贴片"
    })
  };

  const contract = buildCopyFactsContract({
    draft,
    material: "ABS",
    color: "silver",
    quantity: "4"
  });
  const report = validateCopyBundle({
    title: "Накладки на пороги автомобиля для HAVAL M6, ABS пластик, серебристые, комплект 4 шт.",
    tags: ["#HAVALM6", "#накладкинапороги", "#ABSпластик", "#серебристые", "#комплект4шт", "#защитапорогов", "#автонакладки", "#аксессуарыHAVAL"],
    description: "Накладки на пороги автомобиля предназначены для HAVAL M6. Комплект включает 4 штуки для дверных проемов. Материал изготовления ABS пластик, серебристый цвет подходит для аккуратного оформления автомобиля. Накладки помогают защитить пороги от повседневных следов обуви и мелких потертостей."
  }, contract);

  assert.equal(contract.productSubject.key, "sill_plate");
  assert.equal(contract.material, "ABS пластик");
  assert.equal(contract.color, "серебристый");
  assert.equal(report.passed, true);
  assert.deepEqual(report.errors, []);
});
