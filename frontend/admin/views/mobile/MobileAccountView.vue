<script setup>
import {onBeforeUnmount,reactive,ref,watch} from 'vue';
import {useAuthStore} from '../../stores/auth.js';
import {useRouter} from 'vue-router';
import {ElMessage} from 'element-plus';
import MobileDialog from '../../components/mobile/MobileDialog.vue';
import {roleLabels} from '../../../../src/shared/permissions.js';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {prepareMobileAvatar} from '../../utils/mobile-evidence.js';
const auth=useAuthStore(),router=useRouter(),avatarInput=ref(),saving=ref(false),preparing=ref(false),changingPassword=ref(false),profileError=ref(''),passwordError=ref('');
const profile=reactive({name:'',avatar_url:''}),password=reactive({old_password:'',new_password:'',confirm_password:''});
const panel=ref('');
function openPanel(value){reset();panel.value=value;}
function closePanel(){if(saving.value||changingPassword.value||preparing.value)return;panel.value='';Object.assign(password,{old_password:'',new_password:'',confirm_password:''});}
let version=0,disposed=false;
function reset(){panel.value='';++version;Object.assign(profile,{name:auth.user?.name||'',avatar_url:auth.user?.avatar_url||''});Object.assign(password,{old_password:'',new_password:'',confirm_password:''});profileError.value='';passwordError.value='';}
watch(()=>`${auth.user?.id}:${auth.user?.tenant?.id}`,reset,{immediate:true});
async function chooseAvatar(event){const file=event.target.files?.[0];event.target.value='';if(!file||saving.value||preparing.value)return;const token=version,scope=currentApiCacheScope();preparing.value=true;profileError.value='';try{const url=await prepareMobileAvatar(file);if(!disposed&&token===version&&scope===currentApiCacheScope())profile.avatar_url=url;}catch(e){if(token===version&&scope===currentApiCacheScope())profileError.value=e.message;}finally{preparing.value=false;}}
async function saveProfile(){if(saving.value||preparing.value)return;if(!profile.name.trim())return ElMessage.warning('请填写姓名');const token=version,scope=currentApiCacheScope();saving.value=true;profileError.value='';try{await auth.updateProfile({name:profile.name.trim(),avatar_url:profile.avatar_url});if(!disposed&&token===version&&scope===currentApiCacheScope()){ElMessage.success('个人资料已更新');panel.value='';}}catch(e){if(e.name!=='AbortError'&&token===version&&scope===currentApiCacheScope())profileError.value=e.message;}finally{saving.value=false;}}
async function savePassword(){if(changingPassword.value)return;passwordError.value='';if(!password.old_password||!password.new_password)return passwordError.value='请填写当前密码和新密码';if(password.new_password.length<8)return passwordError.value='新密码至少需要8位';if(password.new_password!==password.confirm_password)return passwordError.value='两次输入的新密码不一致';const token=version,scope=currentApiCacheScope();changingPassword.value=true;try{await apiClient.post('/api/auth/change-password',{old_password:password.old_password,new_password:password.new_password});if(disposed||token!==version||scope!==currentApiCacheScope())return;Object.assign(password,{old_password:'',new_password:'',confirm_password:''});ElMessage.success('密码已修改，其他设备需重新登录');panel.value='';}catch(e){if(token===version&&scope===currentApiCacheScope())passwordError.value=e.message;}finally{changingPassword.value=false;}}
async function logout(){if(saving.value||changingPassword.value)return;await auth.logout();router.replace('/login');}
window.addEventListener('erp:auth-scope-changed',reset);onBeforeUnmount(()=>{disposed=true;++version;Object.assign(password,{old_password:'',new_password:'',confirm_password:''});window.removeEventListener('erp:auth-scope-changed',reset);});
</script>
<template>
 <div class="mobile-account mobile-form">
  <section class="mobile-record mobile-profile">
   <div class="mobile-profile-heading"><el-avatar :src="auth.user?.avatar_url" :size="64">{{(auth.user?.name||'我').slice(0,1)}}</el-avatar><div><h2>{{auth.user?.name||auth.user?.username}}</h2><span class="mobile-muted">账号 {{auth.user?.username}}</span><span class="mobile-profile-enterprise">{{auth.user?.tenant?.name||'未选择企业'}}</span></div></div>
   <details class="mobile-account-roles"><summary>岗位与权限</summary><p class="mobile-muted">{{roleLabels(auth.user)||'按企业授权'}}</p></details>
  </section>
  <section class="mobile-account-menu" aria-label="账号设置">
   <button type="button" @click="openPanel('profile')"><span><strong>个人资料</strong><small>修改头像与姓名</small></span><span aria-hidden="true">›</span></button>
   <button type="button" @click="openPanel('password')"><span><strong>账号安全</strong><small>修改登录密码</small></span><span aria-hidden="true">›</span></button>
   <button type="button" @click="openPanel('install')"><span><strong>添加到手机桌面</strong><small>从桌面快速进入工作台</small></span><span aria-hidden="true">›</span></button>
  </section>
  <el-button class="mobile-account-logout" :disabled="saving||changingPassword" @click="logout">退出登录</el-button>
  <MobileDialog :model-value="panel==='profile'" title="个人资料" :show-close="!saving&&!preparing" :close-on-press-escape="!saving&&!preparing" @update:model-value="v=>{if(!v)closePanel()}">
   <div class="mobile-form"><div class="mobile-profile-editor"><el-avatar :src="profile.avatar_url" :size="72">{{(profile.name||'我').slice(0,1)}}</el-avatar><input ref="avatarInput" type="file" accept="image/*" hidden @change="chooseAvatar"><el-button :loading="preparing" :disabled="saving" @click="avatarInput.click()">更换头像</el-button></div><label>姓名<input v-model="profile.name" aria-label="姓名" maxlength="100" autocomplete="name" :disabled="saving"></label><el-alert v-if="profileError" :title="profileError" type="warning" :closable="false"/></div>
   <template #footer><el-button :disabled="saving||preparing" @click="closePanel">取消</el-button><el-button type="primary" :loading="saving" :disabled="preparing" @click="saveProfile">保存个人资料</el-button></template>
  </MobileDialog>
  <MobileDialog :model-value="panel==='password'" title="修改密码" :show-close="!changingPassword" :close-on-press-escape="!changingPassword" @update:model-value="v=>{if(!v)closePanel()}">
   <div class="mobile-form"><p class="mobile-muted">新密码至少8位，修改后其他设备需重新登录。</p><label>当前密码<input v-model="password.old_password" aria-label="当前密码" type="password" autocomplete="current-password" :disabled="changingPassword"></label><label>新密码<input v-model="password.new_password" aria-label="新密码" type="password" autocomplete="new-password" :disabled="changingPassword"></label><label>确认新密码<input v-model="password.confirm_password" aria-label="确认新密码" type="password" autocomplete="new-password" :disabled="changingPassword"></label><el-alert v-if="passwordError" :title="passwordError" type="warning" :closable="false"/></div>
   <template #footer><el-button :disabled="changingPassword" @click="closePanel">取消</el-button><el-button type="primary" :loading="changingPassword" @click="savePassword">确认修改密码</el-button></template>
  </MobileDialog>
  <MobileDialog :model-value="panel==='install'" title="添加到手机桌面" mode="compact" @update:model-value="v=>{if(!v)closePanel()}"><div class="mobile-form"><p>苹果 Safari：点击分享，选择“添加到主屏幕”。</p><p>安卓：打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。</p><small class="mobile-muted">首次登录和业务保存需要联网。</small></div><template #footer><el-button type="primary" @click="closePanel">知道了</el-button></template></MobileDialog>
 </div>
</template>
<style scoped>
.mobile-profile-heading{display:flex;align-items:center;gap:14px}.mobile-profile-heading :deep(.el-avatar),.mobile-profile-editor :deep(.el-avatar){flex:none;aspect-ratio:1;border-radius:50%}.mobile-profile-heading>div{display:grid;gap:6px;min-width:0;flex:1}.mobile-profile-heading h2{font-size:19px;margin:0;overflow-wrap:anywhere}.mobile-profile-enterprise{font-size:13px;overflow-wrap:anywhere}.mobile-account-roles{border-top:1px solid var(--el-border-color-light);padding-top:4px}.mobile-account-roles summary{min-height:44px;display:flex;align-items:center;gap:8px;color:var(--el-text-color-secondary);font-size:13px;cursor:pointer}.mobile-account-roles summary::after{content:'展开';margin-left:auto;font-size:12px}.mobile-account-roles[open] summary::after{content:'收起'}.mobile-account-roles p{margin:0;padding-bottom:8px}.mobile-account-menu{border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-bg-color);overflow:hidden}.mobile-account-menu button{display:flex;justify-content:space-between;align-items:center;width:100%;min-height:76px;padding:14px 16px;border:0;border-bottom:1px solid var(--el-border-color-light);background:transparent;color:var(--el-text-color-primary);text-align:left}.mobile-account-menu button:last-child{border-bottom:0}.mobile-account-menu button>span:first-child{display:grid;gap:6px}.mobile-account-menu strong{font-size:15px}.mobile-account-menu small{font-size:12px;color:var(--el-text-color-secondary)}.mobile-account-menu button>span:last-child{font-size:25px;color:var(--el-text-color-placeholder)}.mobile-account-logout{margin:6px 0 0;min-height:46px;width:100%;color:var(--el-color-danger)}.mobile-profile-editor{display:flex;align-items:center;gap:16px;padding:4px 0 12px}
</style>
