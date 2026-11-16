import {createApp,h,KeepAlive} from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import '/frontend/admin/styles/index.css';
import '/frontend/admin/styles/erp-theme.css';
import {createRouter,createWebHashHistory,RouterView} from 'vue-router';
import {createPinia} from 'pinia';
import {useAuthStore} from '/frontend/admin/stores/auth';
import View from '/frontend/admin/views/analytics/SkuTrafficMonitorView.vue';
import Detail from '/frontend/admin/views/analytics/SkuTrafficDetailView.vue';
import Analysis from '/frontend/admin/views/analytics/SellerAnalyticsView.vue';
const router=createRouter({history:createWebHashHistory(),routes:[{path:'/sku-traffic-monitor',name:'sku-traffic-monitor',component:View},{path:'/sku-traffic-monitor/detail',name:'sku-traffic-detail',component:Detail},{path:'/seller-analytics',name:'seller-analytics',component:Analysis}]});
const app=createApp({render:()=>h('div',{class:'erp-workspace-panel',style:'height:calc(100vh - 40px);overflow:auto'},[h(RouterView,null,{default:({Component})=>h(KeepAlive,null,Component?[h(Component)]:[])})])});
app.use(router);app.use(createPinia());app.use(ElementPlus,{locale:zhCn});
if(window.skuFixturePlugin){
 const auth=useAuthStore();
 window.changeSkuFixtureUser=id=>{localStorage.setItem('skuFixturePersonId',String(id));auth.applyLoginResult({token:'sku-fixture-user-'+id,user:{id,tenant:{id:1}}});};
 window.changeSkuFixtureUser(Number(localStorage.getItem('skuFixturePersonId'))||1001);
 window.addEventListener('message',event=>{
  const data=event.data||{};if(event.source!==window)return;
  if(data.type==='BAODAN_ANALYTICS_PLUGIN_INSTANCE_REQUEST')window.postMessage({type:'BAODAN_ANALYTICS_PLUGIN_INSTANCE',pluginInstanceId:'sku-preview-simulated',pluginVersion:'1.5.7',capabilities:{collector:true,sellerAnalytics:true}},location.origin);
  if(data.type==='BAODAN_ANALYTICS_PLUGIN_CHECK_STORE')window.postMessage({type:'BAODAN_ANALYTICS_PLUGIN_CHECK_STORE_RESULT',requestId:data.requestId,pluginInstanceId:data.pluginInstanceId,result:{ok:true}},location.origin);
 });
}
window.skuTrafficErrors=[];app.config.errorHandler=e=>window.skuTrafficErrors.push(e.message);app.mount('#adminApp');
