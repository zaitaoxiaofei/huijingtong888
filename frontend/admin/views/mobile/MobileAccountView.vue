<script setup>
import {useAuthStore} from '../../stores/auth.js';
import {useRouter} from 'vue-router';
import {roleLabels} from '../../../../src/shared/permissions.js';
const auth=useAuthStore(),router=useRouter();
async function logout(){await auth.logout();router.replace('/login');}
</script>
<template><div class="mobile-form"><section class="mobile-record"><h3>{{auth.user?.name||auth.user?.username}}</h3><span>当前企业：{{auth.user?.tenant?.name||'未选择'}}</span><span>业务岗位：{{roleLabels(auth.user).join('、')||'按企业授权'}}</span><small class="mobile-muted">权限由企业成员和业务岗位决定。切换企业请通过现有账号入口完成。</small></section><section class="mobile-record"><h3>添加到手机桌面</h3><p>苹果：使用 Safari 打开，点击分享 → 添加到主屏幕。</p><p>安卓：在浏览器菜单中选择“安装应用”或“添加到主屏幕”；具体名称以浏览器为准。</p><small class="mobile-muted">首次登录和库存、采购保存需要联网；不会离线自动修改库存。</small></section><el-button @click="logout">退出登录</el-button></div></template>
