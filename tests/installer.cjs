// SPDX-License-Identifier: AGPL-3.0-only
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.join(__dirname,'../addon/installer-core.js'),scope={URL};
if(fs.existsSync(file))vm.runInNewContext(fs.readFileSync(file,'utf8'),scope);
const core=scope.PaperInstallerCore||{};
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../service/runtime-manifest.json'),'utf8'));
test('bootstrap validates pinned manifest before trusting download locations',()=>{
 assert.equal(typeof core.validateManifest,'function');
 assert.equal(core.validateManifest(manifest),manifest);
 for(const mutate of [m=>m.uv.url='http://example.org/uv',m=>m.uv.sha256='x',m=>m.python.request='3.12',m=>m.uv.executable='../uv',m=>m.python.downloadsFile='../python.json']){
  const copy=structuredClone(manifest);mutate(copy);assert.throws(()=>core.validateManifest(copy));
 }
});
test('archive rejects traversal, symlinks and unanticipated members before extraction',()=>{
 const base='uv-aarch64-apple-darwin';
 assert.equal(core.validateArchive([base+'/',base+'/uv',base+'/uvx'],['d','-','-'],manifest.uv),true);
 for(const names of [['../uv'],['/uv'],[base+'/../uv'],[base+'/uv',base+'/extra'],[base+'/uv',base+'/uv']])assert.throws(()=>core.validateArchive(names,names.map(()=>'-'),manifest.uv));
 for(const type of ['l','h','c','b'])assert.throws(()=>core.validateArchive([base+'/uv'],[type],manifest.uv));
});
test('loopback connection identity includes all managed readiness components',()=>{
 const c={managed:true,protocol:2,serviceURL:'http://127.0.0.1:47821',modelURL:'http://127.0.0.1:47822',instance:'a'.repeat(48),token:'b'.repeat(64)};
 const h={service:'paper-companion',status:'ok',protocol:2,instance:c.instance,modelURL:c.modelURL,ready:true,components:{engine:true,model:true,assets:true}};
 assert.equal(core.validateReady(c,h),true);
 for(const mutate of [x=>x.instance='c'.repeat(48),x=>x.ready=false,x=>x.components.engine=false,x=>x.modelURL='http://127.0.0.1:12345',x=>x.protocol=1]){const copy=structuredClone(h);mutate(copy);assert.throws(()=>core.validateReady(c,copy));}
 for(const mutate of [x=>x.serviceURL='http://localhost:47821',x=>x.modelURL='http://127.0.0.1:47822/evil',x=>x.token='short',x=>x.managed=false,x=>x.instance='']){const copy=structuredClone(c);mutate(copy);assert.throws(()=>core.validateReady(copy,h));}
});
test('profile root and physical platform checks do not follow caller supplied paths',()=>{
 assert.equal(core.managedRoot('/home/example','0123456789abcdef0123456789abcdef'),'/home/example/.paper-companion/managed-0123456789abcdef01234567');
 assert.throws(()=>core.managedRoot('/home/example','../other'));
 assert.equal(core.validatePlatform({os:'Darwin',version:'14.0',arm64:true}),true);
 assert.equal(core.validatePlatform({os:'Darwin',version:'15.1',arm64:true}),true);
 for(const p of [{os:'Linux',version:'20',arm64:true},{os:'Darwin',version:'13.6',arm64:true},{os:'Darwin',version:'15',arm64:false}])assert.throws(()=>core.validatePlatform(p));
});
function fixture(overrides={}){
 const connection={managed:true,protocol:2,serviceURL:'http://127.0.0.1:47821',modelURL:'http://127.0.0.1:47822',instance:'a'.repeat(48),token:'b'.repeat(64)};
 const activated=[],owned=[],released=[];
 const native={environment:async()=>({os:'Darwin',version:'14.0',arm64:true}),prepare:async()=>{},copyResources:async()=>{},acquire:async s=>{s.lock=true;},release:async s=>{released.push(s);},bootstrap:async()=>{},install:async()=>{},installed:async()=>true,connect:async s=>{s.ownsRuntime=true;owned.push(s);return connection;},health:async()=>({service:'paper-companion',status:'ok',protocol:2,instance:connection.instance,modelURL:connection.modelURL,ready:true,components:{engine:true,model:true,assets:true}}),cancel:async s=>{s.nativeCancelled=true;},...overrides};
 const config={activateConnection:async(c,o)=>activated.push({connection:c,options:o})};
 return {controller:new core.Controller(native,config,'/home/example/.paper-companion/managed-0123456789abcdef01234567',manifest),native,activated,owned,released,connection};
}
test('activation waits for authenticated health and passes the derived managed root',async()=>{
 const f=fixture();let release;f.native.health=()=>new Promise(r=>{release=r;});const operation=f.controller.start({metrics:true});
 while(!release)await new Promise(r=>setImmediate(r));assert.equal(f.activated.length,0);assert.notEqual(f.controller.status.phase,'ready');
 release({service:'paper-companion',status:'ok',protocol:2,instance:f.connection.instance,modelURL:f.connection.modelURL,ready:true,components:{engine:true,model:true,assets:true}});
 await operation;assert.equal(f.activated.length,1);assert.equal(f.activated[0].connection.managedRoot,'/home/example/.paper-companion/managed-0123456789abcdef01234567');assert.equal(f.activated[0].options.metrics,true);assert.equal(f.controller.status.phase,'ready');
 await f.controller.stop();assert.equal(f.owned[0].nativeCancelled,true);
});
test('foreign or stale health fails closed and supports an explicit retry',async()=>{
 const f=fixture({health:async()=>({service:'paper-companion',status:'ok',protocol:2,instance:'f'.repeat(48),ready:true})});
 await assert.rejects(f.controller.start());assert.equal(f.activated.length,0);assert.equal(f.controller.status.state,'failed');assert.equal(f.owned[0].nativeCancelled,true);
 f.native.health=async()=>({service:'paper-companion',status:'ok',protocol:2,instance:f.connection.instance,modelURL:f.connection.modelURL,ready:true,components:{engine:true,model:true,assets:true}});
 await f.controller.start();assert.equal(f.activated.length,1);assert.equal(f.controller.status.phase,'ready');await f.controller.stop();
});
test('cancel affects only the owned session and cannot later activate a completed download',async()=>{
 let finish;const f=fixture({bootstrap:()=>new Promise(r=>{finish=r;})});
 const running=f.controller.start();while(!finish)await new Promise(r=>setImmediate(r));const pending=f.controller.session;
 await f.controller.cancel();finish();await assert.rejects(running,/取消/);assert.equal(f.activated.length,0);assert.equal(pending.nativeCancelled,true);assert.equal(f.released.length,1);assert.equal(f.controller.status.state,'cancelled');
});
test('startup cannot download or activate and concurrent calls share one runtime',async()=>{
 const f=fixture({bootstrap:async()=>{throw new Error('startup must not install');},install:async()=>{throw new Error('startup must not install');}});
 const a=f.controller.ensureRunning(),b=f.controller.ensureRunning();assert.equal(a,b);await a;assert.equal(f.activated.length,0);assert.equal(f.owned.length,1);await f.controller.stop();
 const absent=fixture({installed:async()=>false});await assert.rejects(absent.controller.ensureRunning());assert.equal(absent.owned.length,0);
});
test('unsupported physical platform fails before any download or runtime launch',async()=>{
 const f=fixture({environment:async()=>({os:'Darwin',version:'13.6',arm64:true}),bootstrap:async()=>{throw new Error('download attempted');}});
 await assert.rejects(f.controller.start(),/macOS 14/);assert.equal(f.activated.length,0);assert.equal(f.owned.length,0);
});
const nativeScope={...scope};const nativeFile=path.join(__dirname,'../addon/installer.js');if(fs.existsSync(nativeFile))vm.runInNewContext(fs.readFileSync(nativeFile,'utf8'),nativeScope);
test('native hash mismatch fails before an archive may be extracted',async()=>{
 assert.equal(typeof nativeScope.PaperInstallerNative,'function');
 const win={crypto:require('node:crypto').webcrypto};const n=new nativeScope.PaperInstallerNative({win});
 await assert.rejects(n.verifyBytes(new TextEncoder().encode('corrupted'),manifest.uv.sha256),/校验/);
 assert.equal(await n.verifyBytes(new TextEncoder().encode('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),true);
});
function nativeFixture(){
 const os=require('node:os'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'paper-installer-'));const root=path.join(tmp,'managed');fs.mkdirSync(root);
 const context={...scope,PathUtils:{join:path.join},Components:{interfaces:{nsIFile:{}},classes:{'@mozilla.org/file/local;1':{createInstance(){let target;return {initWithPath:p=>{target=p;},exists:()=>fs.existsSync(target),isSymlink:()=>fs.lstatSync(target).isSymbolicLink(),isDirectory:()=>fs.statSync(target).isDirectory(),isFile:()=>fs.statSync(target).isFile(),diskSpaceAvailable:1024**4};}}}},Services:{appinfo:{processID:process.pid},dirsvc:{get:()=>({path:tmp})}},IOUtils:{exists:async p=>fs.existsSync(p),readUTF8:p=>fs.promises.readFile(p,'utf8'),writeUTF8:async(p,s)=>{await fs.promises.writeFile(p,s);},read:p=>fs.promises.readFile(p),write:(p,b)=>fs.promises.writeFile(p,b),stat:async p=>{const st=await fs.promises.stat(p);return {lastModified:st.mtimeMs};},remove:(p,o={})=>fs.promises.rm(p,{recursive:!!o.recursive,force:!!o.ignoreAbsent}),makeDirectory:async(p,o={})=>{await fs.promises.mkdir(p,{recursive:!!o.ignoreExisting,mode:o.permissions});},setPermissions:(p,m)=>fs.promises.chmod(p,m)}};
 vm.runInNewContext(fs.readFileSync(nativeFile,'utf8'),context);
 const owner={root,manifest,core,resources:path.join(root,'resources','revision'),sources:Object.fromEntries(core.SERVICE_FILES.map(n=>[n,'fixture'])),win:{crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout}};
 owner.uv=path.join(root,'tools',manifest.uv.version,manifest.uv.executable);owner.python=path.join(root,'bootstrap-venv','bin','python');owner.version='0123456789abcdef01234567';const n=new context.PaperInstallerNative(owner);
 const session={install:true,cancelled:false,children:new Set(),requests:new Set(),check(){if(this.cancelled)throw new Error('设置已取消');}};
 return {n,owner,session,root,tmp,cleanup:()=>fs.rmSync(tmp,{recursive:true,force:true}),context};
}
test('native bootstrap disables external uv configuration while preserving HOME',()=>{
 const f=nativeFixture();try{
  f.context.Services.io={newFileURI:()=>({spec:'file:///fixture/python-downloads.json'})};
  f.context.Services.dirsvc.get=()=>({path:process.env.HOME});
  const env=f.n.environmentValues();assert.equal(env.HOME,process.env.HOME);assert.equal(env.UV_NO_CONFIG,'1');
 }finally{f.cleanup();}
});
test('native uv can create its pinned Python environment despite discovered uv.toml',{
 skip:!process.env.PAPER_COMPANION_TEST_UV||!process.env.PAPER_COMPANION_TEST_PYTHON?'set PAPER_COMPANION_TEST_UV and PAPER_COMPANION_TEST_PYTHON to run pinned uv integration':false
},()=>{
 const f=nativeFixture();try{
  f.context.Services.io={newFileURI:()=>({spec:'file:///fixture/python-downloads.json'})};
  f.context.Services.dirsvc.get=()=>({path:process.env.HOME});
  fs.mkdirSync(path.join(f.root,'tmp'));fs.writeFileSync(path.join(f.tmp,'uv.toml'),'required-version = "<0.1"\npython-downloads = "never"\n');
  const env=f.n.environmentValues(),args=['venv','--managed-python','--python',process.env.PAPER_COMPANION_TEST_PYTHON,path.join(f.root,'venv')];
  const run=environment=>require('node:child_process').spawnSync(process.env.PAPER_COMPANION_TEST_UV,args,{env:environment,cwd:f.tmp,encoding:'utf8'});
  const inherited={...env};delete inherited.UV_NO_CONFIG;const blocked=run(inherited);
  assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/Required uv version/);
  const installed=run(env);assert.equal(installed.status,0,installed.stderr);assert.ok(fs.existsSync(path.join(f.root,'venv','bin','python')));
 }finally{f.cleanup();}
});
test('native lock refuses a live foreign owner and releases only its own nonce',async()=>{
 const f=nativeFixture();try{
  await f.n.prepare(f.session);await f.n.acquire(f.session);const lock=path.join(f.root,'setup.lock');assert.equal(fs.existsSync(lock),true);
  const foreign={...f.session,id:'foreign'};await f.n.release(foreign);assert.equal(fs.existsSync(lock),true);
  f.n.spawn=async()=>({exit:0,done:Promise.resolve()});await assert.rejects(f.n.acquire({...f.session,lock:false}),/正在运行/);
  await f.n.release(f.session);assert.equal(fs.existsSync(lock),false);
 }finally{f.cleanup();}
});
test('native prepare refuses symlinked managed directories',async()=>{
 const f=nativeFixture();try{fs.mkdirSync(path.join(f.tmp,'.paper-companion'));fs.symlinkSync(f.tmp,path.join(f.root,'cache'));await assert.rejects(f.n.prepare(f.session),/符号链接/);}finally{f.cleanup();}
});
test('cancel aborts only tracked HTTP and child handles',async()=>{
 const f=nativeFixture();try{
  let ownRequest=0,ownChild=0,foreign=0;
  f.session.requests.add({abort:()=>ownRequest++});f.session.children.add({process:{kill:async()=>ownChild++},done:Promise.resolve()});
  const unrelated={abort:()=>foreign++,kill:()=>foreign++};await f.n.cancel(f.session);assert.equal(ownRequest,1);assert.equal(ownChild,1);assert.equal(foreign,0);assert.ok(unrelated);
 }finally{f.cleanup();}
});
test('stop waits for active setup ownership to be released before addon shutdown',async()=>{
 let finish;const f=fixture({bootstrap:()=>new Promise(r=>{finish=r;})});const running=f.controller.start().catch(()=>{});
 while(!finish)await new Promise(r=>setImmediate(r));f.native.cancel=async()=>{finish();};await f.controller.stop();assert.equal(f.released.length,1);assert.equal(f.controller.busy,null);await running;
});
test('native file checks reject dangling symlinks before any write',async()=>{
 const f=nativeFixture();try{const target=path.join(f.root,'unsafe');fs.symlinkSync(path.join(f.tmp,'absent'),target);await assert.rejects(f.n.safeFile(target),/不安全/);await assert.rejects(f.n.safeDirectory(target),/符号链接/);}finally{f.cleanup();}
});
test('interrupted uv extraction is retried from verified cached archive',async()=>{
 const f=nativeFixture();try{
  await f.n.prepare(f.session);fs.mkdirSync(path.dirname(f.owner.uv),{recursive:true});fs.writeFileSync(f.owner.uv,'interrupted');
  fs.mkdirSync(path.dirname(f.owner.python),{recursive:true});fs.writeFileSync(f.owner.python,'python');
  fs.writeFileSync(path.join(f.root,'cache','uv-'+manifest.uv.version+'.tar.gz'),'verified archive fixture');
  f.n.verifyBytes=async()=>true;let extracted=false;
  f.n.command=async(s,command,args)=>{if(command==='/usr/bin/tar'){if(args[0]==='-tzf')return manifest.uv.executable+'\n';if(args[0]==='-tvzf')return '-rwx------ uv\n';extracted=true;return '';}if(command===f.owner.python)return '3.12.16\narm64\n';throw new Error('Unexpected command');};
  await f.n.bootstrap(f.session,()=>{});assert.equal(extracted,true);assert.equal(fs.readFileSync(path.join(f.root,'tools',manifest.uv.version,'archive.sha256'),'utf8'),manifest.uv.sha256);
 }finally{f.cleanup();}
});

test('native initialization splits archive executable into Gecko path components',async()=>{
 const context={URL,PathUtils:{join(first,...parts){if(parts.some(x=>x.includes('/')))throw new Error('Invalid Gecko path component');return path.join(first,...parts);}},Components:{interfaces:{nsIFile:{}}},Services:{dirsvc:{get:()=>({path:'/home/example'})},scriptloader:{loadSubScript(uri,target){target.PaperInstallerCore=core;}}},Zotero:{Profile:{dir:'/profile/example'}}};
 vm.runInNewContext(fs.readFileSync(nativeFile,'utf8'),context);
 context.PaperInstallerNative.prototype.readResource=async function(name){return name==='runtime-manifest.json'?JSON.stringify(manifest):'fixture';};
 const win={URL,TextEncoder,crypto:require('node:crypto').webcrypto};await context.PaperInstaller.initialize({win},'jar:file:///fixture.xpi!/');
 assert.ok(context.PaperInstaller.uv.endsWith('/uv-aarch64-apple-darwin/uv'));
});

test('activation finishes atomically if the setup window closes during configuration',async()=>{
 const f=fixture();let finish;f.controller.config.activateConnection=()=>new Promise(r=>{finish=r;});const running=f.controller.start();
 while(!finish)await new Promise(r=>setImmediate(r));await f.controller.cancel();assert.equal(f.owned[0].nativeCancelled,undefined);finish();await running;assert.equal(f.controller.status.phase,'ready');await f.controller.stop();assert.equal(f.owned[0].nativeCancelled,true);
});
test('startup stages new bundled manager resources without installing or downloading',async()=>{
 let staged=false;const f=fixture({copyResources:async()=>{staged=true;},connect:async()=>{assert.equal(staged,true);return f.connection;}});await f.controller.ensureRunning();await f.controller.stop();
});
