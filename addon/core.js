// SPDX-License-Identifier: AGPL-3.0-only
var WorkflowCore = {
  isChinese(filename) { return /[._-](?:zh|mono)\.pdf$/i.test(filename); },
  isDual(filename) { return /[._-]dual\.pdf$/i.test(filename); },
  isBilingual(filename) { return this.isDual(filename) || /[._-](?:crop-)?compare\.pdf$/i.test(filename); },
  targetCollectionIDs(collections, keys) {
    const ids = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of collections) if (!c.deleted && !ids.has(c.id) && (keys.includes(c.key) || ids.has(c.parentID))) {
        ids.add(c.id); changed = true;
      }
    }
    return ids;
  },
  inCollections(ids, scope) { return ids.some(id => scope.has(id)); },
  shouldQueue(item, cutoff) {
    return !!(item.personal && item.regular && item.paper && item.created >= cutoff);
  },
  isSource(title, filename) {
    return !this.isChinese(filename) && !this.isBilingual(filename) && !/(supplement|supporting\s+information|appendix|补充|附录|中英对照|[._-](?:mono|dual-cut|mono-cut)\.pdf)/i.test(title + ' ' + filename);
  },
  inspectText(title, text, pages) {
    if (!text || text.length < 800 || !pages) return 'review';
    const normalize = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
    const words = normalize(title).split(' ').filter(w => w.length >= 4);
    const normalized = normalize(text.slice(0, 18000));
    if (words.length < 3 || words.filter(w => normalized.includes(w)).length / words.length < 0.75) return 'review';
    if (/(?:^|\n)\s*(?:supplemental|supplementary|supporting)\s+(?:information|material|data)\s*(?:\n|$)/im.test(text.slice(0, 2000))) return 'review';
    if (!/(?:^|\n)\s*(?:\d+(?:\.\d+)*[.)]?\s*[|│]?\s*)?(?:introduction|methods|materials and methods|results|discussion|conclusions?|background)\b/im.test(text)) return 'review';
    return 'ready';
  }
};
