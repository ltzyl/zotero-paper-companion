// SPDX-License-Identifier: AGPL-3.0-only
/** First-run consent and portable paths. No private library fixture is bundled. */
var PublicConfig={
 id:'paper-companion@ltzyl.github.io',
 async initialize(root){this.rootURI=root;this.win=Zotero.getMainWindow();this.stateDir=PathUtils.join(Zotero.Profile.dir,'paper-companion-data');await IOUtils.makeDirectory(this.stateDir,{ignoreExisting:true,permissions:0o700});this.enabled=!!Zotero.Prefs.get('paperCompanion.enabled');this.serviceURL=Zotero.Prefs.get('paperCompanion.serviceURL')||'http://127.0.0.1:8891';this.token=Zotero.Prefs.get('paperCompanion.serviceToken')||'';
  this.menu=this.win.document.createXULElement('menuitem');this.menu.id='paper-companion-setup';this.menu.setAttribute('label','Paper Companion：首次设置与隐私');this.menu.addEventListener('command',()=>this.setup().catch(e=>Services.prompt.alert(this.win,'Paper Companion',String(e.message||e))));this.win.document.getElementById('menu_ToolsPopup')?.append(this.menu);
  this.readerHandler=async({doc,params,append})=>{if(!this.enabled||!params.annotation?.text)return;const wrap=doc.createElement('div'),button=doc.createElement('button'),result=doc.createElement('div');button.textContent='翻译选中文本';result.style.cssText='max-height:240px;overflow:auto;white-space:pre-wrap';wrap.append(button,result);append(wrap);button.addEventListener('click',async()=>{button.disabled=true;result.textContent='翻译中…';try{result.textContent=(await PublicText.api.translate(params.annotation.text)).result;}catch(e){result.textContent='翻译暂不可用，请检查本机服务。';}finally{button.disabled=false;}});};Zotero.Reader.registerEventListener('renderTextSelectionPopup',this.readerHandler,this.id);
 },
 headers(){return {'X-Paper-Companion-Token':this.token};},
 async request(method,path,data,timeout=30000){if(!this.enabled||!this.token)throw new Error('请先在工具菜单完成 Paper Companion 设置');const r=await Zotero.HTTP.request(method,this.serviceURL+path,{timeout,responseType:'json',headers:{...this.headers(),'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return r.response;},
 async setup(){
  const consent=Services.prompt.confirm(this.win,'Paper Companion · 隐私说明','启用后：新论文会自动尝试下载原文；PDF正文、标题、摘要与选中文字会交给免费 Bing 服务翻译。本地总结通过本机 Ollama 生成。\n\n不会上传文库到 GitHub，不收集遥测。已有文献的中文摘要和简记会在后台补充，英文摘要会备份。是否继续设置？');if(!consent)return;
  const {FilePicker}=ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');const fp=new FilePicker();fp.init(this.win,'选择本机服务生成的 connection.json',fp.modeOpen);fp.appendFilter('JSON','*.json');if(await fp.show()!==fp.returnOK)return;
  const config=JSON.parse(await IOUtils.readUTF8(fp.file));if(!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(config.serviceURL)||typeof config.token!=='string'||config.token.length<32)throw new Error('连接文件无效，仅支持本机回环服务');
  const r=await Zotero.HTTP.request('GET',config.serviceURL+'/health',{responseType:'json',timeout:5000,headers:{'X-Paper-Companion-Token':config.token}});if(r.response?.service!=='paper-companion'||r.response.protocol!==1)throw new Error('不是兼容的 Paper Companion 服务');
  const metrics=Services.prompt.confirm(this.win,'可选：期刊指标','是否启用第三方公开期刊数据下载及每周更新？无需账号或密钥，不发送文献列表。数据不是 Zotero 官方数据，也未包含在安装包中；来源可能失效或限制使用。');
  this.serviceURL=config.serviceURL;this.token=config.token;this.enabled=true;Zotero.Prefs.set('paperCompanion.serviceURL',this.serviceURL);Zotero.Prefs.set('paperCompanion.serviceToken',this.token);Zotero.Prefs.set('paperCompanion.metricsEnabled',metrics);Zotero.Prefs.set('paperCompanion.enabled',true);if(!Zotero.Prefs.get('paperCompanion.since'))Zotero.Prefs.set('paperCompanion.since',String(Date.now()));
  await this.onConfigured?.();Services.prompt.alert(this.win,'Paper Companion','已启用。请确保本机服务和 Ollama 正在运行，且已下载 qwen3:4b。图谱等离线功能无需模型；原文与翻译不保证能覆盖付费或扫描版论文。');
 },
 installColumns(){this.columns=[];const existing=this.win.ZoteroPane.itemsView?.getColumns()||[];
  for(const[key,label]of [['titleTranslation','中文标题'],['remark','简记']]){if(existing.some(c=>c.dataKey.endsWith(key)))continue;const id=Zotero.ItemTreeManager.registerColumn({pluginID:this.id,dataKey:key,label,dataProvider:i=>i.isRegularItem()?MetadataCore.getExtra(i.getField('extra'),key):'',zoteroPersist:['width','hidden','sortDirection']});this.columns.push(id);}
 },
 stop(){for(const c of this.columns||[])Zotero.ItemTreeManager.unregisterColumn(c);Zotero.Reader.unregisterEventListener('renderTextSelectionPopup',this.readerHandler);this.menu?.remove();}
};
var PublicText={api:{async translate(text){return PublicConfig.request('POST','/text',{text},180000);}}};
