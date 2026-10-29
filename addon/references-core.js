// SPDX-License-Identifier: AGPL-3.0-only
var ReferenceCore = {
  doi(s) {return String(s||'').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//,'').replace(/^doi:\s*/,'').trim().replace(/[.,;]+$/,'');},
  title(s) {return String(s||'').toLowerCase().replace(/-\s*\n\s*/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();},
  extract(text) {
    const headings=[...String(text).matchAll(/(?:^|\n)\s*(?:\d+\.?\s+)?(?:references|bibliography|literature cited|参考文献)\s*\n/gim)];
    if(!headings.length)return {dois:[],text:'',status:'no-reference-heading'};
    const last=headings.find(h=>h.index>text.length*.25)||headings[0];
    // Keep only the bibliography, excluding clearly headed later supplements.
    const refs=text.slice(last.index+last[0].length).split(/\n\s*(?:\d+[.)]?\s+)?(?:supplementary (?:information|material)|supporting information|appendix(?: [A-Z0-9]+)?|acknowledg(?:e)?ments?|author contributions|data availability|funding|competing interests|conflict of interest)\s*\n/i)[0];
    const joined=refs.replace(/(10\.\d{4,9}\/[^\s]*[/.-])\s*\n\s*(\S+)/g,'$1$2');
    const dois=[...new Set((joined.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi)||[]).map(x=>this.doi(x).replace(/\)+$/,s=>{const opens=(x.match(/\(/g)||[]).length;return opens?s:'';})))];
    const titles=refs.replace(/(?:^|\n)\s*references\s*\n/gi,'\n').split(/[.!?]\s+/).map(s=>this.title(s));
    return {dois,text:this.title(refs),titles,status:'parsed'};
  },
  edges(nodes,records) {
    const result=[];
    for(const source of nodes) {
      const r=records[source.key];if(!r)continue;
      for(const target of nodes) {
        if(source.key===target.key || (source.doi&&this.doi(source.doi)===this.doi(target.doi)))continue;
        const doi=target.doi&&this.doi(target.doi), title=this.title(target.title);
        let evidence='';
        if(doi&&r.dois?.includes(doi))evidence='参考文献 DOI：'+doi;
        else if(title.length>=45&&title.split(' ').length>=6&&r.titles?.includes(title))evidence='参考文献完整标题：'+target.title;
        if(evidence)result.push({source:source.key,target:target.key,evidence});
      }
    }
    return result;
  }
};
