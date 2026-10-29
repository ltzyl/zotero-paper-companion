# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic, allowlisted archives; never package a local Zotero profile."""
import hashlib,json,pathlib,re,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
ADDON='bootstrap.js companions.js core.js enrichment.js journal-data.js manifest.json metadata-core.js metadata.js metrics-core.js metrics-update-core.js metrics-updater.js metrics.js pane-core.js public-config.js reading-pane.js references-core.js workflow.js citation-graph.html'.split()
SERVICE=['service/server.py','service/install.py','service/bing_compat.py','LICENSE','THIRD_PARTY.md','PRIVACY.md','README.md','docs/ARCHITECTURE.md','docs/demo.svg','examples/demo.html','examples/fictional-library.json']

def audit(files):
 for name in files:
  p=ROOT/name
  if not p.is_file() or p.is_symlink():raise ValueError('Missing or linked source: '+name)
  text=p.read_text()
  for pattern in [r'/Users/[^/\s]+/',r'(?i)[A-Z]:\\Users\\',r'gh[pousr]_[A-Za-z0-9]{20,}',r'github_pat_[A-Za-z0-9_]{20,}',r'sk-[A-Za-z0-9]{24,}']:
   if re.search(pattern,text):raise ValueError('Potential private value in '+name)

def archive(dest,files,prefix=''):
 with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED) as z:
  for name in sorted(files):
   entry=zipfile.ZipInfo(name.removeprefix(prefix),(2026,1,1,0,0,0));entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=0o100644<<16
   z.writestr(entry,(ROOT/name).read_bytes())

def main():
 manifest=json.loads((ROOT/'addon/manifest.json').read_text());version=manifest['version'];dest=ROOT/'dist';dest.mkdir(exist_ok=True)
 files=['addon/'+n for n in ADDON]+SERVICE;audit(files)
 xpi=dest/f'paper-companion-{version}.xpi';runtime=dest/f'paper-companion-runtime-{version}.zip'
 archive(xpi,['addon/'+n for n in ADDON],prefix='addon/');archive(runtime,SERVICE)
 digest=hashlib.sha256(xpi.read_bytes()).hexdigest()
 updates={'addons':{manifest['applications']['zotero']['id']:{'updates':[{'version':version,'update_link':f'https://github.com/ltzyl/zotero-paper-companion/releases/download/v{version}/{xpi.name}','update_hash':'sha256:'+digest,'applications':{'zotero':{'strict_min_version':'10.0','strict_max_version':'10.*'}}}]}}}
 (ROOT/'updates.json').write_text(json.dumps(updates,indent=2)+'\n');(dest/'updates.json').write_bytes((ROOT/'updates.json').read_bytes())
 (dest/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in [xpi,runtime,dest/'updates.json']))
 print('Built and audited:',xpi.name,runtime.name)
if __name__=='__main__':main()
