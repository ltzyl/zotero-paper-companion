// SPDX-License-Identifier: AGPL-3.0-only
var PaneCore={
 ego(key,edges){const e=edges.filter(e=>e.source===key||e.target===key);return {keys:new Set([key,...e.flatMap(e=>[e.source,e.target])]),edges:e};},
 needsChinese(text){return !!text?.trim()&&!/[\u3400-\u9fff]/.test(text);},
 canReplace(before,current,translated){return before===current&&!!translated?.trim()&&/[\u3400-\u9fff]/.test(translated);},
 chunks(text,max=1800){const result=[];while(text.length>max){let at=Math.max(text.lastIndexOf('\n',max),text.lastIndexOf('. ',max),text.lastIndexOf('; ',max));if(at<max/2)at=max-1;at++;result.push(text.slice(0,at));text=text.slice(at);}if(text)result.push(text);return result;},
 preview(rect,width,height){return {left:Math.max(8,Math.min(rect.left,width-560)),top:rect.bottom+3,height:Math.max(1,Math.min(height*.65,height-rect.bottom-11))};}
};
