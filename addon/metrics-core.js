// SPDX-License-Identifier: AGPL-3.0-only
var MetricsCore = {
  title(value) {return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&(?:amp;)?/g,'and').replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]/gu,'');},
  issns(value) {
    return [...new Set((String(value||'').match(/\b\d{4}-?\d{3}[\dXx]\b/g)||[]).map(x=>x.replace('-','').toLowerCase()).filter(x=>{
      let sum=0;for(let i=0;i<8;i++)sum+=(x[i]==='x'?10:Number(x[i]))*(8-i);return sum%11===0;
    }))];
  },
  match(data, issn, title) {
    const candidates=new Set();
    for(const id of this.issns(issn)){const key=data.records[id]?id:data.aliases[id];if(key&&data.records[key])candidates.add(key);}
    const name=this.title(title);
    const names=new Set([data.aliases[name],data.aliases[name.replace(/journal/g,'xx').replace(/international/g,'ii')]].filter(Boolean));
    if(names.size>1)return {status:'conflict'};
    const nameKey=[...names][0];
    if(candidates.size>1 || (candidates.size===1&&nameKey&&!candidates.has(nameKey)))return {status:'conflict'};
    const id=candidates.size?[...candidates][0]:nameKey;
    const record=id&&data.records[id];if(!record)return {status:'unmatched'};
    const number=typeof record.A==='number'&&Number.isFinite(record.A)&&record.A>=0?record.A:null;
    const jcr=Number.isInteger(record.C)&&record.C>=1&&record.C<=4?'Q'+record.C:null;
    const category=Number.isInteger(record.D)?data.categories[Math.floor(record.D/10)]:null;
    const quartile=record.D%10;
    const cas=category&&quartile>=1&&quartile<=4?category+' '+quartile+'区':null;
    return {status:number===null&&!jcr&&!cas?'unavailable':'matched',id,method:candidates.size?'ISSN':'期刊名',if:number,jcr,cas};
  },
  fingerprint(title,issn,version){return JSON.stringify([String(title||''),String(issn||''),version]);},
  updateExtra(extra,result,data) {
    const start='[本地期刊指标]',end='[/本地期刊指标]';
    let text=String(extra||'');
    const a=text.indexOf(start),b=text.indexOf(end,a);
    if(a>=0&&b>=a){let left=text.slice(0,a);if(left.endsWith('\n'))left=left.slice(0,-1);text=left+text.slice(b+end.length);}
    if(result.status!=='matched')return text;
    const block=[start,`影响因子: ${result.if??'未收录'}`,`JCR分区: ${result.jcr||'未收录'}`,`中科院（${data.casYear}）: ${result.cas||'未收录'}`,`数据版本: ${data.version}；第三方免费数据，供参考`, `来源: ${data.sourceURL}`,`匹配: ${result.method}；ISSN ${result.id}`,end].join('\n');
    return text+(text&&!text.endsWith('\n')?'\n':'')+block;
  }
};
