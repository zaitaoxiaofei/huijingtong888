<script setup>
import { ref } from "vue";
const search = ref("");
const sections = [
  { title: "Beta 套餐与功能", text: "在会员中心点击查看套餐，可比较价格、账号总数、店铺额度与功能；账号数含主账号。每企业只能选择一次体验，1 天和 7 天二选一。体验版不含 AI 技能库、任务系统和财务中心；基础版开放财务中心，不含 AI 和任务系统；团队版全部开放，仍受岗位权限和已验收的企业功能范围限制。" },
  { title: "会员激活与续期", text: "打开会员中心，查看剩余时长和到期时间，点击输入激活码。由企业负责人兑换；续期累加剩余时长，账号和店铺额度以激活码对应套餐为准。内测期间暂不支持在线支付，在会员中心点击联系开通或续费，展开微信二维码联系服务人员。" },
  { title: "AI 积分与充值", text: "AI 技能库仅团队版开放。每个企业按北京时间自然月赠送 100 积分，未用完可累计，同一企业的员工不会重复领取。1 积分 = ¥0.01，每张成功生成的图片扣 10 积分，文本免费。生成前冻结积分，明确失败后返还，状态不明时等待原任务核对。会员中心可查看余额与使用记录；充值请在会员中心点击充值积分，扫码联系服务人员完成付款和登记。" },
  { title: "绑定企业采集插件", text: "在会员中心顶部查看或生成企业密钥，点击复制。下载采集插件后，将密钥粘贴到插件的“企业专属密钥”，点击“保存密钥”，确认插件显示连接成功。密钥由企业负责人或管理员管理。重置会使原密钥失效，所有已绑定插件都需更新。" },
  { title: "采集箱与草稿箱归属", text: "采集先进入密钥所属企业的采集箱，生成或保存草稿后进入本企业草稿箱。同一企业成员共享，其他企业不可读取。切换 ERP 空间不会自动切换插件密钥，跨企业使用时需在插件中重新绑定。" },
  { title: "绑定 Ozon 店铺", text: "在企业管理 → 企业店铺新增店铺，选择本企业的负责人账号。公司主体填写店铺注册的经营主体。店铺 Client ID 与 API Key 必须成对填写；编辑时密钥留空保留原值。Seller ID 是卖家编号，不用于接口认证。广告 Client ID 与 Client Secret 属于独立的 Performance API 授权。" },
  { title: "店铺提成比例", text: "新店铺默认 0%。此比例记录店铺利润拟分配给负责人的份额，例如利润 1,000 元、比例 10%，对应 100 元。目前只保存比例，不自动发放分红，也不改变订单利润。已有店铺保留原比例。" },
  { title: "开始第一条业务流程", text: "激活会员、绑定自己的店铺并检查授权后，先拉取订单；开通团队套餐后可使用产品工作流处理图片。产出需人工检查。基础利润计算器和定价工具无需激活即可使用。所有页面时间均按北京时间显示。" }
];
</script>
<template>
  <section class="usage-documentation"><el-input v-model="search" placeholder="搜索激活、积分、插件、店铺…" clearable aria-label="搜索使用文档" />
    <article v-for="section in sections.filter(item => !search.trim() || (item.title + item.text).includes(search.trim()))" :key="section.title"><h2>{{ section.title }}</h2><p>{{ section.text }}</p><el-button v-if="section.title === '绑定企业采集插件'" tag="a" href="/downloads/ozon-baodan-erp-plugin.zip" target="_blank" rel="noopener noreferrer">下载采集插件</el-button></article>
  </section>
</template>
<style scoped>.usage-documentation{display:grid;gap:18px}.usage-documentation article{padding-bottom:16px;border-bottom:1px solid var(--erp-border)}.usage-documentation h2{margin:0 0 10px;font-size:16px}.usage-documentation p{margin:0;line-height:1.9;color:var(--erp-text-regular);white-space:pre-line}</style>
