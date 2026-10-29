// SPDX-License-Identifier: AGPL-3.0-only
var PaperMetricsUpdater = class {
  async load(metrics, bundled){
    this.metrics=metrics;this.window=metrics.window;this.base=bundled;this.alive=true;this.requests=new Set();this.state={status:'never'};
    this.dataPath=PathUtils.join(Zotero.Profile.dir,'companion-metrics-data.json');this.statePath=PathUtils.join(Zotero.Profile.dir,'companion-metrics-update.json');
    try{this.state=await IOUtils.readJSON(this.statePath);if(this.state.lastAttempt>Date.now())this.state.lastAttempt=0;}catch(_){}
    for(const path of [this.dataPath,this.dataPath+'.previous']){try{const cache=await IOUtils.readJSON(path);MetricsUpdateCore.validate(cache,bundled);return cache;}catch(_){}}
    return bundled;
  }
  start(){this.first=this.window.setTimeout(()=>this.check(),15000);this.interval=this.window.setInterval(()=>this.check(),3600000);}
  async saveState(){await IOUtils.writeUTF8(this.statePath,JSON.stringify(this.state),{tmpPath:this.statePath+'.tmp'});}
  async get(url,json=true){
    let xhr;
    try{
      const response=await Zotero.HTTP.request('GET',url,{anon:true,responseType:'text',timeout:30000,errorDelayMax:0,headers:{Accept:json?'application/json':'text/html'},requestObserver:r=>{
        xhr=r;this.requests.add(r);r.addEventListener('progress',e=>{if(e.loaded>15000000||e.total>15000000)r.abort();});
      }});
      if(!this.alive)throw new Error('更新已停止');
      if(response.responseURL&&new this.window.URL(response.responseURL).host!==new this.window.URL(url).host)throw new Error('数据源重定向到了其他站点，保留旧数据');
      const text=response.responseText;if(text.length>15000000)throw new Error('下载数据过大');return json?JSON.parse(text):text;
    }finally{if(xhr)this.requests.delete(xhr);}
  }
  check(force=false){
    if(!this.alive)return Promise.resolve(this.state);
    if(this.pending)return this.pending;
    if(!force&&!MetricsUpdateCore.due(this.state))return Promise.resolve(this.state);
    this.pending=this.run().finally(()=>{this.pending=null;});return this.pending;
  }
  async run(){
    this.state={...this.state,lastAttempt:Date.now(),status:'checking',error:''};
    try{
      await this.saveState();
      const commits=await this.get('https://api.github.com/repos/scigreat/addon/commits?per_page=1');const commit=commits?.[0];
      if(!this.alive)return this.state;
      if(!/^[a-f0-9]{40}$/.test(commit?.sha))throw new Error('免费数据源未返回有效提交，可能暂不可用');
      const previousDate=Date.parse(this.metrics.data.sourceDate||this.metrics.data.version.slice(0,10));
      if(Date.parse(commit.commit?.committer?.date)<previousDate)throw new Error('远程数据版本早于本地，拒绝降级');
      const prefix='https://raw.githubusercontent.com/scigreat/addon/'+commit.sha+'/';
      const [titles,journals,page]=await Promise.all([this.get(prefix+'a_jtitle.json'),this.get(prefix+'a_jssn.json'),this.get('https://www.scigreat.com/s/app/?t=zotbox-vip',false)]);
      if(!this.alive)return this.state;
      const next=MetricsUpdateCore.convert(titles,journals,commit,page,this.base);
      // CAS category semantics must not be silently relabelled when the public page only changes its year.
      if(next.casYear!==this.metrics.data.casYear){
        const ids=Object.keys(next.records);const changed=ids.some(id=>next.records[id].D!==this.metrics.data.records[id]?.D);
        if(!changed)throw new Error('来源年份变化但中科院数据未变化，暂不替换');
      }
      await this.metrics.scanning;await this.metrics.queue;
      if(!this.alive)return this.state;
      const changed=MetricsUpdateCore.content(next)!==MetricsUpdateCore.content(this.metrics.data);
      if(!changed)next.version=this.metrics.data.version;
      if(changed)await IOUtils.writeUTF8(this.dataPath+'.previous',JSON.stringify(this.metrics.data),{tmpPath:this.dataPath+'.previous.tmp'});
      if(!this.alive)return this.state;
      await IOUtils.writeUTF8(this.dataPath,JSON.stringify(next),{tmpPath:this.dataPath+'.tmp'});
      if(!this.alive)return this.state;
      this.metrics.data=next;
      if(changed)await this.metrics.scan(true);
      this.state={...this.state,status:changed?'updated':'current',lastSuccess:Date.now(),revision:commit.sha,dataVersion:next.version,casYear:next.casYear,error:''};
      await this.saveState();
    }catch(e){
      if(this.alive){this.state={...this.state,status:'failed',error:String(e.message||e).slice(0,240)};try{await this.saveState();}catch(_){}Zotero.logError(e);}
    }
    return this.state;
  }
  info(){const s=this.state;return {...s,enabled:true,checkEveryDays:7,retryAfterDays:1,requiresAccount:false,nextCheck:s.lastAttempt?new Date(s.lastAttempt+(s.status==='failed'?86400000:604800000)).toISOString():null};}
  show(){const s=this.state,labels={never:'尚未检查',checking:'正在检查',current:'与公开源数据一致',updated:'已更新并重新匹配',failed:'更新失败，保留现有数据'};Services.prompt.alert(this.window,'期刊数据自动更新',`当前数据版本：${this.metrics.data.version}\n中科院分区年份：${this.metrics.data.casYear}\n状态：${labels[s.status]||s.status}\n最近检查：${s.lastAttempt?new Date(s.lastAttempt).toLocaleString():'无'}\n每7天自动检查；失败后1天重试。无需账号或密钥。${s.error?'\n原因：'+s.error:''}`);}
  async stop(){this.alive=false;this.window.clearTimeout(this.first);this.window.clearInterval(this.interval);for(const r of this.requests)try{r.abort();}catch(_){}await this.pending;}
};
