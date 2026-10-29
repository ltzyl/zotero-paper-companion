// SPDX-License-Identifier: AGPL-3.0-only
var PaperReadingPane=class{
 async start(w){this.w=w;this.win=w.window;this.alive=true;this.bodies=new Map();this.patches=[];
  const proto=this.win.customElements.get('related-box')?.prototype;if(proto){const original=proto.render,owner=this;const wrapped=function(...args){const r=original.apply(this,args);owner.related(this);return r;};proto.render=wrapped;this.patches.push(()=>{if(proto.render===wrapped)proto.render=original;});}
  const icon='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M5 5L15 10L5 15" fill="none" stroke="#387f91" stroke-width="2"/><circle cx="5" cy="5" r="3" fill="#387f91"/><circle cx="15" cy="10" r="3" fill="#387f91"/><circle cx="5" cy="15" r="3" fill="#387f91"/></svg>');
  this.paneID=Zotero.ItemPaneManager.registerSection({paneID:'citation-graph',pluginID:'paper-companion@ltzyl.github.io',header:{l10nID:'section-related',icon},sidenav:{l10nID:'sidenav-related',icon},
   onItemChange:({item,setEnabled,body})=>{const i=this.parent(item);this.bodies.set(body,i);setEnabled(!!i?.isRegularItem()&&i.libraryID===Zotero.Libraries.userLibraryID);if(i)this.w.enrichment?.schedule(i.id);},
   onRender:({body,item})=>{this.bodies.set(body,this.parent(item));this.graph(body,this.parent(item));},onDestroy:({body})=>this.bodies.delete(body)});
  const nav=this.win.document.querySelector('item-pane-sidenav');let order=nav?.getPersistedOrder()||['info','abstract','attachments','notes','libraries-collections','tags','related'];order=order.filter(x=>x!==this.paneID);const index=order.indexOf('related');order.splice(index<0?order.length:index+1,0,this.paneID);Zotero.Prefs.set('sidenav.order',order.join(','));
  this.refresh();
 }
 parent(i){return i?.parentItemID?Zotero.Items.get(i.parentItemID):i;}
 html(doc,tag,text){const e=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);if(text!==undefined)e.textContent=text;return e;}
 async select(key){const i=await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID,key);if(!i||i.deleted)return;await this.win.ZoteroPane.selectItem(i.id);this.win.Zotero_Tabs.select('zotero-pane');this.win.focus();}
 related(box){
  box.querySelector('.paper-directed-relations')?.remove();const item=this.parent(box.item);if(!item?.isRegularItem()||item.libraryID!==Zotero.Libraries.userLibraryID)return;
  const d=box.ownerDocument,root=this.html(d,'div');root.className='paper-directed-relations';root.style.cssText='border-top:1px solid #9995;margin-top:8px;padding-top:8px';
  const edges=this.w.companions?.edges||[],nodes=this.w.companions?.nodes||[];
  let count=0;
  for(const [heading,out]of [['引用的文献',true],['被引用于',false]]){const es=edges.filter(e=>out?e.source===item.key:e.target===item.key);count+=es.length;const title=this.html(d,'h3',heading+'（'+es.length+'）');title.style.cssText='font-size:13px;margin:10px 0 5px';root.append(title);
   if(!es.length)root.append(this.html(d,'p',this.w.companions?.scanning?'正在识别文库内引用…':'暂未匹配到文库内文献'));
   for(const e of es){const key=out?e.target:e.source,n=nodes.find(n=>n.key===key);if(!n)continue;const a=this.html(d,'button',n.titleZh||n.title);a.className='paper-citation-link';a.dataset.key=key;a.title=e.evidence+'\n'+n.title;a.style.cssText='display:block;text-align:left;width:100%;white-space:normal;border:0;background:transparent;color:#28758b;padding:5px 0;cursor:pointer;font:inherit';a.addEventListener('click',()=>this.select(key));root.append(a);}
  }
  const open=this.html(d,'button','查看这篇论文的引用关系图');open.className='paper-open-graph';open.addEventListener('click',()=>this.showGraph(item));root.append(open);box.querySelector('.body')?.append(root);
  box._section?.setCount((box._getRelatedItems?.().length||0)+count);if(box._section)box._section.empty=false;
 }
 showGraph(item){for(const details of this.win.document.querySelectorAll('item-details')){const pane=details.querySelector(`[data-pane="${this.paneID.replace(/\\/g,'\\\\')}"]`);if(pane){const section=pane.querySelector('collapsible-section')||pane;section.open=true;pane.scrollIntoView({block:'start',behavior:'smooth'});}}
  const navs=this.win.document.querySelectorAll('item-pane-sidenav');for(const nav of navs){const b=[...nav.querySelectorAll('.btn[data-pane]')].find(b=>b.dataset.pane===this.paneID);b?.click();}
 }
 graph(body,item){
  body.replaceChildren();if(!item?.isRegularItem())return;
  const d=body.ownerDocument,section=body.closest('item-pane-custom-section')?.querySelector('collapsible-section');if(section){section.removeAttribute('data-l10n-id');section.label='引用关系图';}
  this.win.setTimeout(()=>{for(const b of d.querySelectorAll('item-pane-sidenav .btn[data-pane]'))if(b.dataset.pane===this.paneID){b.removeAttribute('data-l10n-id');b.setAttribute('title','引用关系图');b.setAttribute('tooltiptext','引用关系图');b.setAttribute('aria-label','引用关系图');}},0);
  const c=this.w.companions,ego=PaneCore.ego(item.key,c?.edges||[]),nodes=(c?.nodes||[]).filter(n=>ego.keys.has(n.key));
  if(!nodes.some(n=>n.key===item.key))nodes.push({key:item.key,title:item.getField('title')});
  const info=this.html(d,'p','箭头：引用者 → 被引用者。点击论文切换条目和关系图；拖动节点调整布局。');info.style.cssText='font-size:12px;line-height:1.5';body.append(info);
  const wrap=this.html(d,'div');wrap.style.cssText='overflow:auto;max-height:65vh;border:1px solid #9995;border-radius:6px';body.append(wrap);
  const ns='http://www.w3.org/2000/svg',svg=(tag,attrs={})=>{const e=d.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;};
  const h=Math.max(360,(nodes.length-1)*54),canvas=svg('svg',{viewBox:`0 0 600 ${h}`,width:'100%',height:Math.max(360,h*.6)});canvas.style.cssText='display:block;min-width:300px;touch-action:none';wrap.append(canvas);
  const defs=svg('defs'),marker=svg('marker',{id:'citation-arrow-'+item.key,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});marker.append(svg('path',{d:'M0 0L10 5L0 10z',fill:'#627f91'}));defs.append(marker);canvas.append(defs);
  const layer=svg('g');canvas.append(layer);const positions=new Map(),incoming=nodes.filter(n=>n.key!==item.key&&ego.edges.some(e=>e.source===n.key&&e.target===item.key)),outgoing=nodes.filter(n=>n.key!==item.key&&!incoming.includes(n));positions.set(item.key,{x:300,y:h/2});
  for(const [list,x]of [[incoming,95],[outgoing,505]])list.forEach((n,i)=>positions.set(n.key,{x,y:(i+1)*h/(list.length+1)}));
  const draw=()=>{layer.replaceChildren();for(const e of ego.edges){const a=positions.get(e.source),b=positions.get(e.target);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy)||1;layer.append(svg('path',{d:`M${a.x+dx/l*12} ${a.y+dy/l*12} L${b.x-dx/l*16} ${b.y-dy/l*16}`,fill:'none',stroke:'#627f91','stroke-width':1.5,'marker-end':`url(#citation-arrow-${item.key})`}));}
   for(const n of nodes){const p=positions.get(n.key),g=svg('g',{tabindex:0,role:'button','aria-label':n.title,'data-key':n.key}),circle=svg('circle',{cx:p.x,cy:p.y,r:n.key===item.key?15:11,fill:n.key===item.key?'#c67a3e':'#28758b'});g.style.cursor='pointer';const title=svg('title');title.textContent=n.title;g.append(circle,title);
    const label=n.titleZh||n.title,size=n.titleZh?13:22;for(let k=0;k<2;k++){const t=svg('text',{x:p.x,y:p.y+30+k*16,'text-anchor':'middle','font-size':12,fill:'currentColor'});t.textContent=label.slice(k*size,(k+1)*size)+(k===1&&label.length>size*2?'…':'');g.append(t);}
    g.addEventListener('pointerdown',e=>{drag={key:n.key,x:e.clientX,y:e.clientY,moved:false};canvas.setPointerCapture(e.pointerId);});g.addEventListener('keydown',e=>{if(e.key==='Enter')this.select(n.key);});layer.append(g);
   }
  };let drag=null;canvas.addEventListener('pointermove',e=>{if(!drag)return;if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>5)drag.moved=true;if(!drag.moved)return;const p=canvas.createSVGPoint();p.x=e.clientX;p.y=e.clientY;const at=p.matrixTransform(canvas.getScreenCTM().inverse());positions.set(drag.key,{x:at.x,y:at.y});draw();});canvas.addEventListener('pointerup',()=>{if(drag&&!drag.moved)this.select(drag.key);drag=null;});canvas.addEventListener('pointercancel',()=>drag=null);draw();
  body.dataset.itemKey=item.key;body.dataset.edgeCount=ego.edges.length;body.dataset.nodeCount=nodes.length;
  if(!ego.edges.length)body.append(this.html(d,'p',c?.scanning?'正在扫描文库…':'尚未识别到文库内的引用关系。没有连线不代表没有引用。'));
 }
 refresh(){if(!this.alive)return;for(const box of this.win.document.querySelectorAll('related-box'))this.related(box);for(const[body,item]of this.bodies)if(body.isConnected)this.graph(body,item);}
 stop(){this.alive=false;for(const undo of this.patches)undo();for(const root of this.win.document.querySelectorAll('.paper-directed-relations'))root.remove();if(this.paneID)Zotero.ItemPaneManager.unregisterSection(this.paneID);this.bodies.clear();}
};
