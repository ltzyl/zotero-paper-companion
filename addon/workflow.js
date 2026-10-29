// SPDX-License-Identifier: AGPL-3.0-only
var PaperWorkflow = class {
  async start() {
    this.window = Zotero.getMainWindow();
    this.alive = true;
    this.busy = false;
    this.timers = new Map();
    this.jobs = {};
    this.root = PublicConfig.stateDir;
    this.statePath = PathUtils.join(Zotero.Profile.dir, 'paper-companion-state.json');
    try { this.jobs = JSON.parse(await IOUtils.readUTF8(this.statePath)); } catch (_) {}
    this.cutoff = Number(Zotero.Prefs.get('paperCompanion.since')) || Date.now();
    this.refreshScope();
    this.observer = Zotero.Notifier.registerObserver(this, ['item','collection-item','collection'], 'paper-companion');
    this.installMenu();
    this.installColumns();
    this.metadata=new PaperMetadata();
    await this.metadata.start(this);
    await this.ensureServer();
    await this.recoverJobs();
    await this.scanTargets();
    await this.scanNewItems();
  }
  eligible(item) {
    return !!(item && !item.deleted && item.libraryID === Zotero.Libraries.userLibraryID && item.isRegularItem()
      && ['journalArticle','conferencePaper','preprint','report','thesis'].includes(item.itemType));
  }
  refreshScope() {
    let keys;
    try { keys = JSON.parse(Zotero.Prefs.get('paperCompanion.collectionKeys') || '[]'); } catch (_) { keys = []; }
    this.scope = WorkflowCore.targetCollectionIDs(Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID,true),keys);
  }
  async scanTargets() {
    if (!Zotero.Prefs.get('paperCompanion.enabled')) return;
    for (const id of this.scope) {
      const collection = Zotero.Collections.get(id);
      await collection.loadDataType('childItems');
      for (const item of collection.getChildItems()) await this.queueAutomatic(item,false);
    }
  }
  async scanNewItems() {
    if(!Zotero.Prefs.get('paperCompanion.enabled'))return;
    const s=new Zotero.Search();s.libraryID=Zotero.Libraries.userLibraryID;s.addCondition('deleted','false');
    for(const id of await s.search()){const item=await Zotero.Items.getAsync(id);if(!this.eligible(item))continue;
      const added=Date.parse(item.dateAdded.replace(' ','T')+'Z');
      if(added>=this.cutoff)await this.queueAutomatic(item,false);
    }
  }
  async queueAutomatic(item, newAttachment) {
    if (!this.eligible(item)) return;
    this.metadata?.schedule(item.id,10000,newAttachment);
    const job = this.jobs[item.id];
    if (job && !(newAttachment && ['missing','review'].includes(job.status)) && !(job.status==='cancelled'&&!job.taskId)) return;
    this.jobs[item.id] = {status:'queued',updated:Date.now(),automatic:true,inputFingerprint:[item.getField('DOI'),item.getField('url'),item.getField('title')].join('|')};
    await this.state(item,'queued');
    this.schedule(item.id,3000);
  }
  async recoverJobs() {
    for (const [id, job] of Object.entries(this.jobs)) {
      if (job.status === 'translating' && !job.taskId) {
        const item = await Zotero.Items.getAsync(Number(id));
        if (item && !item.deleted) await this.state(item,'failed','上次提交结果不确定，请检查服务进度后手动重试');
        continue;
      }
      if (['queued','finding','waiting','translating','importing'].includes(job.status)) this.schedule(Number(id),3000);
    }
  }
  async enqueue(item) {
    const job = this.jobs[item.id];
    if (!job?.taskId || job.retryFresh || job.status==='done') this.jobs[item.id] = {};
    await this.state(item,'queued'); this.schedule(item.id,1000);
  }
  async notify(event, type, ids) {
    if (!this.alive || !Zotero.Prefs.get('paperCompanion.enabled')) return;
    if(type==='item'&&event==='modify') {
      for(const id of ids){const note=Zotero.Items.get(Number(id));if(note?.isNote()&&note.parentItemID){const parent=Zotero.Items.get(note.parentItemID);if(this.metadata?.jobs[parent.id]?.noteID===note.id)await this.metadata.refreshExcerpt(parent);}else if(this.eligible(note)){const job=this.jobs[note.id];const fingerprint=[note.getField('DOI'),note.getField('url'),note.getField('title')].join('|');if(job&&['missing','review'].includes(job.status)&&job.inputFingerprint!==fingerprint)await this.queueAutomatic(note,true);}}
      return;
    }
    if (type === 'collection' && ['add','modify'].includes(event)) { this.refreshScope(); await this.scanTargets(); return; }
    if (event !== 'add') return;
    for (const rawID of ids) {
      const id = type === 'collection-item' ? Number(String(rawID).split('-')[1]) : Number(rawID);
      if (!id) continue;
      const item = await Zotero.Items.getAsync(id);
      if (!item || item.deleted) continue;
      const parent = item.isAttachment() && item.parentItemID ? await Zotero.Items.getAsync(item.parentItemID) : item;
      if (parent?.isRegularItem()) this.metadata?.schedule(parent.id,10000,item.isAttachment());
      await this.queueAutomatic(parent,item.isAttachment());
    }
    await this.save();
  }
  schedule(id, delay) {
    if (this.timers.has(id)) this.window.clearTimeout(this.timers.get(id));
    this.timers.set(id, this.window.setTimeout(() => { this.timers.delete(id); this.run(id); }, delay));
  }
  async save() {
    const snapshot = JSON.stringify(this.jobs, null, 2);
    this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(() => IOUtils.writeUTF8(this.statePath, snapshot, {tmpPath:this.statePath + '.tmp'}));
    await this.saving;
  }
  async abandon(id) {
    this.jobs[id] = {...this.jobs[id],status:'cancelled',detail:'原条目已删除，不再导入结果',updated:Date.now()};
    await this.save();
  }
  async state(item, status, detail = '') {
    this.jobs[item.id] = {...this.jobs[item.id], status, detail, updated:Date.now()};
    await this.save();
    const labels = {queued:'等待处理', finding:'正在补全', missing:'缺少原文', review:'原文待确认', waiting:'等待翻译服务', translating:'翻译中', importing:'正在导入', done:'双语完成', failed:'翻译失败'};
    for (const tag of item.getTags()) if (tag.tag.startsWith('PDF工作流/')) item.removeTag(tag.tag);
    item.addTag('PDF工作流/' + (labels[status] || status));
    await item.saveTx();
  }
  async ensureServer() {} // The portable companion is started explicitly by the user.
  async request(method,path,data,timeout=30000){return PublicConfig.request(method,path,data,timeout);}
  async findSource(item) {
    let questionable = false;
    for (const id of item.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(id);
      if (!attachment.isPDFAttachment() || !WorkflowCore.isSource(attachment.getField('title'), attachment.attachmentFilename || '')) continue;
      const path = await attachment.getFilePathAsync();
      if (!path || !await IOUtils.exists(path)) continue;
      try {
        const bytes = await IOUtils.read(path, {maxBytes:5});
        if (String.fromCharCode(...bytes) !== '%PDF-') { questionable = true; continue; }
        const fulltext = await Zotero.PDFWorker.getFullText(attachment.id, 3);
        if (WorkflowCore.inspectText(item.getField('title'), fulltext.text, fulltext.totalPages) === 'ready') return attachment;
        questionable = true;
      } catch (_) { questionable = true; }
    }
    return questionable ? 'review' : null;
  }
  async hasTranslation(item) {
    for (const id of item.getAttachments()) {
      const a = Zotero.Items.get(id);
      if (a.deleted || !a.isPDFAttachment() || !(WorkflowCore.isChinese(a.attachmentFilename || ''))) continue;
      const path = await a.getFilePathAsync();
      if (path && await IOUtils.exists(path)) return true;
    }
    return false;
  }
  async run(id) {
    if (!this.alive) return;
    if (this.busy) { this.schedule(id, 5000); return; }
    // Existing task IDs must be polled even if other recovered jobs also have IDs.
    // Only a new submission waits behind those jobs.
    if (!this.jobs[id]?.taskId && Object.entries(this.jobs).some(([other,job]) => Number(other)!==id && job.taskId && ['queued','waiting','translating','importing'].includes(job.status))) {
      this.schedule(id,15000); return;
    }
    this.busy = true;
    let item;
    try {
      item = await Zotero.Items.getAsync(id);
      if (!item || item.deleted) { await this.abandon(id); return; }
      if (await this.hasTranslation(item)) { await this.state(item, 'done', '已有双语附件，未重复翻译'); return; }
      if (this.jobs[id]?.automatic && !this.jobs[id]?.taskId && !this.eligible(item)) { await this.abandon(id); return; }
      let taskId = this.jobs[id]?.taskId;
      if (!taskId) {
        await this.state(item, 'finding');
        let source = await this.findSource(item);
        if (!source || source === 'review') {
          try { await Zotero.Attachments.addAvailableFile(item, {methods:['doi','url','oa']}); } catch (_) {}
          source = await this.findSource(item);
        }
        if (!source || source === 'review') { await this.state(item, source === 'review' ? 'review' : 'missing'); return; }
        await this.ensureServer();
        try { await this.request('GET', '/health', null, 5000); }
        catch (_) { await this.state(item, 'waiting'); this.schedule(id, 60000); return; }
        const existing = await this.request('GET','/api/tasks');
        if (existing.tasks?.some(task => task.active !== false && task.finished !== true)) {
          await this.state(item,'waiting','翻译服务正在处理其他文档');this.schedule(id,15000);return;
        }
        const service = 'bing';
        const binary = await Zotero.File.getBinaryContentsAsync(await source.getFilePathAsync());
        const data = {fileName: item.key + '-original.pdf', fileContent:this.window.btoa(binary), engine:'pdf2zh_next', next_service:service,
          sourceLang:'en',targetLang:'zh-CN',qps:2,poolSize:1,mono:true,dual:false,noMono:false,noDual:true,
          dualMode:'LR',noWatermark:true,disableGlossary:true,autoOcr:true,translateTableText:true,asyncJob:true};
        // Persist submitting state first; uncertain submissions are never automatically resubmitted.
        await this.state(item, 'translating');
        const accepted = await this.request('POST', '/translate', data, 60000);
        if (accepted.status !== 'accepted' || !accepted.taskId) throw new Error(accepted.message || '翻译服务未接受任务');
        taskId = accepted.taskId;
        this.jobs[id].taskId = taskId;
        await this.save();
      }
      const started = Date.now();
      while (this.alive && Date.now() - started < 3600000) {
        item = await Zotero.Items.getAsync(id);
        if (!item || item.deleted) { await this.abandon(id); return; }
        let task;
        try {
          const result = await this.request('GET', '/api/tasks');
          task = result.tasks?.find(task => task.taskId === taskId);
          if (!task) {
            const history = await this.request('GET', '/api/history');
            task = history.history?.find(task => task.taskId === taskId);
          }
        } catch (_) {
          await this.state(item,'waiting','连接暂时中断，将恢复查询原任务，不会重复提交');this.schedule(id,60000);return;
        }
        if (!task || ['failed','error','失败'].includes(task.status)) {
          this.jobs[id].retryFresh = true;
          throw new Error(task ? (task.error || task.message || '翻译失败') : '服务已重启或任务记录不存在；请检查输出后手动重试');
        }
        if (['completed','success','完成'].includes(task.status)) {
          await this.state(item, 'importing');
          const files = task.fileList || task.result?.fileList || [];
          const dual = files.find(f => WorkflowCore.isChinese(typeof f === 'string' ? f : f.fileName));
          if (!dual) {this.jobs[id].retryFresh=true;throw new Error('翻译任务未返回独立中文 PDF，请重试生成中文译文');}
          const filename = typeof dual === 'string' ? dual : dual.fileName;
          const response = await Zotero.HTTP.request('GET', PublicConfig.serviceURL + '/translatedFile/' + encodeURIComponent(filename), {followRedirects:false,anon:true,noCache:true,errorDelayMax:0,responseType:'arraybuffer',timeout:60000,headers:PublicConfig.headers()});
          const bytes = new Uint8Array(response.response);
          if (String.fromCharCode(...bytes.slice(0,5)) !== '%PDF-') throw new Error('返回文件不是 PDF');
          const path = PathUtils.join(this.root, item.key + '-zh.pdf');
          await IOUtils.write(path, bytes);
          try { await Zotero.Attachments.importFromFile({file:path,parentItemID:item.id,title:'中文译文 PDF（独立阅读）',fileBaseName:item.key + '-zh'}); }
          finally { await IOUtils.remove(path, {ignoreAbsent:true}); }
          await this.state(item, 'done'); return;
        }
        await Zotero.Promise.delay(4000);
      }
      if (this.alive) { await this.state(item,'waiting','任务仍在运行，将继续查询进度'); this.schedule(id,60000); }
    } catch (error) {
      if (item && !item.deleted) await this.state(item, 'failed', String(error.message || error).slice(0,350));
      Zotero.logError(error);
    } finally { this.busy = false; }
  }
  installMenu() {
    const doc = this.window.document;
    const menu = doc.getElementById('menu_ToolsPopup');
    if (!menu) return;
    const entry = doc.createXULElement('menuitem');
    entry.id = 'paper-companion-run';entry.setAttribute('label','补全原文并生成独立中文 PDF（选中条目）');
    entry.addEventListener('command', async () => {
      for (let item of this.window.ZoteroPane.getSelectedItems()) {
        if (item.isAttachment()) item = Zotero.Items.get(item.parentItemID);
        if (!item?.isRegularItem() || item.libraryID !== Zotero.Libraries.userLibraryID) continue;
        if (this.jobs[item.id]?.status === 'translating') continue;
        await this.enqueue(item);
      }
    });
    menu.appendChild(entry);
    const summary=doc.createXULElement('menuitem');summary.id='paper-companion-summary';summary.setAttribute('label','查看或生成关键总结（可编辑）');
    summary.addEventListener('command',async()=>{let item=this.window.ZoteroPane.getSelectedItems()[0];if(item?.parentItemID)item=Zotero.Items.get(item.parentItemID);if(item?.isRegularItem())await this.metadata.openNote(item);});menu.appendChild(summary);
    const metric=doc.createXULElement('menuitem');metric.id='paper-companion-metrics';metric.setAttribute('label','刷新本地期刊指标（免注册）');metric.addEventListener('command',()=>this.metrics?.scan(true).catch(e=>Zotero.logError(e)));menu.appendChild(metric);
    const update=doc.createXULElement('menuitem');update.id='companion-metrics-update';update.setAttribute('label','检查免费期刊数据更新');update.addEventListener('command',async()=>{await this.metrics?.updater.check(true);this.metrics?.updater.show();});menu.appendChild(update);
    const info=doc.createXULElement('menuitem');info.id='companion-metrics-info';info.setAttribute('label','期刊数据版本与更新状态');info.addEventListener('command',()=>this.metrics?.updater.show());menu.appendChild(info);
  }
  installColumns() {}
  async showColumns() {
    const view=this.window.ZoteroPane.itemsView;if(!view)return;
    const prefs=view._getColumnPrefs();
    for(const column of view.getColumns())if(column.dataKey==='publicationTitle'||/keySummary|titleTranslation|remark$|localIF|localJCR|localCAS/.test(column.dataKey)) {
      prefs[column.dataKey]={...prefs[column.dataKey],hidden:false};
    }
    for(const column of view.getColumns())if(/zoterostyle-remark$/.test(column.dataKey))prefs[column.dataKey]={...prefs[column.dataKey],hidden:false};
    for(const column of view.getColumns())if(/zoterostyle.*(?:publicationTags|IF)$/.test(column.dataKey))prefs[column.dataKey]={...prefs[column.dataKey],hidden:true};
    view._storeColumnPrefs(prefs);await view._resetColumns();
  }
  async stop() {
    this.alive = false;
    if (this.observer) Zotero.Notifier.unregisterObserver(this.observer);
    for (const timer of this.timers.values()) this.window.clearTimeout(timer);
    this.window.document.getElementById('paper-companion-run')?.remove();
    this.window.document.getElementById('paper-companion-summary')?.remove();
    this.window.document.getElementById('paper-companion-metrics')?.remove();
    this.window.document.getElementById('companion-metrics-update')?.remove();
    this.window.document.getElementById('companion-metrics-info')?.remove();
    if (this.columnKey) Zotero.ItemTreeManager.unregisterColumn(this.columnKey);
    this.readingPane?.stop();
    await this.enrichment?.stop();
    this.metadata?.stop();
    await this.companions?.stop();
    await this.metrics?.stop();
  }
};
