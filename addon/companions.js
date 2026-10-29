// SPDX-License-Identifier: AGPL-3.0-only
var PaperCompanions=class {
 async start(workflow){
  this.w=workflow;this.alive=true;this.records={};this.nodes=[];this.edges=[];this.queue=Promise.resolve();
  this.path=PathUtils.join(Zotero.Profile.dir,'companion-citations.json');
  try{this.records=JSON.parse(await IOUtils.readUTF8(this.path));}catch(_){}
  this.observer=Zotero.Notifier.registerObserver(this,['item'],'paper-citations');
  this.addMenu('paper-pair','中英双窗口对照（独立翻页）',()=>this.openPair(this.selected()));
  this.addMenu('paper-graph','查看文库引用关系图（箭头：引用者 → 被引用者）',()=>this.openGraph());
  this.context=this.w.window.document.getElementById('zotero-itemmenu');
  if(this.context){const e=this.w.window.document.createXULElement('menuitem');e.id='paper-pair-context';e.setAttribute('label','中英双窗口对照（独立翻页）');e.addEventListener('command',()=>this.openPair(this.selected()));this.context.appendChild(e);}
  this.scanPromise=this.scan().catch(e=>{this.error=String(e);Zotero.logError(e);});
 }
 selected(){let i=this.w.window.ZoteroPane.getSelectedItems()[0];if(i?.parentItemID)i=Zotero.Items.get(i.parentItemID);return i;}
 addMenu(id,label,fn){const d=this.w.window.document,e=d.createXULElement('menuitem');e.id=id;e.setAttribute('label',label);e.addEventListener('command',()=>Promise.resolve(fn()).catch(e=>{Zotero.logError(e);Services.prompt.alert(this.w.window,'论文助手',String(e.message||e));}));d.getElementById('menu_ToolsPopup')?.appendChild(e);}
 async chinese(item){for(const id of item.getAttachments()){const a=Zotero.Items.get(id);if(a&&!a.deleted&&a.isPDFAttachment()&&WorkflowCore.isChinese(a.attachmentFilename||'')){const p=await a.getFilePathAsync();if(p&&await IOUtils.exists(p))return a;}}}
 async openPair(item){
  if(!item?.isRegularItem())throw new Error('请先选择论文条目。');
  const source=await this.w.findSource(item),cn=await this.chinese(item);
  if(!source||source==='review'||!cn){await this.w.enqueue(item);Services.prompt.alert(this.w.window,'中英双窗口','原文或独立中文 PDF 尚未就绪，已加入处理队列。');return;}
  const left=await Zotero.Reader.open(source.id,null,{openInWindow:true,allowDuplicate:true});
  const right=await Zotero.Reader.open(cn.id,null,{openInWindow:true,allowDuplicate:true});
  await Promise.all([left._initPromise,right._initPromise]);
  const s=this.w.window.screen,x=s.availLeft||0,y=s.availTop||0,width=Math.floor(s.availWidth/2),height=s.availHeight;
  left._window.resizeTo(width,height);left._window.moveTo(x,y);right._window.resizeTo(width,height);right._window.moveTo(x+width,y);
  this.lastPair={source:source.key,chinese:cn.key,independentWindows:left._window!==right._window};
 }
 async items(){const s=new Zotero.Search();s.libraryID=Zotero.Libraries.userLibraryID;s.addCondition('deleted','false');return (await Zotero.Items.getAsync(await s.search())).filter(i=>i.isRegularItem()&&!i.deleted);}
 async scan(){this.scanning=true;try{for(const item of await this.items()){if(!this.alive)break;await this.extract(item);}await this.rebuild();}finally{this.scanning=false;}}
 async extract(item){
  const attachments=item.getAttachments().map(id=>Zotero.Items.get(id)).filter(a=>a&&!a.deleted&&a.isPDFAttachment()&&WorkflowCore.isSource(a.getField('title'),a.attachmentFilename||''));
  const fingerprint='v2:'+attachments.map(a=>a.key+':'+a.dateModified).join('|');
  if(this.records[item.key]?.fingerprint===fingerprint)return;
  let combined={dois:[],text:'',status:'no-original-pdf'};
  for(const a of attachments){try{const result=await Zotero.PDFWorker.getFullText(a.id,500);const head=result.text.slice(0,2000);if(/(?:^|\n)\s*(?:supplemental|supplementary|supporting)\s+(?:information|material|data)\s*(?:\n|$)/im.test(head))continue;const r=ReferenceCore.extract(result.text);if(r.status==='parsed'){combined={...r,attachment:a.key,pages:result.totalPages,partial:result.totalPages>500};break;}}catch(e){combined.status='extraction-failed';}}
  this.records[item.key]={...combined,fingerprint,checked:Date.now()};
 }
 async rebuild(){
  if(!this.alive)return;
  const items=await this.items();this.nodes=items.map(i=>({key:i.key,title:i.getField('title'),titleZh:MetadataCore.getExtra(i.getField('extra'),'titleTranslation'),doi:ReferenceCore.doi(i.getField('DOI')),collections:i.getCollections().map(id=>Zotero.Collections.get(id)?.name).filter(Boolean),focus:WorkflowCore.inCollections(i.getCollections(),this.w.scope)}));
  const valid=new Set(this.nodes.map(n=>n.key));for(const key of Object.keys(this.records))if(!valid.has(key))delete this.records[key];
  this.edges=ReferenceCore.edges(this.nodes,this.records);
  await IOUtils.writeUTF8(this.path,JSON.stringify(this.records),{tmpPath:this.path+'.tmp'});
  this.w.readingPane?.refresh();
  const {NetUtil}=ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
  const channel=NetUtil.newChannel({uri:PublicConfig.rootURI+'citation-graph.html',loadUsingSystemPrincipal:true});
  const template=await Zotero.File.getContentsAsync(channel);
  const payload=JSON.stringify({nodes:this.nodes,edges:this.edges,updated:new Date().toLocaleString(),coverage:Object.fromEntries(Object.entries(this.records).map(([k,v])=>[k,v.status]))}).replace(/</g,'\\u003c');
  this.graphPath=PathUtils.join(this.w.root,'文库引用关系图.html');await IOUtils.writeUTF8(this.graphPath,template.replace('/*GRAPH_DATA*/',payload),{tmpPath:this.graphPath+'.tmp'});
 }
 async notify(event,type,ids){if(!this.alive||!['add','modify','delete','trash'].includes(event))return;for(const id of ids){const i=Zotero.Items.get(Number(id));if(i?.isNote())continue;const p=i?.parentItemID?Zotero.Items.get(i.parentItemID):i;if(p?.isRegularItem())this.pending=(this.pending||new Set()).add(p.id);}
  if(this.timer)this.w.window.clearTimeout(this.timer);
  this.timer=this.w.window.setTimeout(()=>{this.queue=this.queue.catch(()=>{}).then(async()=>{await this.scanPromise;const ids=[...(this.pending||[])];this.pending?.clear();for(const id of ids){const i=Zotero.Items.get(id);if(i&&!i.deleted)await this.extract(i);}await this.rebuild();});},5000);
 }
 async openGraph(){await this.scanPromise;await this.queue;Zotero.launchURL(Services.io.newFileURI(Zotero.File.pathToFile(this.graphPath)).spec);}
 status(){return {scanning:this.scanning,nodes:this.nodes.length,edges:this.edges.length,coverage:Object.values(this.records).reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{}),lastPair:this.lastPair,error:this.error};}
 async stop(){this.alive=false;if(this.observer)Zotero.Notifier.unregisterObserver(this.observer);if(this.timer)this.w.window.clearTimeout(this.timer);for(const id of ['paper-pair','paper-graph','paper-pair-context'])this.w.window.document.getElementById(id)?.remove();await this.scanPromise;await this.queue;}
};
