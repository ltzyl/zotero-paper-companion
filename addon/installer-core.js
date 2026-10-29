// SPDX-License-Identifier: AGPL-3.0-only
/** Pure validation and setup lifecycle; native I/O is supplied by installer.js. */
var PaperInstallerCore=(()=>{
 const SERVICE_FILES=['runtime-manifest.json','python-downloads.json','engine-requirements.lock','manager.py','server.py','bing_compat.py','engine_probe.py'];
 function relative(value){return typeof value==='string'&&value.length>0&&!/[\\\x00-\x20]/.test(value)&&!value.startsWith('/')&&!value.split('/').some(x=>!x||x==='.'||x==='..');}
 function https(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;}catch(_){return false;}}
 function validateManifest(m){
  if(!m||m.schema!==1||m.platform?.os!=='darwin'||m.platform.arch!=='arm64'||m.platform.minVersion!=='14'||!Number.isSafeInteger(m.requiredFreeBytes)||m.requiredFreeBytes<1)throw new Error('安装资源清单不兼容');
  for(const item of [m.uv,m.python,m.ollama])if(!item||!https(item.url)||!/^[a-f0-9]{64}$/.test(item.sha256)||!relative(item.executable))throw new Error('安装资源校验信息无效');
  if(!/^\d+\.\d+\.\d+$/.test(m.python.version)||m.python.request!==`cpython-${m.python.version}-macos-aarch64-none`||m.python.downloadsFile!=='python-downloads.json'||!relative(m.uv.archiveRoot)||m.uv.archiveRoot.includes('/')||m.uv.executable!==m.uv.archiveRoot+'/uv')throw new Error('Python 或安装器版本信息无效');
  return m;
 }
 function validateArchive(names,types,uv){
  if(!Array.isArray(names)||!names.length||names.length>3||types.length!==names.length)throw new Error('安装器压缩包目录无效');
  const allowed=new Map([[uv.archiveRoot,'d'],[uv.archiveRoot+'/uv','-'],[uv.archiveRoot+'/uvx','-']]),seen=new Set();
  names.forEach((raw,i)=>{const name=raw.endsWith('/')?raw.slice(0,-1):raw;if(!relative(name)||seen.has(name)||allowed.get(name)!==types[i])throw new Error('安装器压缩包含不安全的文件');seen.add(name);});
  if(!seen.has(uv.executable))throw new Error('安装器压缩包缺少程序');return true;
 }
 function loopback(value){if(typeof value!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value))return false;const port=Number(value.slice(value.lastIndexOf(':')+1));return port<=65535;}
 function validateConnection(c){if(!c||c.managed!==true||c.protocol!==2||!loopback(c.serviceURL)||!loopback(c.modelURL)||typeof c.token!=='string'||!/^[a-zA-Z0-9_-]{32,256}$/.test(c.token)||!/^[a-f0-9]{48}$/.test(c.instance))throw new Error('本机服务连接信息无效');return c;}
 function validateReady(c,h){validateConnection(c);if(!h||h.status!=='ok'||h.service!=='paper-companion'||h.protocol!==2||h.instance!==c.instance||h.modelURL!==c.modelURL||h.ready!==true||!['engine','model','assets'].every(k=>h.components?.[k]===true))throw new Error('本机服务身份或组件检查尚未通过');return true;}
 function managedRoot(home,digest){if(typeof home!=='string'||!home.startsWith('/')||home==='/'||home.split('/').some(x=>x==='..'||x==='.')||!/^[a-f0-9]{32,64}$/.test(digest))throw new Error('安装目录无效');return home.replace(/\/$/,'')+'/.paper-companion/managed-'+digest.slice(0,24);}
 function validatePlatform(p){if(p.os!=='Darwin'||!/^\d+(?:\.\d+)*$/.test(p.version)||Number(p.version.split('.')[0])<14||p.arm64!==true)throw new Error('自动设置需要 macOS 14 或更新版本及 Apple 芯片 Mac');return true;}
 class Controller{
  constructor(native,config,root,manifest){this.native=native;this.config=config;this.root=root;this.manifest=validateManifest(manifest);this.status={phase:'idle',state:'idle',detail:''};this.listeners=new Set();this.busy=null;this.session=null;this.runtime=null;}
  subscribe(listener){this.listeners.add(listener);listener(this.status);return()=>this.listeners.delete(listener);}
  update(value){this.status={...value};for(const listener of this.listeners){try{listener(this.status);}catch(_){}}}
  start({metrics=false}={}){return this.operation(true,metrics);}
  ensureRunning(){return this.operation(false,false);}
  operation(install,metrics){
   if(this.busy)return this.busy;
   const session={install,cancelled:false,children:new Set(),requests:new Set(),check(){if(this.cancelled)throw new Error('设置已取消');}};this.session=session;
   const emit=value=>{session.check();this.update(value);};
   this.busy=(async()=>{
    try{
     emit({phase:'checking',state:'running',detail:'检查 Mac 和安装目录'});validatePlatform(await this.native.environment(session));session.check();
     await this.native.prepare(session);await this.native.acquire(session);session.check();
     if(install){await this.native.bootstrap(session,emit);session.check();await this.native.install(session,emit);}
     else {if(!await this.native.installed(session))throw new Error('本机组件尚未安装，请打开自动设置');await this.native.copyResources(session);}
     session.check();emit({phase:'validate',state:'running',detail:'检查本机服务、翻译组件和模型'});
     const connection=await this.native.connect(session,emit);session.check();validateConnection(connection);
     const health=await this.native.health(connection,session);session.check();validateReady(connection,health);
     const result={...connection,managedRoot:this.root};
     if(install){session.activating=true;emit({phase:'validate',state:'running',cancellable:false,detail:'正在启用已配置的组件'});await this.config.activateConnection(result,{managed:true,metrics:!!metrics});}
     if(session.ownsRuntime)this.runtime=session;
     emit({phase:'ready',state:'completed',detail:'翻译组件和本地模型已就绪，可以使用'});return result;
    }catch(error){
     await this.native.cancel(session);
     this.update({phase:session.cancelled?'cancelled':'error',state:session.cancelled?'cancelled':'failed',detail:session.cancelled?'设置已取消，已下载的组件会保留供重试':String(error.message||'设置失败，请重试').slice(0,240)});throw error;
    }finally{if(session.lock)await this.native.release(session);if(this.session===session)this.session=null;this.busy=null;}
   })();return this.busy;
  }
  async cancel(){const session=this.session;if(!session||session.activating)return;session.cancelled=true;await this.native.cancel(session);}
  async stop(){await this.cancel();await this.busy?.catch(()=>{});if(this.runtime){this.runtime.cancelled=true;await this.native.cancel(this.runtime);this.runtime=null;}}
 }
 return {SERVICE_FILES,relative,validateManifest,validateArchive,validateConnection,validateReady,managedRoot,validatePlatform,Controller};
})();
