// SPDX-License-Identifier: AGPL-3.0-only
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'../addon');
test('first install does not start processing; metrics settings apply immediately',async()=>{
 const prefs={},events=[];
 const s={Zotero:{initializationPromise:Promise.resolve(),uiReadyPromise:Promise.resolve(),Prefs:{get:k=>prefs[k]}},Services:{scriptloader:{loadSubScript(file,scope){
  if(file.endsWith('/public-config.js'))scope.PublicConfig={enabled:false,initialize:async()=>{},installColumns:()=>{}};
  if(file.endsWith('/installer.js'))scope.PaperInstaller={initialize:async()=>{},stop:async()=>{}};
  if(file.endsWith('/workflow.js'))scope.PaperWorkflow=class{async start(){events.push('start');}async showColumns(){}async stop(){}};
  if(file.endsWith('/metrics.js'))scope.PaperMetrics=class{async start(){events.push('metrics-start');}async stop(){events.push('metrics-stop');}};
  for(const [fileName,key] of [['companions','PaperCompanions'],['reading-pane','PaperReadingPane'],['enrichment','PaperEnrichment']])if(file.endsWith('/'+fileName+'.js'))scope[key]=class{async start(){}};
 }}},IOUtils:{},PathUtils:{},Components:{},ChromeUtils:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'bootstrap.js'),'utf8'),s);
 await s.startup({rootURI:'test/'});assert.deepEqual(events,[]);
 await s.config.onConfigured();assert.deepEqual(events,['start']);
 prefs['paperCompanion.metricsEnabled']=true;await s.config.onConfigured();assert.deepEqual(events,['start','metrics-start']);
 prefs['paperCompanion.metricsEnabled']=false;await s.config.onConfigured();assert.deepEqual(events,['start','metrics-start','metrics-stop']);assert.equal(s.workflow.metrics,null);
});
test('Ollama transport failure is marked retryable',async()=>{
 const s={PublicConfig:{modelURL:'http://127.0.0.1:12345',localURL:x=>x},Zotero:{HTTP:{request:async()=>{throw new Error('Connection refused');}}}};vm.runInNewContext(fs.readFileSync(path.join(root,'metadata.js'),'utf8'),s);
 await assert.rejects(new s.PaperMetadata().request('GET','/api/tags'),e=>e.temporarilyUnavailable===true);
});
test('fictional demonstration script parses without user data',()=>{const html=fs.readFileSync(path.join(__dirname,'../examples/demo.html'),'utf8');for(const [,js] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(js);assert.ok(!html.includes('zotero://select'));});
test('attachment rows have an empty summary cell without an item lookup',()=>{
 const s={Zotero:{Items:{get:()=>{throw new Error('Empty identifier must not be looked up');}}}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'metadata.js'),'utf8'),s);
 const cell={};const result=new s.PaperMetadata().renderSummary('',{className:'summary'},{createElement:()=>cell});assert.equal(result,cell);
});
