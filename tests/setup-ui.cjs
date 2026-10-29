// SPDX-License-Identifier: AGPL-3.0-only
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 const elements=new Map(),events=new Map(),counts={cancel:0,closed:0,unsubscribe:0};
 const document={getElementById(id){if(!elements.has(id))elements.set(id,{checked:false,listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},removeAttribute(){}});return elements.get(id);},querySelectorAll:()=>[]};
 const installer={status:{phase:'model',state:'running',detail:'下载模型'},config:{},subscribe(fn){fn(this.status);return()=>counts.unsubscribe++;},async cancel(){counts.cancel++;}};
 const window={arguments:[{installer}],addEventListener:(name,fn)=>events.set(name,fn),close(){counts.closed++;events.get('unload')?.();}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../addon/setup-ui.js'),'utf8'),{window,document});return {document,events,counts};
}
test('setup binds after DOM is ready and closing keeps the download in background',()=>{
 const f=fixture();assert.equal(f.document.getElementById('close').listeners.click,undefined);f.events.get('DOMContentLoaded')();assert.equal(f.document.getElementById('close').textContent,'后台继续');f.document.getElementById('close').listeners.click();assert.deepEqual(f.counts,{cancel:0,closed:1,unsubscribe:1});
});
test('explicit cancel still stops setup',async()=>{
 const f=fixture();f.events.get('DOMContentLoaded')();await f.document.getElementById('cancel').listeners.click();assert.equal(f.counts.cancel,1);assert.equal(f.document.getElementById('cancel').disabled,false);
});
