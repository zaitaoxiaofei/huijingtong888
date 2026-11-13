import {defineAsyncComponent,defineComponent,h,markRaw} from 'vue';
import ProductPlatformModule from '../components/ProductPlatformModule.vue';
export function productPlatformModule(ozonLoader,wbLoader,module,wbPath='/wb/listing'){
 const ozon=markRaw(defineAsyncComponent(ozonLoader)),wb=markRaw(defineAsyncComponent(wbLoader));
 return defineComponent({name:'ProductPlatform'+module,setup:()=>()=>h(ProductPlatformModule,{ozon,wb,module,wbPath})});
}
