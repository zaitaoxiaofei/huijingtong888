import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";

const SEED_ARTICLES = [
  ["new-hire-first-day", "新人第一天必读", "入职基础", "所有员工", 10, `# 欢迎加入团队

这套系统用于连接产品开发、商品运营、订单履约、采购入库、库存和财务工作。先理解流程，再进行实际操作。

## 第一天需要完成

- 登录自己的员工账号，不共用账号，不向他人发送密码
- 确认自己的岗位、直属负责人和工作范围
- 浏览“系统功能地图”和本岗位操作手册
- 在测试数据或负责人陪同下完成第一次操作

## 必须先请示的操作

- 删除商品、订单、库存或财务数据
- 批量修改价格、库存或上架资料
- 发布商品、调整店铺配置、修改自动任务
- 处理无法判断责任或可能造成损失的异常

遇到不确定事项时，先保留现场和截图，再联系直属负责人。`],
  ["system-map", "系统功能地图与岗位分工", "系统操作", "所有员工", 20, `# 系统功能地图

## 产品与运营

- 产品开发：记录开发计划和推进状态
- 采集箱：接收采集到的商品资料
- 选品池：筛选、评估并推进候选商品
- 草稿箱与商品上架：维护 Ozon 商品资料并发布
- 在线商品：查看已上线商品和库存状态

## 履约与供应链

- 订单列表：查看订单和处理进度
- 待入库清单：采购、到货及入库处理
- 出库记录：核对包裹出库情况
- 库存中心：管理库存、预警和 SKU 绑定

## 数据与财务

- 数据分析：查看店铺、商品和订单表现
- 财务中心：账单、利润、成本及异常核对

每位员工只处理岗位授权范围内的数据。跨岗位修改前必须和数据负责人确认。`],
  ["listing-flow", "从选品到商品上架", "系统操作", "产品与运营", 30, `# 从选品到上架

## 标准流程

1. 在采集箱核对来源商品、图片、规格和供应信息
2. 推进到选品池，完成利润、竞争和供货判断
3. 创建上架草稿，选择正确的 Ozon 类目和商品类型
4. 填写标题、描述、属性、变体、价格、包装和图片
5. 运行发布校验，逐项解决阻断问题
6. 选择正确店铺发布，并在上架记录中确认结果

## 质量要求

- 类目和属性必须与真实商品一致
- 图片、标题和描述不得包含未经确认的功能或参数
- 变体 SKU、价格、重量和包装尺寸必须逐项核对
- 发布失败时阅读系统给出的业务字段和修复位置，不要反复盲目提交

批量发布或不确定类目时，必须先交由负责人复核。`],
  ["order-fulfillment", "订单、采购、入库和出库流程", "物流履约", "订单、采购与仓库", 40, `# 订单履约流程

## 标准步骤

1. 订单进入系统后核对商品、SKU、数量和履约截止时间
2. 有库存的订单进入拣货；缺货订单进入采购和异常处理
3. 到货时核对商品、数量、规格和质量后入库
4. 按订单拣货、复核、打包、粘贴正确面单
5. 出库后核对系统状态，并持续关注物流异常

## 关键原则

- 订单号、SKU 和实物必须三方一致
- 不得为了消除预警而填写虚假采购、入库或出库记录
- 临近截止时间、缺货、错货、破损和面单异常必须立即升级
- 所有时间以系统显示的北京时间为准

平台时效和承运要求可能变化，实际操作前还要核对 Ozon 卖家后台的当前要求。`],
  ["ozon-logistics", "Ozon 物流与发货基础", "Ozon 平台规则", "运营、订单与仓库", 50, `# Ozon 物流基础

## 常见履约模式

- FBS：商品由卖家备货和交接，平台承担后续配送；必须严格关注备货和交接时限
- FBP：商品预先进入平台仓，由平台仓完成主要履约；重点是补货、仓储库存和供货计划

## 操作要求

- 以订单和卖家后台显示的真实截止时间为准
- 使用订单对应的面单，不复用、不错贴
- 包装应适合商品特性和运输距离，避免挤压、进水、散落
- 交接后仍需检查状态，发现未扫描或长时间不更新要及时处理

## 注意

仓库、线路、禁限运、包装和赔付规则会调整。本文章是内部操作摘要，不替代 Ozon 当前官方规则；负责人更新规则时应同步更新本文并填写来源。`],
  ["ozon-listing-rules", "Ozon 商品审核与违规注意事项", "Ozon 平台规则", "产品与运营", 60, `# 商品审核与合规

## 商品信息

- 选择与实物相符的类目和商品类型
- 必填属性、品牌、型号、材质、尺寸和数量必须真实
- 标题和描述应清楚、准确，不夸大效果，不编造认证
- 主图和详情图应展示实际售卖内容，避免误导买家

## 高风险事项

- 商标、版权图片和他人品牌素材的使用权不明确
- 商品属于禁售、限售或需要证明文件的类别
- 变体之间实际不是同一类商品
- 价格、折扣或套装数量与页面表达不一致

审核驳回时先读取平台原因，再修改对应字段。不要通过错误类目或虚假属性绕过审核。规则可能变化，发布负责人需要定期核对 Ozon 官方资料。`],
  ["guoo-cel-quote-packing", "GUOO / CEL 报价与打包发货标准", "物流履约", "运营、采购与仓库", 65, `# GUOO / CEL 报价与打包发货标准

适用范围：Ozon realFBS、FBP 及报价表内列明的独联体专线。本文依据《CEL产品资费表 V7.24》和《GUOO产品资费测算表【2026.7.20更新】》整理，核对日期为 2026-08-14。报价表会更新，本文用于规范操作，不替代承运商当期报价。

## 一、报价前必须准备的 7 项数据

- 平台与履约模式：Ozon realFBS、FBP 或具体国家专线
- 商品成交价：按报价表要求填写卢布 RUB
- 包装完成后的实际重量：单位 KG，保留至少 3 位小数
- 包装完成后的长、宽、高：单位 CM，测量最外侧凸点
- 商品属性：普货、内置电池、配套电池、纯电池、液体、粉末、膏体、磁性或其他敏感属性
- 包裹数量：一个面单对应一个独立包裹，不得把多件包裹重量混填
- 目的国家与选用仓库：必须与后台物流方式和面单一致

不得使用商品裸重、产品页面尺寸或供应商估算尺寸报价。必须先完成最终包装，再称重和测量。

## 二、统一报价步骤

1. 先查禁运品和敏感品；无法确认时暂停，不先打面单
2. 按本文包装标准完成最终包装
3. 电子秤清零后称整票包裹，记录 KG
4. 测量包装最外侧长、宽、高，最长边记为“长”
5. 在对应承运商、平台和履约模式的原始报价表中填写成交价、重量和三边尺寸
6. 只使用报价表自动返回且未显示“超出渠道限制”的渠道
7. 报价截图或记录必须包含承运商、渠道全名、表格版本、重量、尺寸、货值和报价时间

报价表中的结果仅用于成本测算。最终结算以承运商复称、复尺、验货和当期规则为准。

## 三、CEL 产品档位红线

- Extra Small：0.001–0.5KG；三边和不超过 90CM；最长边不超过 60CM；货值 1–1500 RUB
- Budget：0.501–30KG；三边和不超过 150CM；最长边不超过 60CM；货值 1–1500 RUB
- Small：0.001–2KG；三边和不超过 150CM；最长边不超过 60CM；货值 1501–7000 RUB
- Big：2.001–30KG；三边和不超过 310CM；最长边不超过 150CM；按实际重与体积重取大值，体积重为长×宽×高÷12000
- Premium Small：0.001–5KG；三边和不超过 250CM；最长边不超过 150CM；货值 7001–250000 RUB
- Premium Big：5.001–30KG；三边和不超过 310CM；最长边不超过 150CM；最大外箱尺寸 150×80×80CM；按实际重与体积重取大值
- CEL HK：0.001–25KG；三边和不超过 310CM；最长边不超过 150CM；三边和超过 60CM 时按长×宽×高÷6000计算体积重，并与实际重取大值

注意：“不计抛”只代表该渠道表内按实际重计费，不代表可以忽略尺寸限制。卡在重量、货值或尺寸临界点时，不要压线发货，应重新包装或选择更高档位。

## 四、GUOO 报价使用标准

- GUOO 表按平台和模式分表：realFBS、FBP、Yandex 及各国家专线，禁止跨表套价
- 输入商品实际成交价、包装后实际重量和包装后三边尺寸，由表格自动匹配计费重量及可用渠道
- 常见结构为“每千克价格 + 每票操作费”；不得只取每千克单价，也不得漏掉每票费用
- 表格显示“超出渠道限制”时，说明重量、货值或尺寸不符合要求，禁止人工改公式或强行套用
- Extra Small、Budget、Small、Big、Premium Small、Premium Big 的选择同时受重量、货值和尺寸约束，不能只看重量
- 空运、陆空联运和陆运对电池及敏感品的接收条件不同；纯电池、配套电池或超过渠道功率限制的带电产品必须先书面确认
- GUOO 一件代发必须使用正确的仓库、系统和仓库代码；地址、联系人和工作时间以报价表“GUOO仓库地址&一件代发服务”页最新内容为准，不复制旧地址到本文

## 五、包装操作标准

### 1. 包装材料选择

- 普通耐压商品：使用尺寸合适、无破损的瓦楞纸箱或结实快递袋
- 易碎、易变形、带尖角商品：必须使用纸箱；内部用气泡膜、珍珠棉或定型材料隔离
- 液体、膏体、粉末：只有渠道明确允许时才可发；先密封原容器，再使用独立防漏袋和吸附/缓冲材料，最后装箱
- 多件套：每个部件先独立保护，再固定为一套，附装箱清单，避免运输中散开
- 高价值商品：使用不可无痕拆开的封箱方式，包装前后拍照留档

### 2. 内部固定

- 商品与外箱之间不得有明显晃动，六个方向都要有缓冲
- 两件商品之间必须隔开，硬物、尖角和表面不得直接摩擦
- 空隙使用缓冲材料填满，但不要为了填充使用过大的外箱
- 受力点、尖角、接口和易折部位需要额外加固
- 完成后轻晃包裹，不应听到碰撞声或感觉商品移动

### 3. 外箱封装

- 封箱前再次核对商品、SKU、数量、配件和订单号
- 纸箱上下开口使用 H 型封箱，主缝和两侧边缝均完整覆盖
- 重货增加打包带或护角，但打包带不得遮挡面单和条码
- 外箱不得严重变形、受潮、开裂，不使用带无关危险品标识或旧面单的箱子
- 去除或彻底遮盖旧条码、旧地址和旧物流标签，确保扫描设备只能识别本票面单

### 4. 面单粘贴

- 面单贴在最大、最平整的一面，不跨箱缝、封箱胶、折角或曲面
- 条码保持平整、完整、清晰，不用反光胶带覆盖条码
- 一个包裹只保留一个有效物流面单；多箱订单按系统拆分，不复制同一面单
- 面单上的订单、SKU、物流方式、仓库和实际包裹必须一致

### 5. 称重、测量和留证

- 使用校准正常的电子秤，称最终封装且已贴面单的整票重量
- 长宽高按外包装最外侧测量，鼓包、护角和凸起均计入
- 拍摄商品、内部防护、封箱完成、面单和秤重读数；高价值或易碎件必须留存
- 系统填写重量和尺寸必须与本次实测记录一致，不沿用历史商品数据

## 六、GUOO 禁运红线

GUOO 表明确列出的禁运品名包括蛋孵化器、牙科器械和制氧机。禁运品类还包括但不限于：爆炸品、易燃气体/液体/固体、毒性与腐蚀品、弹药及武器零件、有毒或生物传染物、易腐食品、活体动植物、麻醉药品、酒类、现金和流通货币、渔网、工业机器设备及零件、内燃机、刀具和医疗设备等。

以下商品即使不在名称清单中，也必须先交负责人和承运商书面确认：带电或带磁商品、液体、粉末、膏体、喷雾、香水、胶水、化学品、刀具、医疗相关产品、品牌真伪或知识产权不明确的商品。

禁止通过错误品名、错误类目、隐瞒电池或拆除危险标识绕过承运审核。

## 七、出库前 12 项复核

- 商品、SKU、规格和数量正确
- 无禁运或未确认的敏感属性
- 内部防护完成，晃动无位移和碰撞声
- 液体/粉末已确认可运并完成双重防漏
- 外箱完好，H 型封箱完成
- 旧面单和旧条码已清除
- 新面单平整、清晰且未跨缝
- 包装后实重已经记录
- 包装后三边尺寸已经记录
- GUOO/CEL 渠道、产品档位和履约模式正确
- 报价表未显示超限，费用包含每票费及其他必要费用
- 留存必要照片并在截止时间前完成交接

任何一项无法确认，先放入待复核区并联系负责人，不得凭经验直接出库。`],
  ["exceptions", "系统常见异常处理", "异常处理", "所有员工", 70, `# 常见异常处理原则

## 先做什么

1. 阅读页面完整错误信息，不只看错误代码
2. 记录订单号、SKU、店铺、页面和北京时间
3. 截图并保留原始数据，不连续重复提交
4. 判断属于商品、店铺、订单、库存、采购、物流还是财务层

## 常见情况

- 发布失败：检查类目、必填属性、图片、价格、包装和店铺授权
- 未绑定 SKU：到 SKU 绑定页面核对 Ozon SKU 与内部商品
- 库存异常：先核对实物、入出库记录和组合商品关系
- 订单超时：立即处理并通知履约负责人，不得修改数据掩盖超时
- 成本异常：核对采购记录、数量、运费和币种后交财务确认

无法判断时，把已核对内容一并交给负责人，避免让下一位同事重复排查。`],
  ["forbidden-actions", "新人禁止误操作清单", "入职基础", "所有员工", 80, `# 禁止误操作清单

- 禁止共用账号或借用他人身份修改数据
- 禁止在未确认时删除、合并或覆盖业务数据
- 禁止随意批量改价、改库存、发布或取消订单
- 禁止用虚假入库、出库、采购和成本记录消除异常
- 禁止把客户、店铺、账号或财务敏感信息发到无关渠道
- 禁止在生产环境试验不熟悉的功能
- 禁止忽略超时、缺货、错货、侵权和财务异常

正确做法是暂停操作、保留现场，并向直属负责人说明：发生了什么、涉及哪些编号、已经检查了什么、下一截止时间是什么。`]
];

let schemaReady;

export async function ensureOnboardingKnowledgeSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS onboarding_articles (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(120) NOT NULL UNIQUE,
      title VARCHAR(200) NOT NULL,
      category VARCHAR(80) NOT NULL,
      audience VARCHAR(120) NOT NULL DEFAULT '所有员工',
      summary VARCHAR(500) NOT NULL DEFAULT '',
      content MEDIUMTEXT NOT NULL,
      source_url VARCHAR(1000) NOT NULL DEFAULT '',
      source_checked_at DATE NULL,
      status ENUM('draft','published') NOT NULL DEFAULT 'published',
      sort_order INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by_person_id BIGINT NULL,
      updated_by_person_id BIGINT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_onboarding_category_status (category, status, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS onboarding_article_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      article_id BIGINT UNSIGNED NOT NULL,
      version INT NOT NULL,
      title VARCHAR(200) NOT NULL,
      category VARCHAR(80) NOT NULL,
      audience VARCHAR(120) NOT NULL,
      summary VARCHAR(500) NOT NULL DEFAULT '',
      content MEDIUMTEXT NOT NULL,
      source_url VARCHAR(1000) NOT NULL DEFAULT '',
      source_checked_at DATE NULL,
      status ENUM('draft','published') NOT NULL,
      changed_by_person_id BIGINT NULL,
      changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uniq_onboarding_article_version (article_id, version),
      INDEX idx_onboarding_version_time (article_id, changed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    for (const [slug, title, category, audience, sortOrder, content] of SEED_ARTICLES) {
      await mysqlExecute(`INSERT IGNORE INTO onboarding_articles
        (slug, title, category, audience, summary, content, status, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, 'published', ?)`, [slug, title, category, audience, content.split("\n").find((line) => line && !line.startsWith("#")) || "", content, sortOrder]);
    }
  })().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

const articleSelect = `SELECT a.*, creator.name AS created_by_name, updater.name AS updated_by_name
  FROM onboarding_articles a
  LEFT JOIN people creator ON creator.id = a.created_by_person_id
  LEFT JOIN people updater ON updater.id = a.updated_by_person_id`;

export async function listOnboardingArticles(query = {}, session = {}) {
  await ensureOnboardingKnowledgeSchema();
  const canEdit = ["admin", "manager"].includes(String(session.role || "").toLowerCase());
  const params = [];
  const where = [];
  if (!canEdit) where.push("a.status = 'published'");
  if (query.category) { where.push("a.category = ?"); params.push(String(query.category)); }
  if (query.q) {
    const keyword = `%${String(query.q).trim()}%`;
    where.push("(a.title LIKE ? OR a.summary LIKE ? OR a.content LIKE ?)");
    params.push(keyword, keyword, keyword);
  }
  const rows = await mysqlQuery(`${articleSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.sort_order, a.id`, params);
  return { rows, can_edit: canEdit };
}

export async function onboardingArticleHistory(articleId) {
  await ensureOnboardingKnowledgeSchema();
  return mysqlQuery(`SELECT v.id, v.article_id, v.version, v.title, v.status, v.changed_at,
    p.name AS changed_by_name FROM onboarding_article_versions v
    LEFT JOIN people p ON p.id = v.changed_by_person_id
    WHERE v.article_id = ? ORDER BY v.version DESC`, [Number(articleId)]);
}

function cleanArticleInput(body = {}) {
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();
  if (!title) { const error = new Error("请填写文章标题"); error.status = 400; throw error; }
  if (!content) { const error = new Error("请填写文章正文"); error.status = 400; throw error; }
  return {
    title, content,
    category: String(body.category || "入职基础").trim().slice(0, 80),
    audience: String(body.audience || "所有员工").trim().slice(0, 120),
    summary: String(body.summary || "").trim().slice(0, 500),
    sourceUrl: String(body.source_url || "").trim().slice(0, 1000),
    sourceCheckedAt: body.source_checked_at || null,
    status: body.status === "draft" ? "draft" : "published",
    sortOrder: Number(body.sort_order || 0) || 0
  };
}

export async function saveOnboardingArticle(body = {}, session = {}) {
  await ensureOnboardingKnowledgeSchema();
  const input = cleanArticleInput(body);
  const articleId = Number(body.id || 0);
  const personId = Number(session.personId || session.id || 0) || null;
  return withMysqlTransaction(async (connection) => {
    if (articleId) {
      const [rows] = await connection.query("SELECT * FROM onboarding_articles WHERE id = ? FOR UPDATE", [articleId]);
      const current = rows[0];
      if (!current) { const error = new Error("文章不存在或已删除"); error.status = 404; throw error; }
      await connection.execute(`INSERT INTO onboarding_article_versions
        (article_id, version, title, category, audience, summary, content, source_url, source_checked_at, status, changed_by_person_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [articleId, current.version, current.title, current.category, current.audience, current.summary, current.content, current.source_url, current.source_checked_at, current.status, personId]);
      await connection.execute(`UPDATE onboarding_articles SET title=?, category=?, audience=?, summary=?, content=?, source_url=?, source_checked_at=?, status=?, sort_order=?, version=version+1, updated_by_person_id=? WHERE id=?`,
        [input.title, input.category, input.audience, input.summary, input.content, input.sourceUrl, input.sourceCheckedAt, input.status, input.sortOrder, personId, articleId]);
      return { id: articleId, version: Number(current.version) + 1 };
    }
    const slug = `article-${Date.now()}`;
    const [result] = await connection.execute(`INSERT INTO onboarding_articles
      (slug,title,category,audience,summary,content,source_url,source_checked_at,status,sort_order,created_by_person_id,updated_by_person_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [slug, input.title, input.category, input.audience, input.summary, input.content, input.sourceUrl, input.sourceCheckedAt, input.status, input.sortOrder, personId, personId]);
    return { id: result.insertId, version: 1 };
  });
}
