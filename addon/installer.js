// SPDX-License-Identifier: AGPL-3.0-only
/** Native Zotero bootstrap. Every child is launched with an argument array. */
var PaperInstallerNative=class{
 constructor(owner){this.owner=owner;this.win=owner.win;}
 get core(){return this.owner.core;}
 get root(){return this.owner.root;}
 get manifest(){return this.owner.manifest;}
 path(...parts){return PathUtils.join(this.root,...parts);}
 file(path){const file=Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);file.initWithPath(path);return file;}
 async digest(bytes){return Array.from(new Uint8Array(await this.win.crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');}
 async verifyBytes(bytes,expected){if(await this.digest(bytes)!==expected)throw new Error('下载资源校验失败，请重试');return true;}
 async readResource(name){
  if(!this.core.SERVICE_FILES.includes(name))throw new Error('安装资源不在允许列表中');
  const {NetUtil}=ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
  return new Promise((resolve,reject)=>NetUtil.asyncFetch({uri:this.owner.rootURI+'service/'+name,loadUsingSystemPrincipal:true},(stream,status)=>{
   try{if(!Components.isSuccessCode(status))throw new Error('安装包中的本机组件无法读取');const size=stream.available();if(size>4*1024*1024)throw new Error('安装资源超出大小限制');resolve(NetUtil.readInputStreamToString(stream,size,{charset:'UTF-8'}));}catch(error){reject(error);}finally{stream?.close();}
  }));
 }
 isLink(file){try{return file.isSymlink();}catch(error){if(file.exists())throw error;return false;}}
 async safeDirectory(path){const f=this.file(path);if(this.isLink(f))throw new Error('安装目录包含符号链接，无法安全继续');await IOUtils.makeDirectory(path,{ignoreExisting:true,permissions:0o700});if(this.file(path).isSymlink())throw new Error('安装目录发生变化');await IOUtils.setPermissions(path,0o700);}
 async safeFile(path){const f=this.file(path);if(this.isLink(f)||(f.exists()&&!f.isFile()))throw new Error('安装文件路径不安全');}
 environmentValues(){return {PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:Services.dirsvc.get('Home',Components.interfaces.nsIFile).path,TMPDIR:this.path('tmp'),LANG:'en_US.UTF-8',PYTHONNOUSERSITE:'1',PYTHONUNBUFFERED:'1',MACOSX_DEPLOYMENT_TARGET:'14.0',UV_NO_CONFIG:'1',UV_CACHE_DIR:this.path('cache','uv'),UV_PYTHON_INSTALL_DIR:this.path('python'),UV_PYTHON_DOWNLOADS_JSON_URL:Services.io.newFileURI(this.file(PathUtils.join(this.owner.resources,'python-downloads.json'))).spec};}
 async spawn(session,command,args=[],{env={},cwd}={}){
  session.check();const {Subprocess}=ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
  const process=await Subprocess.call({command,arguments:args,environment:{...this.environmentValues(),...env},environmentAppend:false,stderr:'stdout',...(cwd?{workdir:cwd}:{})});
  const handle={process,exit:null,tail:'',outputBytes:0};session.children.add(handle);
  handle.done=(async()=>{
   const output=(async()=>{let chunk;while((chunk=await process.stdout.readString())!==''){handle.outputBytes+=chunk.length;handle.tail=(handle.tail+chunk).slice(-65536);}})();
   const result=await process.wait();await output;handle.exit=result.exitCode;session.children.delete(handle);return result;
  })();
  // A cancelled setup may have been awaiting creation of this exact child.
  if(session.cancelled){await process.kill(1000).catch(()=>{});session.check();}
  return handle;
 }
 async command(session,command,args=[],options={}){
  const handle=await this.spawn(session,command,args,options);let timedOut=false;
  const timer=this.win.setTimeout(()=>{timedOut=true;handle.process.kill(1000).catch(()=>{});},options.timeout||120000);
  try{await handle.done;session.check();if(timedOut)throw new Error('本机组件操作超时，请重试');if(options.outputLimit&&handle.outputBytes>options.outputLimit)throw new Error('本机组件输出超出安全限制');if(handle.exit!==0)throw new Error('本机组件操作未完成，请重试或查看本机 runtime.log');return handle.tail;}finally{this.win.clearTimeout(timer);}
 }
 async environment(session){
  // uname reports the translated process architecture under Rosetta; sysctl does not.
  const os=Services.appinfo.OS;if(os!=='Darwin')return {os,version:'0',arm64:false};
  const version=(await this.command(session,'/usr/bin/sw_vers',['-productVersion'])).trim();
  const arm64=(await this.command(session,'/usr/sbin/sysctl',['-n','hw.optional.arm64'])).trim()==='1';return {os,version,arm64};
 }
 async prepare(session){
  session.check();const home=Services.dirsvc.get('Home',Components.interfaces.nsIFile).path;
  await this.safeDirectory(PathUtils.join(home,'.paper-companion'));await this.safeDirectory(this.root);if(session.install&&!await this.installed()&&this.file(this.root).diskSpaceAvailable<this.manifest.requiredFreeBytes)throw new Error('磁盘空间不足，请至少保留 12 GiB 可用空间后重试');
  for(const name of ['home','tmp','cache','tools','resources'])await this.safeDirectory(this.path(name));
 }
 async acquire(session){
  const lock=this.path('setup.lock');await this.safeFile(this.path('current.json'));
  if(await IOUtils.exists(lock)){
   if(this.file(lock).isSymlink()||!this.file(lock).isDirectory())throw new Error('设置锁文件无效');
   let owner;try{await this.safeFile(PathUtils.join(lock,'owner.json'));owner=JSON.parse(await IOUtils.readUTF8(PathUtils.join(lock,'owner.json')));}catch(_){const info=await IOUtils.stat(lock);if(Date.now()-info.lastModified<300000)throw new Error('另一个自动设置正在启动，请稍后重试');}
   if(owner){
    if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.id!=='string')throw new Error('设置锁信息无效');
    // Only probe the historical owner; never signal or terminate an unowned PID.
    const probe=await this.spawn(session,'/bin/kill',['-0',String(owner.pid)]);await probe.done;
    if(probe.exit===0)throw new Error('另一个自动设置正在运行，请稍后重试');
   }
   await IOUtils.remove(lock,{recursive:true});
  }
  session.check();try{await IOUtils.makeDirectory(lock,{permissions:0o700,ignoreExisting:false});}catch(_){throw new Error('另一个自动设置正在运行，请稍后重试');}
  session.lock=true;session.id=this.win.crypto.randomUUID();
  await IOUtils.writeUTF8(PathUtils.join(lock,'owner.json'),JSON.stringify({id:session.id,pid:Services.appinfo.processID}),{permissions:0o600});
 }
 async release(session){
  const lock=this.path('setup.lock');try{const owner=JSON.parse(await IOUtils.readUTF8(PathUtils.join(lock,'owner.json')));if(owner.id===session.id)await IOUtils.remove(lock,{recursive:true});}catch(_){}session.lock=false;
 }
 async copyResources(session){
  await this.safeDirectory(this.owner.resources);
  for(const name of this.core.SERVICE_FILES){session.check();const target=PathUtils.join(this.owner.resources,name);await this.safeFile(target);await IOUtils.writeUTF8(target,this.owner.sources[name],{permissions:0o600});}
 }
 async download(session,resource,target,emit){
  let request;session.check();
  try{
   const response=await Zotero.HTTP.request('GET',resource.url,{responseType:'arraybuffer',timeout:1200000,anon:true,errorDelayMax:0,logBodyLength:0,cancellerReceiver:cancel=>{request={abort:cancel};session.requests.add(request);if(session.cancelled)cancel();},requestObserver:xhr=>{
    xhr.addEventListener('progress',event=>{if(event.loaded>64*1024*1024){xhr.abort();return;}if(!session.cancelled)emit({phase:'uv',state:'running',detail:'下载安装器',completed:event.loaded,...(event.lengthComputable?{total:event.total}:{})});});if(session.cancelled)xhr.abort();
   }});
   session.check();if(response.responseURL&&!response.responseURL.startsWith('https://'))throw new Error('下载必须使用加密连接');
   const bytes=new Uint8Array(response.response);if(bytes.length>64*1024*1024)throw new Error('安装器下载大小超出限制');await this.verifyBytes(bytes,resource.sha256);session.check();await this.safeFile(target);await IOUtils.write(target,bytes,{permissions:0o600});
  }catch(error){session.check();throw new Error(error.message?.includes('校验')?'下载资源校验失败，请重试':'安装器下载未完成，请检查网络后重试');}finally{if(request)session.requests.delete(request);}
 }
 async bootstrap(session,emit){
  await this.copyResources(session);session.check();const uv=this.owner.uv,uvInfo=this.manifest.uv;
  await this.safeDirectory(PathUtils.join(this.root,'tools',uvInfo.version));
  let uvReady=false;if(await IOUtils.exists(uv)){await this.safeFile(uv);const marker=this.path('tools',uvInfo.version,'archive.sha256');await this.safeFile(marker);uvReady=await IOUtils.exists(marker)&&(await IOUtils.readUTF8(marker)).trim()===uvInfo.sha256;}
  if(!uvReady){
   emit({phase:'uv',state:'running',detail:'下载并校验安装器'});const archive=this.path('cache','uv-'+uvInfo.version+'.tar.gz');
   if(await IOUtils.exists(archive)){await this.safeFile(archive);try{await this.verifyBytes(await IOUtils.read(archive),uvInfo.sha256);}catch(_){await IOUtils.remove(archive);}}
   if(!await IOUtils.exists(archive))await this.download(session,uvInfo,archive,emit);
   const names=(await this.command(session,'/usr/bin/tar',['-tzf',archive],{outputLimit:65536})).trimEnd().split('\n');
   const listing=(await this.command(session,'/usr/bin/tar',['-tvzf',archive],{outputLimit:65536})).trimEnd().split('\n');
   this.core.validateArchive(names,listing.map(line=>line[0]),uvInfo);
   const target=this.path('tools',uvInfo.version);await this.safeDirectory(PathUtils.join(target,uvInfo.archiveRoot));await this.command(session,'/usr/bin/tar',['-xzf',archive,'-C',target,'--no-same-owner','--no-same-permissions']);
   await this.safeFile(uv);await IOUtils.setPermissions(uv,0o700);await IOUtils.writeUTF8(PathUtils.join(target,'archive.sha256'),uvInfo.sha256,{permissions:0o600});
  }
  session.check();emit({phase:'python',state:'running',detail:'下载并配置独立 Python，首次使用可能需要几分钟'});
  const python=this.owner.python;
  if(!await IOUtils.exists(python))await this.command(session,uv,['venv','--managed-python','--python',this.manifest.python.request,this.path('bootstrap-venv')],{timeout:1200000});
  if(!await IOUtils.exists(python))throw new Error('Python 安装尚未完成，请重试');
  const version=(await this.command(session,python,['-I','-c','import platform; print(platform.python_version()); print(platform.machine())'])).trim().split('\n');
  if(version[0]!==this.manifest.python.version||version[1]!=='arm64')throw new Error('独立 Python 版本或架构不符合要求');
 }
 async installed(){
  try{const pointer=JSON.parse(await IOUtils.readUTF8(this.path('current.json')));if(!/^[a-f0-9]{24}$/.test(pointer.version))return false;const ready=JSON.parse(await IOUtils.readUTF8(this.path('staging',pointer.version,'validated.json')));return ready.version===pointer.version&&ready.fingerprint===this.owner.version&&ready.modelDigest===this.manifest.model.digest&&ready.python===this.manifest.python.version&&await IOUtils.exists(this.owner.python);}catch(_){return false;}
 }
 args(command){const proxy=this.core.validateDownloadProxy(this.owner.config?.downloadProxy||'');return [PathUtils.join(this.owner.resources,'manager.py'),'--root',this.root,'--uv',this.owner.uv,'--resources',this.owner.resources,'--parent-pid',String(Services.appinfo.processID),...(proxy?['--download-proxy',proxy]:[]),command];}
 async progress(session,emit){
  try{session.check();const info=JSON.parse(await IOUtils.readUTF8(this.path('progress.json')));if(['engine','assets','ollama','model','validate'].includes(info.phase)&&info.status==='running'){
   const labels={engine:'安装翻译组件（自动选择下载源）',assets:'下载 PDF 字体和版面识别资源',ollama:'安装本地模型运行组件',model:'下载本地总结模型',validate:'检查翻译组件和本地总结模型'};
   emit({phase:info.phase,state:'running',detail:labels[info.phase],...(Number.isSafeInteger(info.completed)&&info.completed>=0?{completed:info.completed}:{}),...(Number.isSafeInteger(info.total)&&info.total>0?{total:info.total}:{})});
  }}catch(_){}
 }
 async install(session,emit){
  if(await this.installed())return;
  emit({phase:'engine',state:'running',detail:'安装翻译组件'});const child=await this.spawn(session,this.owner.python,this.args('install'),{cwd:this.root});const deadline=Date.now()+7200000;
  while(child.exit===null){session.check();if(Date.now()>deadline){await child.process.kill(1000);throw new Error('自动设置超时，请重试');}await this.progress(session,emit);await this.delay(600);}
  await child.done;session.check();if(child.exit!==0){let detail='翻译组件或模型安装未完成，请重试';try{const p=JSON.parse(await IOUtils.readUTF8(this.path('progress.json')));if(p.status==='failed'&&/Insufficient free disk/.test(p.detail))detail='磁盘空间不足，请至少保留 12 GiB 可用空间后重试';else if(p.detail==='DOWNLOAD_PROXY_REQUIRED')detail='当前网络使用了代理虚拟 IP，请展开高级设置，填写本机 HTTP 代理后重试';}catch(_){}throw new Error(detail);}
  if(!await this.installed())throw new Error('本机组件验证尚未完成，请重试');
 }
 delay(ms){return new Promise(resolve=>this.win.setTimeout(resolve,ms));}
 async connection(session){
  session.check();await this.safeFile(this.path('connection.json'));const c=JSON.parse(await IOUtils.readUTF8(this.path('connection.json')));this.core.validateConnection(c);return c;
 }
 async health(connection,session){
  this.core.validateConnection(connection);session.check();let request;
  try{const result=await Zotero.HTTP.request('GET',connection.serviceURL+'/health',{responseType:'json',timeout:5000,errorDelayMax:0,followRedirects:false,noCache:true,anon:true,logBodyLength:0,headers:{'X-Paper-Companion-Token':connection.token},cancellerReceiver:cancel=>{request={abort:cancel};session.requests.add(request);if(session.cancelled)cancel();}});session.check();return result.response;}
  finally{if(request)session.requests.delete(request);}
 }
 async connect(session,emit){
  let previous;try{previous=await this.connection(session);this.core.validateReady(previous,await this.health(previous,session));return previous;}catch(_){session.check();}
  if(!await IOUtils.exists(this.owner.python)||!await IOUtils.exists(PathUtils.join(this.owner.resources,'manager.py')))throw new Error('本机组件尚未安装，请打开自动设置');
  const child=await this.spawn(session,this.owner.python,this.args('run'),{cwd:this.root});session.ownsRuntime=true;const deadline=Date.now()+180000;
  while(child.exit===null&&Date.now()<deadline){
   session.check();try{const c=await this.connection(session);if(c.instance!==previous?.instance){this.core.validateReady(c,await this.health(c,session));session.check();
    child.done.then(()=>{if(!session.cancelled&&this.owner.controller.runtime===session)this.owner.controller.update({phase:'error',state:'failed',detail:'本机服务已停止，请重新打开自动设置'});}).catch(()=>{});return c;
   }}catch(_){session.check();}
   await this.progress(session,emit);await this.delay(500);
  }
  throw new Error('本机服务未能通过检查，请重试');
 }
 async cancel(session){
  for(const request of session.requests){try{request.abort();}catch(_){}}session.requests.clear();
  await Promise.allSettled(Array.from(session.children,async handle=>{try{await handle.process.kill(1000);}catch(_){}await handle.done.catch(()=>{});}));
 }
};
var PaperInstaller={
 async initialize(config,rootURI){
  this.config=config;this.rootURI=rootURI;this.win=config.win||Zotero.getMainWindow();
  const scope={URL:this.win.URL};Services.scriptloader.loadSubScript(rootURI+'installer-core.js',scope);this.core=scope.PaperInstallerCore;
  this.native=new PaperInstallerNative(this);this.sources={};for(const name of this.core.SERVICE_FILES)this.sources[name]=await this.native.readResource(name);
  this.manifest=this.core.validateManifest(JSON.parse(this.sources['runtime-manifest.json']));
  if(Services.appinfo?.OS&&Services.appinfo.OS!=='Darwin'){this.root='';this.controller=new this.core.Controller(this.native,config,this.root,this.manifest);this.controller.update({phase:'error',state:'unsupported',detail:'自动设置暂仅支持 macOS 14 或更新版本及 Apple 芯片 Mac。'});return;}
  const encode=text=>new this.win.TextEncoder().encode(text);
  const profileHash=await this.native.digest(encode(Zotero.Profile.dir));this.root=this.core.managedRoot(Services.dirsvc.get('Home',Components.interfaces.nsIFile).path,profileHash);
  const fingerprint=await this.native.digest(encode(this.core.SERVICE_FILES.map(name=>this.sources[name]).join('')));this.resources=PathUtils.join(this.root,'resources',fingerprint.slice(0,24));
  this.version=(await this.native.digest(encode(['runtime-manifest.json','engine-requirements.lock','server.py','bing_compat.py','engine_probe.py'].map(name=>this.sources[name]).join('')))).slice(0,24);
  this.uv=PathUtils.join(this.root,'tools',this.manifest.uv.version,...this.manifest.uv.executable.split('/'));this.python=PathUtils.join(this.root,'bootstrap-venv','bin','python');
  this.controller=new this.core.Controller(this.native,config,this.root,this.manifest);
 },
 get status(){return this.controller?.status||{phase:'idle',state:'idle',detail:''};},
 subscribe(listener){return this.controller.subscribe(listener);},
 open(){if(!this.chromeHandle){const startup=Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(Components.interfaces.amIAddonManagerStartup);this.chromeHandle=startup.registerChrome(Services.io.newURI(this.rootURI+'manifest.json'),[['content','paper-companion',this.rootURI]]);}if(this.window&&!this.window.closed){this.window.focus();return this.window;}this.window=this.win.openDialog('chrome://paper-companion/content/setup.xhtml','paper-companion-setup','chrome,centerscreen,resizable,width=640,height=690',{installer:this});return this.window;},
 async openLog(){if(!this.root)return false;const path=PathUtils.join(this.root,'runtime.log');await this.native.safeFile(path);if(!await IOUtils.exists(path))return false;await Zotero.File.reveal(path);return true;},
 start(options={}){if(this.controller.busy)return this.controller.busy;try{const proxy=this.core.validateDownloadProxy(options.downloadProxy??this.config.downloadProxy??'');this.config.downloadProxy=proxy;Zotero.Prefs.set('paperCompanion.downloadProxy',proxy);return this.controller.start(options);}catch(error){this.controller.update({phase:'error',state:'failed',detail:error.message});throw error;}},
 ensureRunning(){return this.controller.ensureRunning();},
 cancel(){return this.controller.cancel();},
 async stop(){await this.controller?.stop();this.window?.close();this.chromeHandle?.destruct();this.chromeHandle=null;}
};
