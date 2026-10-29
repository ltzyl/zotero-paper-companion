// SPDX-License-Identifier: AGPL-3.0-only
window.addEventListener('DOMContentLoaded',()=>{
 const installer=window.arguments[0].installer,$=id=>document.getElementById(id);
 const labels={idle:'准备设置',checking:'检查环境',uv:'下载安装器',python:'下载 Python',engine:'安装翻译组件',assets:'准备 PDF 资源',ollama:'安装模型运行组件',model:'下载模型',validate:'检查服务',ready:'可以使用',error:'设置尚未完成',cancelled:'设置已取消'};
 const order={checking:0,uv:0,python:1,engine:2,assets:2,ollama:3,model:3,validate:4,ready:5};
 let state=installer.status,busy=false;
 const format=value=>value>=1024**3?(value/1024**3).toFixed(2)+' GiB':value>=1024**2?(value/1024**2).toFixed(1)+' MiB':Math.round(value/1024)+' KiB';
 function render(status){
  state=status;busy=status.state==='running';const ready=status.phase==='ready';
  $('phase').textContent=labels[status.phase]||'自动设置';$('detail').textContent=status.detail||'点击开始后，将先检查 Mac 和可用磁盘空间。';
  $('start').hidden=busy||ready;$('start').disabled=!$('consent').checked;$('start').textContent=['failed','cancelled'].includes(status.state)?'重试自动设置':'开始自动设置';
  $('cancel').hidden=!busy;$('cancel').disabled=status.cancellable===false;$('consent').disabled=busy||ready;$('metrics').disabled=busy||ready;$('manual').disabled=busy;$('close').textContent=ready?'完成':'关闭';
  $('consent-panel').hidden=ready;$('progress').hidden=!busy;
  if(Number.isFinite(status.total)&&status.total>0&&Number.isFinite(status.completed)){$('progress').max=status.total;$('progress').value=Math.min(status.completed,status.total);}else $('progress').removeAttribute('value');
  $('bytes').textContent=Number.isFinite(status.completed)?'已下载 '+format(status.completed)+(Number.isFinite(status.total)?' / '+format(status.total):''):'';
  const current=order[status.phase];for(const step of document.querySelectorAll('#steps li')){const n=order[step.dataset.phase];step.className=current===undefined?'':n<current?'done':n===current?'current':'';if(n===current)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');}
 }
 $('metrics').checked=!!installer.config.metricsEnabled;
 $('consent').addEventListener('change',()=>render(state));
 $('start').addEventListener('click',async()=>{if(!$('consent').checked||busy)return;try{await installer.start({metrics:$('metrics').checked});}catch(_){/* The installer publishes a safe error and retains retry state. */}});
 $('cancel').addEventListener('click',async()=>{const button=$('cancel');button.disabled=true;try{await installer.cancel();}finally{button.disabled=false;}});
 $('close').addEventListener('click',()=>window.close());
 $('manual').addEventListener('click',async()=>{try{await installer.config.setupManual();}catch(error){$('detail').textContent=String(error.message||'无法读取本机连接文件');}});
 const unsubscribe=installer.subscribe(render);
 window.addEventListener('unload',()=>{unsubscribe();if(busy)installer.cancel().catch(()=>{});},{once:true});
},{once:true});
