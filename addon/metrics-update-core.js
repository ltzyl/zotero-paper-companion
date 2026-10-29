// SPDX-License-Identifier: AGPL-3.0-only
var MetricsUpdateCore = {
  due(state,now=Date.now()){return !state.lastAttempt||now-state.lastAttempt>(state.status==='failed'?86400000:604800000);},
  casYear(html){
    const plain=String(html).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
    const years=new Set([...plain.matchAll(/中科院分区\s*[(（][^()（）]{0,80}?(20\d{2})(?:[.年）)])/g)].map(m=>m[1]));
    if(years.size!==1)throw new Error('来源未明确提供唯一的中科院分区年份，保留旧数据');
    const year=[...years][0];if(+year<2020||+year>new Date().getFullYear())throw new Error('中科院年份异常');return year;
  },
  validate(data,base){
    if(data?.schema!==1||!data.records||!data.aliases||!/^20\d{2}$/.test(data.casYear)||typeof data.version!=='string'||data.version.length>100)throw new Error('数据结构不完整');
    if(+data.casYear<2020||+data.casYear>new Date().getFullYear()||JSON.stringify(data.categories)!==JSON.stringify(base.categories)||data.sourceURL!==base.sourceURL)throw new Error('数据来源或分类标记异常');
    const ids=Object.keys(data.records),names=Object.keys(data.aliases);
    if(ids.length<Math.max(10000,Object.keys(base.records).length*.8)||ids.length>150000||names.length<ids.length||names.length>1000000)throw new Error('数据数量异常，拒绝替换现有数据');
    for(const id of ids){
      const r=data.records[id];if(!/^\d{7}[\dx]$/.test(id)||!r||typeof r!=='object'||Array.isArray(r))throw new Error('期刊标识无效');
      if(r.A!==undefined&&(!Number.isFinite(r.A)||r.A<0||r.A>10000))throw new Error('影响因子值异常');
      if(r.C!==undefined&&(!Number.isInteger(r.C)||r.C<1||r.C>4))throw new Error('JCR 分区值异常');
      if(r.D!==undefined&&(!Number.isInteger(r.D)||!base.categories[Math.floor(r.D/10)]||r.D%10<1||r.D%10>4))throw new Error('中科院分区值异常');
      if(!['A','C','D'].some(k=>r[k]!==undefined))throw new Error('空指标记录');
    }
    for(const name of names)if(['__proto__','prototype','constructor'].includes(name)||name.length>500||!data.records[data.aliases[name]])throw new Error('期刊别名映射异常');
    return true;
  },
  convert(titleFile,journalFile,commit,page,base){
    if(!/^[a-f0-9]{40}$/.test(commit?.sha))throw new Error('来源提交标识无效');
    const date=Date.parse(commit?.commit?.committer?.date);
    if(!Number.isFinite(date)||date>Date.now()+86400000||date<Date.UTC(2020,0,1))throw new Error('来源时间异常');
    if(!titleFile?.jtitle||!journalFile?.jssn)throw new Error('下载文件不是期刊数据');
    const records=Object.create(null),aliases=Object.create(null);
    for(const [id,r] of Object.entries(journalFile.jssn))if(r&&typeof r==='object'&&['A','C','D'].some(k=>r[k]!==undefined)){
      records[id]={};for(const k of ['A','C','D'])if(r[k]!==undefined)records[id][k]=r[k];
    }
    for(const [name,id] of Object.entries(titleFile.jtitle))if(typeof id==='string'&&records[id])aliases[name]=id;
    const data={schema:1,version:new Date(date).toISOString().slice(0,10)+' / '+commit.sha.slice(0,8),revision:commit.sha,sourceDate:new Date(date).toISOString(),casYear:this.casYear(page),source:'SCI Great public free journal data; immutable GitHub snapshot; no account or API key',sourceURL:'https://www.scigreat.com/s/app/?t=zotbox-vip',categories:base.categories,records,aliases};
    this.validate(data,base);return data;
  },
  content(data){return JSON.stringify([data.casYear,Object.keys(data.records).sort().map(k=>[k,data.records[k].A??null,data.records[k].C??null,data.records[k].D??null]),Object.keys(data.aliases).sort().map(k=>[k,data.aliases[k]])]);}
};
