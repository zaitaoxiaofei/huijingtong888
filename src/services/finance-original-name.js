// Storage keys remain ASCII; human original names retain Cyrillic and other Unicode.
export function financeOriginalName(value) {
 const name=String(value||'attachment').split(/[/\\]/).pop().replace(/[\x00-\x1f\x7f]/g,'');
 if(!name||name==='.'||name==='..')throw Object.assign(new Error('原始文件名无效，请重新选择文件'),{statusCode:400});
 if([...name].length>255)throw Object.assign(new Error('原始文件名超过255个字符，请缩短后上传'),{statusCode:400});
 return name;
}
