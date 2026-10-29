# SPDX-License-Identifier: AGPL-3.0-only
"""Loopback-only bridge: PDF2zh/Bing for translation; no library data is published.

A random per-install token is required on every request. Browser Origins are
rejected, paths are generated internally, and PDFs stay in the local state dir.
"""
import argparse,base64,concurrent.futures,hashlib,hmac,json,os,pathlib,re,secrets,shutil,subprocess,sys,threading,uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import unquote,urlsplit

MAX_BODY=140*1024*1024
class Bridge:
 def __init__(self,root):
  self.root=pathlib.Path(root).resolve();self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
  self.lock=threading.RLock();self.text_lock=threading.Lock();self.pool=concurrent.futures.ThreadPoolExecutor(max_workers=1);self.jobs={};self.token_path=self.root/'token'
  if not self.token_path.exists():self.token_path.write_text(secrets.token_urlsafe(32));self.token_path.chmod(0o600)
  self.token=self.token_path.read_text().strip()
  if len(self.token)<32:raise ValueError('Invalid local token file')
  for f in self.root.glob('jobs/*/task.json'):
   j=json.loads(f.read_text());
   if j.get('status') in ['running','queued']:j.update(status='failed',error='Service restarted; inspect local output before retrying',active=False,finished=True)
   self.jobs[j['taskId']]=j
 def save(self,j):
  p=self.root/'jobs'/j['taskId']/'task.json';tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(j));tmp.replace(p)
 def submit(self,data):
  raw=base64.b64decode(data['fileContent'],validate=True)
  if len(raw)>100*1024*1024 or not raw.startswith(b'%PDF-'):raise ValueError('Expected PDF smaller than 100 MiB')
  task=uuid.uuid4().hex;folder=self.root/'jobs'/task;folder.mkdir(parents=True,mode=0o700);(folder/'original.pdf').write_bytes(raw)
  j={'taskId':task,'status':'queued','active':True,'finished':False,'fileList':[]};
  with self.lock:self.jobs[task]=j
  self.save(j);self.pool.submit(self.translate_pdf,task)
  return {'status':'accepted','taskId':task}
 def translate_pdf(self,task):
  j=self.jobs[task];folder=self.root/'jobs'/task
  try:
   j['status']='running';self.save(j)
   # Pass arguments as a list; neither document names nor remote text become shell code.
   command=[sys.executable,'-c','from pdf2zh_next.main import cli; cli()','--bing','--lang-in','en','--lang-out','zh-CN','--no-dual','--watermark-output-mode','no_watermark','--no-auto-extract-glossary','--qps','2','--pool-max-workers','1','--output',str(folder),str(folder/'original.pdf')]
   with (folder/'engine.log').open('wb') as log:subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=7200)
   files=list(folder.glob('*.mono.pdf'))
   if len(files)!=1:raise ValueError('Expected exactly one Chinese mono PDF')
   final=folder/'chinese.pdf';shutil.copyfile(files[0],final)
   j.update(status='completed',fileList=[task+'-mono.pdf'])
  except Exception as e:j.update(status='failed',error=str(e)[:200])
  finally:j.update(active=False,finished=True);self.save(j)
 def text(self,value):
  if not isinstance(value,str) or not 0<len(value)<=20000:raise ValueError('Text must contain 1–20000 characters')
  # Import lazily so /health works even before the optional engine is installed.
  from pdf2zh_next.config.model import SettingsModel
  from pdf2zh_next.config.translate_engine_model import BingSettings
  from pdf2zh_next.translator.base_rate_limiter import BaseRateLimiter
  from pdf2zh_next.translator.translator_impl.bing import BingTranslator
  settings=SettingsModel(translate_engine_settings=BingSettings());settings.translation.lang_in='en';settings.translation.lang_out='zh-CN'
  with self.text_lock:translated=BingTranslator(settings,BaseRateLimiter()).translate(value)
  return {'status':'success','result':translated}
 def output(self,name):
  if not re.fullmatch(r'[a-f0-9]{32}-mono\.pdf',name):raise ValueError('Invalid output identifier')
  p=self.root/'jobs'/name[:32]/'chinese.pdf'
  if not p.is_file():raise ValueError('Output unavailable')
  return p

def handler(bridge):
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*args):pass # Do not log titles, tokens, request bodies, or browser URLs.
  def allowed(self):
   host=self.headers.get('Host','').split(':')[0]
   return host in ('127.0.0.1','localhost') and not self.headers.get('Origin') and hmac.compare_digest(self.headers.get('X-Paper-Companion-Token',''),bridge.token)
  def reply(self,status,data):
   body=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  def do_GET(self):
   if not self.allowed():return self.reply(403,{'error':'Forbidden'})
   path=urlsplit(self.path).path
   if path=='/health':return self.reply(200,{'status':'ok','service':'paper-companion','protocol':1})
   if path in ('/api/tasks','/api/history'):
    with bridge.lock:jobs=[dict(j) for j in bridge.jobs.values()]
    return self.reply(200,{'tasks' if path.endswith('tasks') else 'history':jobs})
   if path.startswith('/translatedFile/'):
    try:p=bridge.output(unquote(path.rsplit('/',1)[1]))
    except ValueError:return self.reply(404,{'error':'Not found'})
    self.send_response(200);self.send_header('Content-Type','application/pdf');self.send_header('Content-Length',str(p.stat().st_size));self.end_headers()
    with p.open('rb') as f:shutil.copyfileobj(f,self.wfile)
    return
   return self.reply(404,{'error':'Not found'})
  def do_POST(self):
   if not self.allowed():return self.reply(403,{'error':'Forbidden'})
   try:
    length=int(self.headers.get('Content-Length','0'))
    if not 0<length<=MAX_BODY:raise ValueError('Request size exceeded')
    data=json.loads(self.rfile.read(length));path=urlsplit(self.path).path
    if path=='/translate':result=bridge.submit(data)
    elif path=='/text':result=bridge.text(data.get('text'))
    else:return self.reply(404,{'error':'Not found'})
    self.reply(200,result)
   except (ValueError,KeyError,TypeError):self.reply(400,{'error':'Invalid request'})
   except Exception:self.reply(503,{'error':'Translation failed; inspect local service dependencies/network'})
 return Handler

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--state',default=str(pathlib.Path.home()/'.paper-companion'));parser.add_argument('--port',type=int,default=8891);args=parser.parse_args()
 os.umask(0o077);bridge=Bridge(args.state)
 connection=bridge.root/'connection.json';connection.write_text(json.dumps({'serviceURL':f'http://127.0.0.1:{args.port}','token':bridge.token}));connection.chmod(0o600)
 print('Import this local connection file in Zotero:',connection,flush=True)
 server=ThreadingHTTPServer(('127.0.0.1',args.port),handler(bridge));server.daemon_threads=True
 try:server.serve_forever()
 finally:server.server_close();bridge.pool.shutdown(wait=False,cancel_futures=True)
if __name__=='__main__':main()
