# SPDX-License-Identifier: AGPL-3.0-only
"""Private, resumable runtime installer and owner of local child process groups.

This module deliberately uses only Python's standard library. It runs after the
native Zotero bootstrap has verified uv and provisioned the pinned Python.
"""
import argparse
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import posixpath
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request


def atomic_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        with contextlib.suppress(FileNotFoundError): os.unlink(name)


class Progress:
    def __init__(self, root): self.path = pathlib.Path(root) / 'progress.json'
    def write(self, phase, status, detail, **counts):
        data = dict(phase=phase, status=status, detail=detail)
        for key in ('completed', 'total'):
            if key in counts and isinstance(counts[key], int): data[key] = counts[key]
        atomic_json(self.path, data)


class InstallLock:
    """Kernel lock survives crashes without trusting or killing historical PIDs."""
    def __init__(self, root): self.path = pathlib.Path(root) / 'manager.lock'
    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.stream = self.path.open('a+')
        os.chmod(self.path, 0o600)
        try: fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.stream.close()
            raise RuntimeError('A runtime manager is already active') from None
        return self
    def __exit__(self, *args):
        fcntl.flock(self.stream, fcntl.LOCK_UN)
        self.stream.close()


def safe_extract(archive, target):
    """Validate every path and link before writing; permit internal file links."""
    target = pathlib.Path(target).resolve()
    with tarfile.open(archive, 'r:*') as tar:
        members = tar.getmembers()
        if len(members) > 100000 or sum(m.size for m in members) > 4 * 1024**3:
            raise ValueError('Archive exceeds extraction limit')
        by_name = {}
        for item in members:
            name = pathlib.PurePosixPath(item.name)
            if name.is_absolute() or '..' in name.parts or not (item.isdir() or item.isfile() or item.issym() or item.islnk()):
                raise ValueError('Unsafe archive member')
            canonical = posixpath.normpath(item.name)
            if canonical == '.' and item.isdir(): continue
            if canonical in by_name: raise ValueError('Duplicate archive member')
            by_name[canonical] = item
            dest = target / canonical
            # Reject existing links as well as traversal through archive links.
            for path in (dest, *dest.parents):
                if path == target.parent: break
                if path.is_symlink(): raise ValueError('Existing extraction link')
        for name in by_name:
            for parent in pathlib.PurePosixPath(name).parents:
                if str(parent) in by_name and not by_name[str(parent)].isdir():
                    raise ValueError('Archive member parent is not a directory')
        resolved = {}
        def resolve_link(name, chain):
            if name in chain: raise ValueError('Cyclic archive link')
            item = by_name.get(name)
            if item is None: raise ValueError('Archive link target missing')
            if item.isfile(): return name
            if not (item.issym() or item.islnk()): raise ValueError('Archive link must point to a file')
            if pathlib.PurePosixPath(item.linkname).is_absolute(): raise ValueError('Absolute archive link')
            base = posixpath.dirname(name) if item.issym() else ''
            link = posixpath.normpath(posixpath.join(base, item.linkname))
            if link == '..' or link.startswith('../'): raise ValueError('Archive link escapes destination')
            return resolve_link(link, chain | {name})
        for name, item in by_name.items():
            if item.issym() or item.islnk(): resolved[name] = resolve_link(name, set())
        # Regular content is extracted first; links never serve as write paths.
        for name, item in by_name.items():
            dest = target / name
            if item.isdir(): dest.mkdir(parents=True, exist_ok=True, mode=0o700)
            elif item.isfile():
                dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with tar.extractfile(item) as src, dest.open('wb') as out: shutil.copyfileobj(src, out)
                dest.chmod(0o700 if item.mode & 0o111 else 0o600)
        for name, terminal in resolved.items():
            item = by_name[name];dest = target / name
            dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if item.issym(): dest.symlink_to(item.linkname)
            else: os.link(target / terminal, dest)


def file_hash(path, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with pathlib.Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    return digest.hexdigest()


def verify_asset(asset, path):
    path = pathlib.Path(path)
    algorithm = 'sha256' if 'sha256' in asset else 'sha3_256'
    return path.is_file() and ('size' not in asset or path.stat().st_size == asset['size']) and file_hash(path, algorithm) == asset[algorithm]


def apply_path_patches(site, manifest):
    """Patch only the exact pinned sources; never import user config defaults."""
    site = pathlib.Path(site).resolve()
    for patch in manifest['engine']['pathPatches']:
        target = (site / patch['path']).resolve()
        if site not in target.parents: raise RuntimeError('Unsafe dependency path patch')
        current = file_hash(target)
        if current == patch['patchedSHA256']: continue
        if current != patch['sourceSHA256']: raise RuntimeError('Unexpected dependency source for managed path patch')
        text = target.read_text()
        for replacement in patch['replacements']:
            if text.count(replacement['before']) != 1: raise RuntimeError('Dependency path patch does not match source')
            text = text.replace(replacement['before'],replacement['after'])
        data = text.encode()
        if hashlib.sha256(data).hexdigest() != patch['patchedSHA256']: raise RuntimeError('Dependency path patch checksum mismatch')
        temp = target.with_name(target.name+'.paper-companion.tmp')
        temp.write_bytes(data);temp.chmod(0o600);temp.replace(target)


def download(asset, target, progress, phase, check=lambda: None, allow_loopback=False):
    target = pathlib.Path(target)
    if verify_asset(asset, target): return
    parsed = urllib.parse.urlsplit(asset['url'])
    if parsed.scheme != 'https' and not (allow_loopback and parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'):
        raise ValueError('Downloads require HTTPS')
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    partial = target.with_name(target.name + '.partial')
    # Reuse only completed, verified files. An interrupted HTTP transfer restarts;
    # Ollama's much larger model layer downloads support their own resumption.
    try:
        with urllib.request.urlopen(asset['url'], timeout=30) as response, partial.open('wb') as out:
            if urllib.parse.urlsplit(response.url).scheme != parsed.scheme: raise ValueError('Unsafe download redirect')
            completed = 0
            total = asset.get('size') or int(response.headers.get('Content-Length') or 0)
            while True:
                check()
                chunk = response.read(1024 * 1024)
                if not chunk: break
                out.write(chunk); completed += len(chunk)
                if total and completed > total: raise ValueError('Download exceeds expected size')
                progress.write(phase, 'running', 'Downloading verified runtime resource', completed=completed, **({'total':total} if total else {}))
        if not verify_asset(asset, partial): raise ValueError('Runtime resource checksum mismatch')
        partial.chmod(0o600); partial.replace(target)
    finally:
        with contextlib.suppress(FileNotFoundError): partial.unlink()


def consume_pull(stream, progress, check=lambda: None):
    success = False
    for line in stream:
        check()
        if len(line) > 65536: raise ValueError('Invalid model progress message')
        data = json.loads(line)
        if data.get('error'): raise RuntimeError(str(data['error'])[:200])
        counts = {k:data[k] for k in ('completed','total') if isinstance(data.get(k),int)}
        if counts: progress.write('model', 'running', 'Downloading Qwen3 model layer', **counts)
        if data.get('status') == 'success': success = True
    if not success: raise RuntimeError('Model download incomplete')


def process_identity(pid):
    if pid <= 1: return None
    try:
        proc = pathlib.Path('/proc') / str(pid) / 'stat'
        if proc.exists(): return proc.read_text().rsplit(')',1)[1].split()[19]
        result = subprocess.run(['/bin/ps','-p',str(pid),'-o','lstart='], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=3)
        return result.stdout.strip() or None
    except (OSError, subprocess.SubprocessError): return None


class ParentWatch:
    def __init__(self, pid):
        self.pid = pid; self.identity = process_identity(pid); self.direct = os.getppid() == pid
        if not self.identity: raise RuntimeError('Parent process is unavailable')
    def alive(self):
        return (not self.direct or os.getppid() == self.pid) and self.identity == process_identity(self.pid)


def child_status_without_reaping(pid):
    """WNOWAIT reserves an exited leader's PID until its whole group is closed."""
    if hasattr(os, 'waitid'):
        result = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if result is None: return None
        return result.si_status if result.si_code == os.CLD_EXITED else -result.si_status
    if sys.platform != 'darwin': raise RuntimeError('Non-reaping child supervision is unavailable')
    # Darwin's siginfo_t layout and waitid flags are defined by sys/signal.h and
    # sys/wait.h. Python on macOS omits waitid, so call the same libc API directly.
    class Sigval(ctypes.Union):
        _fields_ = [('integer', ctypes.c_int), ('pointer', ctypes.c_void_p)]
    class Siginfo(ctypes.Structure):
        _fields_ = [('signo',ctypes.c_int),('error',ctypes.c_int),('code',ctypes.c_int),('pid',ctypes.c_int),('uid',ctypes.c_uint),('status',ctypes.c_int),('address',ctypes.c_void_p),('value',Sigval),('band',ctypes.c_long),('padding',ctypes.c_ulong * 7)]
    info = Siginfo();libc = ctypes.CDLL(None, use_errno=True)
    waitid = libc.waitid;waitid.argtypes = [ctypes.c_int,ctypes.c_uint,ctypes.POINTER(Siginfo),ctypes.c_int];waitid.restype = ctypes.c_int
    if waitid(1,pid,ctypes.byref(info),0x04 | 0x01 | 0x20):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if info.pid == 0: return None
    return info.status if info.code == 1 else -info.status


class Children:
    def __init__(self, root): self.root=pathlib.Path(root); self.children=[]; self.logs=[]; self.lock=threading.RLock(); self.closed=False
    def start(self, command, env=None, cwd=None):
        with self.lock:
            if self.closed: raise Cancelled('Runtime process owner has stopped')
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            log=(self.root/'runtime.log').open('ab');os.chmod(self.root/'runtime.log',0o600);self.logs.append(log)
            child=subprocess.Popen([str(x) for x in command],env=env,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            self.children.append(child);return child
    def poll(self, child):
        with self.lock:
            if child not in self.children: return child.returncode
            return child_status_without_reaping(child.pid)
    def close(self):
        with self.lock:
            self.closed=True
            # Do not poll/wait (reap) before the final group signal. An unreaped
            # group leader reserves its PID, so the group ID cannot be reused.
            live=[child for child in self.children if child.returncode is None]
            for child in live:
                with contextlib.suppress(ProcessLookupError,PermissionError): os.killpg(child.pid,signal.SIGTERM)
            if live: time.sleep(.3)
            for child in live:
                with contextlib.suppress(ProcessLookupError,PermissionError): os.killpg(child.pid,signal.SIGKILL)
                child.wait()
            for log in self.logs: log.close()
            self.children=[];self.logs=[]


def validate_health(data, instance, model_url):
    if not (data.get('status')=='ok' and data.get('service')=='paper-companion' and data.get('protocol')==2 and data.get('instance')==instance and data.get('ready') is True and data.get('modelURL')==model_url and all(data.get('components',{}).get(k) is True for k in ('engine','model','assets'))):
        raise ValueError('Managed service identity/readiness mismatch')


def request_json(url, data=None, token=None, timeout=30):
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme!='http' or parsed.hostname!='127.0.0.1' or parsed.username or parsed.password or not parsed.port:
        raise ValueError('Managed API calls require a loopback URL')
    headers={'Content-Type':'application/json'}
    if token: headers['X-Paper-Companion-Token']=token
    request=urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=headers)
    # Loopback calls bypass the user's external HTTP proxy.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request,timeout=timeout) as response: return json.load(response)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));return sock.getsockname()[1]


class Cancelled(RuntimeError): pass


class Manager:
    def __init__(self, root, uv, resources, parent_pid):
        self.root=pathlib.Path(root).resolve();self.resources=pathlib.Path(resources).resolve();self.uv=pathlib.Path(uv).resolve()
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700);self.root.chmod(0o700)
        self.manifest=json.loads((self.resources/'runtime-manifest.json').read_text())
        self.progress=Progress(self.root);self.children=Children(self.root);self.cancelled=threading.Event();self.parent=ParentWatch(parent_pid)
        digest=hashlib.sha256()
        for name in ('runtime-manifest.json','engine-requirements.lock','server.py','bing_compat.py','engine_probe.py'):
            digest.update((self.resources/name).read_bytes())
        self.version=digest.hexdigest()[:24]
        self.data=self.root/'data';self.data.mkdir(exist_ok=True,mode=0o700)
        self.env={k:v for k,v in os.environ.items() if k in ('HOME','PATH','TMPDIR','LANG','LC_ALL','SYSTEMROOT')}
        self.env.update(PAPER_COMPANION_DATA=str(self.data),UV_NO_CONFIG='1',UV_CACHE_DIR=str(self.root/'cache'/'uv'),UV_PYTHON_INSTALL_DIR=str(self.root/'python'),PYTHONNOUSERSITE='1',PYTHONUNBUFFERED='1',MACOSX_DEPLOYMENT_TARGET='14.0')
        self.monitor=threading.Thread(target=self._monitor,daemon=True)
    def _monitor(self):
        while True:
            if self.cancelled.wait(1) or not self.parent.alive():
                self.cancelled.set();self.children.close();return
    def check(self):
        if self.cancelled.is_set(): raise Cancelled('Setup or service was cancelled')
    def command(self, command, timeout=900, env=None, cwd=None):
        self.check();child=self.children.start(command,env=env or self.env,cwd=cwd);deadline=time.monotonic()+timeout
        while (code := self.children.poll(child)) is None:
            self.check()
            if time.monotonic()>deadline: raise RuntimeError('Runtime command timed out; see local runtime.log')
            self.cancelled.wait(.2)
        self.check()
        if code: raise RuntimeError('Runtime command failed; see local runtime.log')
    def current(self):
        pointer=json.loads((self.root/'current.json').read_text());version=pointer.get('version','')
        if len(version)!=24 or any(c not in '0123456789abcdef' for c in version): raise ValueError('Invalid installed runtime pointer')
        path=self.root/'versions'/version
        if not (path/'validated.json').is_file(): raise RuntimeError('Runtime installation is incomplete')
        return path
    def install(self):
        generation=self.version
        if (self.root/'versions'/generation).exists(): generation=secrets.token_hex(12)
        target=self.root/'versions'/generation
        if platform.system()!='Darwin' or platform.machine()!='arm64' or int(platform.mac_ver()[0].split('.')[0])<14: raise RuntimeError('Automatic setup requires macOS 14 or newer on Apple Silicon')
        if platform.python_version()!=self.manifest['python']['version']: raise RuntimeError('Pinned Python runtime is required')
        if shutil.disk_usage(self.root).free < self.manifest['requiredFreeBytes']: raise RuntimeError('Insufficient free disk space for setup; free at least 12 GiB')
        stage=self.root/'staging'/generation;stage.mkdir(parents=True,exist_ok=True,mode=0o700)
        atomic_json(stage/'installing.json',{'version':generation,'fingerprint':self.version,'phase':'engine'})
        engine=stage/'venv';python=engine/'bin'/'python'
        self.progress.write('engine','running','Installing locked translation components')
        if not python.exists(): self.command([self.uv,'venv','--python',sys.executable,str(engine)])
        self.command([self.uv,'pip','sync','--python',python,'--require-hashes','--only-binary',':all:',self.resources/'engine-requirements.lock'],timeout=5400)
        # site-packages is deterministic for this pinned Python minor version.
        site=engine/'lib'/'python3.12'/'site-packages';patch=site/'pdf2zh_next'/'translator'/'translator_impl'/'bing.py'
        shutil.copy2(self.resources/'bing_compat.py',patch)
        apply_path_patches(site,self.manifest)
        service=stage/'service';service.mkdir(exist_ok=True)
        for name in ('server.py','engine_probe.py','bing_compat.py','runtime-manifest.json'): shutil.copy2(self.resources/name,service/name)
        self.progress.write('assets','running','Preparing PDF model, fonts and character maps')
        for asset in self.manifest['resources']:
            self.check();download(asset,self.data/asset['path'],self.progress,'assets',self.check)
        self.progress.write('ollama','running','Installing private model runner')
        archive=self.root/'cache'/'ollama.tgz';download(self.manifest['ollama'],archive,self.progress,'ollama',self.check)
        runner=stage/'ollama'
        if runner.exists(): shutil.rmtree(runner)
        safe_extract(archive,runner)
        executable=runner/self.manifest['ollama']['executable']
        if not executable.is_file(): raise RuntimeError('Verified model runner archive has unexpected layout')
        model_url,ollama=self.start_ollama(stage)
        self.progress.write('model','running','Preparing Qwen3 local model')
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        req=urllib.request.Request(model_url+'/api/pull',data=json.dumps({'model':self.manifest['model']['name'],'stream':True}).encode(),headers={'Content-Type':'application/json'})
        with opener.open(req,timeout=120) as response: consume_pull(response,self.progress,self.check)
        self.validate_model(model_url)
        self.progress.write('validate','running','Checking a fictional PDF and local summary')
        self.command([python,service/'engine_probe.py','--smoke'],timeout=1800)
        result=request_json(model_url+'/api/generate',{'model':self.manifest['model']['name'],'prompt':'/no_think\nReply with the single word ready.','stream':False,'options':{'num_predict':32}},timeout=180)
        if not result.get('response','').strip(): raise RuntimeError('Local model returned no test response')
        self.children.close()
        atomic_json(stage/'validated.json',{'version':generation,'fingerprint':self.version,'modelDigest':self.manifest['model']['digest'],'python':self.manifest['python']['version']})
        # Venv scripts embed their absolute path. Keep this directory fixed, and
        # publish a pointer only after validation instead of relocating the venv.
        target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        # Use a relative symlink as the version pointer; staging is never removed
        # automatically, so an old working installation survives failed retries.
        if not target.exists(): target.symlink_to(pathlib.Path('..')/'staging'/generation,target_is_directory=True)
        atomic_json(self.root/'current.json',{'version':generation})
        (stage/'installing.json').unlink(missing_ok=True)
        self.progress.write('ready','completed','Local runtime is installed')
    def wait_http(self, child, url, predicate, timeout=60, token=None):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            self.check()
            if self.children.poll(child) is not None: raise RuntimeError('Local component exited; see runtime.log')
            try:
                data=request_json(url,token=token,timeout=2)
                if predicate(data): return data
            except (OSError,ValueError): pass
            self.cancelled.wait(.2)
        raise RuntimeError('Local component did not become ready')
    def start_ollama(self, version):
        port=free_port();url=f'http://127.0.0.1:{port}'
        env=dict(self.env,OLLAMA_HOST=f'127.0.0.1:{port}',OLLAMA_MODELS=str(self.root/'models'),OLLAMA_NO_CLOUD='1',OLLAMA_KEEP_ALIVE='5m',OLLAMA_ORIGINS='')
        child=self.children.start([version/'ollama'/self.manifest['ollama']['executable'],'serve'],env=env,cwd=self.root)
        self.wait_http(child,url+'/api/version',lambda data:data.get('version')==self.manifest['ollama']['version'])
        return url,child
    def validate_model(self, url):
        models=request_json(url+'/api/tags').get('models',[])
        match=next((x for x in models if x.get('name')==self.manifest['model']['name']),None)
        if not match or match.get('digest','').removeprefix('sha256:') != self.manifest['model']['digest'].removeprefix('sha256:'): raise RuntimeError('Local Qwen3 model digest does not match pinned release')
    def run(self):
        version=self.current();model_url,ollama=self.start_ollama(version)
        self.validate_model(model_url)
        self.command([version/'venv'/'bin'/'python',version/'service'/'engine_probe.py'],timeout=180)
        instance=secrets.token_hex(24);state=self.root/'state';private=self.root/'bridge-ready.json'
        private.unlink(missing_ok=True)
        bridge=self.children.start([version/'venv'/'bin'/'python',version/'service'/'server.py','--state',state,'--port','0','--instance',instance,'--model-url',model_url,'--ready-file',private],env=self.env,cwd=self.root)
        deadline=time.monotonic()+60
        while not private.exists():
            self.check()
            if self.children.poll(bridge) is not None or time.monotonic()>deadline: raise RuntimeError('Bridge failed to bind or validate')
            self.cancelled.wait(.1)
        connection=json.loads(private.read_text());health=request_json(connection['serviceURL']+'/health',token=connection['token']);validate_health(health,instance,model_url)
        atomic_json(self.root/'connection.json',connection)
        self.progress.write('ready','completed','Local service is ready')
        try:
            while True:
                self.check()
                if self.children.poll(bridge) is not None or self.children.poll(ollama) is not None: raise RuntimeError('A managed local component exited')
                self.cancelled.wait(.5)
        finally:
            # Remove only the connection published by this exact live instance.
            with contextlib.suppress(OSError,ValueError):
                if json.loads((self.root/'connection.json').read_text()).get('instance')==instance: (self.root/'connection.json').unlink()
            private.unlink(missing_ok=True)
    def status(self):
        result={'installed':False,'running':False}
        try: result['installed']=self.current().is_dir()
        except (OSError,ValueError,RuntimeError): pass
        try:
            connection=json.loads((self.root/'connection.json').read_text());health=request_json(connection['serviceURL']+'/health',token=connection['token'],timeout=2);validate_health(health,connection['instance'],connection['modelURL']);result.update(running=True,connection=connection)
        except (OSError,ValueError,KeyError): pass
        return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--uv',required=True);parser.add_argument('--resources',required=True);parser.add_argument('--parent-pid',required=True,type=int);parser.add_argument('command',choices=('install','run','status'));args=parser.parse_args()
    os.umask(0o077)
    manager=Manager(args.root,args.uv,args.resources,args.parent_pid)
    if args.command=='status': print(json.dumps(manager.status()));return 0
    def cancel(*_): manager.cancelled.set()
    for signum in (signal.SIGTERM,signal.SIGINT): signal.signal(signum,cancel)
    try:
        with InstallLock(manager.root):
            manager.monitor.start()
            getattr(manager,args.command)()
        return 0
    except Cancelled:
        manager.progress.write('cancelled','cancelled','Setup or local service stopped');return 130
    except Exception as error:
        # Do not serialize exceptions containing request URLs, headers, or tokens.
        manager.progress.write('error','failed',str(error)[:240] if isinstance(error,(ValueError,RuntimeError)) else 'Setup failed; inspect the private runtime.log')
        return 1
    finally: manager.cancelled.set();manager.children.close()

if __name__=='__main__': sys.exit(main())
