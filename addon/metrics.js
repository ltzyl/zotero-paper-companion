// SPDX-License-Identifier: AGPL-3.0-only
var PaperMetrics = class {
  async start(owner, data) {
    this.owner=owner;this.window=owner.window;this.alive=true;this.jobs={};this.timers=new Map();this.queue=Promise.resolve();this.columns=[];
    this.path=PathUtils.join(Zotero.Profile.dir,'companion-metrics-state.json');
    this.updater=new PaperMetricsUpdater();
    this.data=await this.updater.load(this,data);
    try{this.jobs=await IOUtils.readJSON(this.path);}catch(_){}
    this.observer=Zotero.Notifier.registerObserver(this,['item'],'paper-local-metrics');
    for(const [key,label,field] of [['localIF','影响因子（本地数据）','if'],['localJCR','JCR（本地数据）','jcr'],['localCAS','中科院分区','cas']]){
      this.columns.push(Zotero.ItemTreeManager.registerColumn({dataKey:key,label,pluginID:'paper-companion@ltzyl.github.io',zoteroPersist:['width','hidden','sortDirection'],dataProvider:item=>{
        if(!this.accepts(item))return '';
        const r=this.jobs[item.id];if(!r)return '待匹配';
        if(r.status==='conflict')return '匹配冲突';if(r.status==='unmatched')return '未匹配';if(r.status==='failed')return '匹配失败';
        return r[field]===null||r[field]===undefined?'—':(field==='cas'?this.data.casYear+' · ':'')+String(r[field]);
      }}));
    }
    this.scan().catch(e=>Zotero.logError(e));
    this.updater.start();
  }
  accepts(item){return !!(item&&!item.deleted&&item.libraryID===Zotero.Libraries.userLibraryID&&item.itemType==='journalArticle');}
  notify(event,type,ids){
    if(!this.alive||type!=='item')return;
    if(['add','modify'].includes(event))for(const id of ids)this.schedule(Number(id));
    if(['delete','trash'].includes(event))for(const id of ids){delete this.jobs[id];this.save().catch(e=>Zotero.logError(e));}
  }
  schedule(id){
    if(this.timers.has(id))this.window.clearTimeout(this.timers.get(id));
    this.timers.set(id,this.window.setTimeout(()=>{this.timers.delete(id);this.enqueue(id);},700));
  }
  enqueue(id,force=false){this.queue=this.queue.catch(e=>Zotero.logError(e)).then(()=>this.process(id,force));return this.queue;}
  async process(id,force=false){
    if(!this.alive||!Object.keys(this.data.records).length)return;
    const item=await Zotero.Items.getAsync(id);if(!this.alive||!item||item.deleted||item.libraryID!==Zotero.Libraries.userLibraryID)return;
    if(!this.accepts(item)){
      if(this.jobs[id]&&item.isRegularItem()){
        const old=item.getField('extra'),clean=MetricsCore.updateExtra(old,{status:'unmatched'},this.data);
        delete this.jobs[id];if(clean!==old){item.setField('extra',clean);await item.saveTx();}await this.save();
      }return;
    }
    const title=item.getField('publicationTitle'),issn=item.getField('ISSN');
    const fingerprint=MetricsCore.fingerprint(title,issn,this.data.version);
    if(!force&&this.jobs[id]?.fingerprint===fingerprint&&this.jobs[id].status!=='failed')return;
    try{
      const result=MetricsCore.match(this.data,issn,title);
      const old=item.getField('extra'),extra=MetricsCore.updateExtra(old,result,this.data);
      this.jobs[id]={...result,fingerprint,key:item.key,journal:title,updated:new Date().toISOString()};
      if(extra!==old){item.setField('extra',extra);await item.saveTx();}
      await this.save();if(!this.alive)return;await Zotero.Notifier.trigger('refresh','item',[id]);
    }catch(e){this.jobs[id]={status:'failed',fingerprint,detail:String(e.message||e).slice(0,150)};await this.save();Zotero.logError(e);}
  }
  async scan(force=false){
    if(this.scanning)return this.scanning;
    this.scanning=(async()=>{
      const search=new Zotero.Search();search.libraryID=Zotero.Libraries.userLibraryID;search.addCondition('itemType','is','journalArticle');
      for(const id of await search.search()){if(!this.alive)break;await this.enqueue(id,force);}
    })();try{await this.scanning;}finally{this.scanning=null;}
  }
  async save(){const snapshot=JSON.stringify(this.jobs);this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>IOUtils.writeUTF8(this.path,snapshot,{tmpPath:this.path+'.tmp'}));await this.saving;}
  status(){const counts={};for(const j of Object.values(this.jobs))counts[j.status]=(counts[j.status]||0)+1;return {localMatching:true,autoUpdate:this.updater?.info(),version:this.data?.version,dataRevision:this.data?.revision,casYear:this.data?.casYear,source:this.data?.sourceURL,counts,scanning:!!this.scanning};}
  async stop(){this.alive=false;if(this.observer)Zotero.Notifier.unregisterObserver(this.observer);for(const t of this.timers.values())this.window.clearTimeout(t);for(const col of this.columns)Zotero.ItemTreeManager.unregisterColumn(col);await this.updater?.stop();await this.queue?.catch(()=>{});await this.saving?.catch(()=>{});}
};
