// SPDX-License-Identifier: AGPL-3.0-only
var MetadataCore = {
  escape(value) { return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },
  getExtra(extra,key) {
    const lines=String(extra || '').split('\n').filter(line=>line.slice(0,line.indexOf(':')).trim().toLowerCase()===key.toLowerCase());
    return lines.map(line=>line.slice(line.indexOf(':')+1).trim()).find(Boolean)||'';
  },
  setExtraIfEmpty(extra,key,value) {
    if (this.getExtra(extra,key) || !value) return extra || '';
    const replacement=`${key}: ${String(value).replace(/\s+/g,' ').trim()}`;
    let inserted=false;
    const lines=String(extra||'').split('\n').filter(Boolean).map(line=>{
      if(line.slice(0,line.indexOf(':')).trim().toLowerCase()!==key.toLowerCase())return line;
      if(inserted)return null;inserted=true;return replacement;
    }).filter(line=>line!==null);
    if(!inserted)lines.push(replacement);return lines.join('\n');
  },
  selectEvidence(text,max=14000) {
    if (text.length<=max) return {text,clipped:false};
    const start=Math.floor(max*0.6);
    return {text:text.slice(0,start)+'\n[中间内容未提供]\n'+text.slice(-(max-start)),clipped:true};
  },
  utf8Size(text) {
    let size=0;for(const character of text){const n=character.codePointAt(0);size+=n<128?1:n<2048?2:n<65536?3:4;}return size;
  },
  fitInput(system,prefix,evidence,schema,maxBytes=13500) {
    const points=Array.from(evidence);let limit=points.length,selected=evidence,clipped=false;
    for(;;) {
      const prompt=prefix+'\n<document>\n'+selected+'\n</document>';
      const bytes=this.utf8Size(JSON.stringify({system,prompt,format:schema}));
      if(bytes<=maxBytes)return {prompt,bytes,clipped};
      limit=Math.floor(limit*0.8);if(limit<100)throw new Error('标题或提示长度超过本地模型预算');
      const first=Math.floor(limit*0.6);
      selected=points.slice(0,first).join('')+'\n[中间材料未提供，仅基于节选总结]\n'+points.slice(-(limit-first)).join('');clipped=true;
    }
  },
  shouldGenerate(state,noteExists) { return !state?.noteID && !noteExists; },
  noteHTML(summary,coverage,date) {
    const e=value=>this.escape(value);
    return '<div><h1>关键总结（本地 AI · 可编辑）</h1><p>'+e(summary.one_sentence)+'</p>'+
      [['研究问题',summary.research_question],['方法',summary.methods],['主要发现',summary.findings],['局限与未说明事项',summary.limitations]]
        .map(([heading,value])=>`<h2>${heading}</h2><p>${e(value || '所提供材料未明确说明。')}</p>`).join('')+
      `<h2>我的补充</h2><p>可直接编辑这篇笔记；自动处理不会覆盖你的修改。</p><hr/><p>来源范围：${e(coverage)}。本地模型 Qwen3 4B；${e(date)}。这是 AI 草稿，重要结论请核对原文；没有读取的部分不代表没有相关内容。</p></div>`;
  }
};
