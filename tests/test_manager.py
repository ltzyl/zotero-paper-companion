# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic-only installer/process/security regression tests."""
import hashlib, importlib.util, io, json, os, pathlib, signal, subprocess, sys, tarfile, tempfile, threading, time, unittest, urllib.request
from unittest.mock import patch

SERVICE = pathlib.Path(__file__).parents[1] / 'service'
spec = importlib.util.spec_from_file_location('manager', SERVICE / 'manager.py')
m = importlib.util.module_from_spec(spec) if spec else None
if spec and spec.loader and (SERVICE / 'manager.py').exists(): spec.loader.exec_module(m)

class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = pathlib.Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def test_atomic_private_progress_has_no_partial_json(self):
        self.assertTrue(hasattr(m, 'Progress'), 'manager progress writer is required')
        p = m.Progress(self.root)
        p.write('model', 'running', 'Downloading model', completed=3, total=10)
        self.assertEqual(json.loads((self.root/'progress.json').read_text()), {'phase':'model','status':'running','detail':'Downloading model','completed':3,'total':10})
        self.assertEqual((self.root/'progress.json').stat().st_mode & 0o777, 0o600)
    def test_lock_is_exclusive_and_recovers_without_killing_pid(self):
        self.assertTrue(hasattr(m, 'InstallLock'), 'exclusive installation lock is required')
        with m.InstallLock(self.root):
            with self.assertRaisesRegex(RuntimeError, 'already'): 
                with m.InstallLock(self.root): pass
        with m.InstallLock(self.root): pass
    def test_archive_rejects_escape_symlink_and_special_files(self):
        self.assertTrue(hasattr(m, 'safe_extract'), 'safe archive extraction is required')
        for name, kind, link in [('../escape',tarfile.REGTYPE,''),('/escape',tarfile.REGTYPE,''),('link',tarfile.SYMTYPE,'../escape'),('fifo',tarfile.FIFOTYPE,'')]:
            buf=io.BytesIO()
            with tarfile.open(fileobj=buf,mode='w:gz') as tar:
                item=tarfile.TarInfo(name);item.type=kind;item.linkname=link;tar.addfile(item)
            archive=self.root/'bad.tgz';archive.write_bytes(buf.getvalue())
            with self.assertRaises(ValueError): m.safe_extract(archive,self.root/'out')
        self.assertFalse((self.root.parent/'escape').exists())
    def make_archive(self, entries):
        archive=self.root/'fixture.tgz'
        with tarfile.open(archive,'w:gz') as tar:
            for name,kind,value in entries:
                item=tarfile.TarInfo(name);item.type=kind
                if kind in (tarfile.SYMTYPE,tarfile.LNKTYPE):item.linkname=value;tar.addfile(item)
                else:item.size=len(value);tar.addfile(item,io.BytesIO(value))
        return archive
    def test_archive_preserves_ollama_internal_library_symlink(self):
        archive=self.make_archive([('libggml-base.0.dylib',tarfile.SYMTYPE,'libggml-base.0.28.0.dylib'),('libggml-base.0.28.0.dylib',tarfile.REGTYPE,b'fictional-dylib'),('nested/alias',tarfile.SYMTYPE,'../libggml-base.0.dylib')])
        out=self.root/'out';m.safe_extract(archive,out)
        self.assertTrue((out/'libggml-base.0.dylib').is_symlink());self.assertEqual((out/'nested/alias').read_bytes(),b'fictional-dylib')
    def test_archive_rejects_link_escape_chains_and_missing_targets(self):
        for entries in [[('a',tarfile.SYMTYPE,'b'),('b',tarfile.SYMTYPE,'../../escape')],[('a',tarfile.SYMTYPE,'b'),('b',tarfile.SYMTYPE,'a')],[('a',tarfile.SYMTYPE,'missing')],[('a',tarfile.SYMTYPE,'file'),('a/overwrite',tarfile.REGTYPE,b'x'),('file',tarfile.REGTYPE,b'x')]]:
            archive=self.make_archive(entries)
            with self.assertRaises(ValueError):m.safe_extract(archive,self.root/'out')
    def test_download_validates_hash_and_never_promotes_corruption(self):
        self.assertTrue(hasattr(m, 'download'), 'verified downloader is required')
        import http.server
        payload=b'synthetic public fixture'
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self): self.send_response(200);self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
            def log_message(self,*a): pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),H);t=threading.Thread(target=server.serve_forever,daemon=True);t.start()
        try:
            asset={'url':f'http://127.0.0.1:{server.server_port}/asset','sha256':hashlib.sha256(payload).hexdigest(),'size':len(payload)}
            target=self.root/'asset';progress=m.Progress(self.root)
            with self.assertRaises(ValueError): m.download(dict(asset,sha256='0'*64),target,progress,'engine',allow_loopback=True)
            self.assertFalse(target.exists())
            m.download(asset,target,progress,'engine',allow_loopback=True);self.assertEqual(target.read_bytes(),payload)
        finally: server.shutdown();server.server_close();t.join()
    def test_model_pull_checks_errors_and_uses_real_byte_counts(self):
        self.assertTrue(hasattr(m, 'consume_pull'), 'model pull parser is required')
        progress=m.Progress(self.root)
        m.consume_pull(io.BytesIO(b'{"status":"pulling","completed":8,"total":12}\n{"status":"success"}\n'),progress)
        self.assertEqual(json.loads((self.root/'progress.json').read_text())['completed'],8)
        with self.assertRaisesRegex(RuntimeError,'network'): m.consume_pull(io.BytesIO(b'{"error":"network"}\n'),progress)
        with self.assertRaisesRegex(RuntimeError,'incomplete'): m.consume_pull(io.BytesIO(b'{"status":"pulling"}\n'),progress)
    def test_owned_process_group_shutdown_preserves_unowned_process(self):
        self.assertTrue(hasattr(m, 'Children'), 'owned process supervision is required')
        other=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
        children=m.Children(self.root)
        try:
            owned=children.start([sys.executable,'-c','import time;time.sleep(30)'])
            children.close();self.assertIsNotNone(owned.poll());self.assertIsNone(other.poll())
        finally: children.close();other.terminate();other.wait()
    def test_parent_identity_detects_changed_or_missing_parent(self):
        self.assertTrue(hasattr(m, 'ParentWatch'), 'parent identity monitoring is required')
        watch=m.ParentWatch(os.getpid());self.assertTrue(watch.alive())
        with patch.object(m, 'process_identity',return_value=None): self.assertFalse(watch.alive())
        with patch.object(m, 'process_identity',return_value='different-start'): self.assertFalse(watch.alive())
    def test_readiness_rejects_wrong_instance_model_and_missing_components(self):
        self.assertTrue(hasattr(m, 'validate_health'), 'strict readiness validation is required')
        health={'status':'ok','service':'paper-companion','protocol':2,'instance':'fixture','ready':True,'components':{'engine':True,'model':True,'assets':True},'modelURL':'http://127.0.0.1:53211'}
        m.validate_health(health,'fixture',health['modelURL'])
        for data in [dict(health,instance='foreign'),dict(health,modelURL='http://127.0.0.1:11434'),dict(health,components={}),dict(health,ready=False)]:
            with self.assertRaises(ValueError): m.validate_health(data,'fixture',health['modelURL'])
    def test_loopback_api_never_sends_tokens_to_remote_hosts(self):
        self.assertTrue(hasattr(m, 'request_json'), 'local API client is required')
        for url in ['https://example.invalid/health','http://127.0.0.1.example.invalid/health','http://user:secret@127.0.0.1:1234/health']:
            with self.assertRaises(ValueError):m.request_json(url,token='synthetic-secret')
    def test_cancelled_children_cannot_start_a_new_process(self):
        self.assertTrue(hasattr(m, 'Children'), 'owned process supervision is required')
        children=m.Children(self.root);children.close()
        with self.assertRaises(RuntimeError): children.start([sys.executable,'-c','pass'])
    def test_shutdown_kills_descendant_that_ignores_sigterm(self):
        self.assertTrue(hasattr(m, 'Children'), 'owned process supervision is required')
        children=m.Children(self.root);heartbeat=self.root/'heartbeat'
        grandchild="import signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);p=pathlib.Path(%r);\nwhile True:p.write_text(str(time.monotonic()));time.sleep(.03)" % str(heartbeat)
        script="import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',%r]);time.sleep(30)" % grandchild
        children.start([sys.executable,'-c',script])
        deadline=time.monotonic()+5
        while not heartbeat.exists() and time.monotonic()<deadline: time.sleep(.02)
        self.assertTrue(heartbeat.exists());children.close();before=heartbeat.read_text();time.sleep(.1);self.assertEqual(heartbeat.read_text(),before)
    def test_exited_leader_retains_owned_group_until_descendants_stop(self):
        children=m.Children(self.root);heartbeat=self.root/'heartbeat';pidfile=self.root/'descendant.pid'
        grandchild="import os,signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path(%r).write_text(str(os.getpid()));p=pathlib.Path(%r);\nwhile True:p.write_text(str(time.monotonic()));time.sleep(.03)" % (str(pidfile),str(heartbeat))
        script="import subprocess,sys;subprocess.Popen([sys.executable,'-c',%r]);sys.exit(7)" % grandchild
        leader=children.start([sys.executable,'-c',script])
        try:
            deadline=time.monotonic()+5
            while (not heartbeat.exists() or children.poll(leader) is None) and time.monotonic()<deadline:time.sleep(.02)
            self.assertEqual(children.poll(leader),7)
            self.assertIsNone(leader.returncode,'poll must leave the leader unreaped and reserve its PID')
            children.close();before=heartbeat.read_text();time.sleep(.12);self.assertEqual(heartbeat.read_text(),before)
        finally:
            children.close()
            if pidfile.exists():
                with __import__('contextlib').suppress(ProcessLookupError):os.kill(int(pidfile.read_text()),signal.SIGKILL)
    def test_loopback_api_does_not_follow_authenticated_redirects(self):
        import http.server,urllib.error
        seen=[]
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path=='/start':self.send_response(302);self.send_header('Location','/destination');self.end_headers()
                else:seen.append(self.headers.get('X-Paper-Companion-Token'));self.send_response(200);self.end_headers();self.wfile.write(b'{}')
            def log_message(self,*args):pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),H);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with self.assertRaises(urllib.error.HTTPError):m.request_json(f'http://127.0.0.1:{server.server_port}/start',token='synthetic-token')
            self.assertEqual(seen,[])
        finally:server.shutdown();server.server_close();thread.join()
    def make_manager(self):return m.Manager(self.root/'managed',self.root/'uv',SERVICE,os.getpid())
    @unittest.skipUnless(os.environ.get('PAPER_COMPANION_TEST_UV') and os.environ.get('PAPER_COMPANION_TEST_PYTHON'), 'set PAPER_COMPANION_TEST_UV and PAPER_COMPANION_TEST_PYTHON to run pinned uv integration')
    def test_uv_install_ignores_discovered_config_after_environment_filter(self):
        manager=m.Manager(self.root/'managed',os.environ['PAPER_COMPANION_TEST_UV'],SERVICE,os.getpid())
        (self.root/'uv.toml').write_text('required-version = "<0.1"\npython-downloads = "never"\n')
        command=[str(manager.uv),'venv','--managed-python','--python',os.environ['PAPER_COMPANION_TEST_PYTHON'],str(self.root/'venv')]
        inherited=dict(manager.env);inherited.pop('UV_NO_CONFIG',None)
        blocked=subprocess.run(command,cwd=self.root,env=inherited,capture_output=True,text=True,timeout=30)
        self.assertNotEqual(blocked.returncode,0);self.assertIn('Required uv version',blocked.stderr)
        try:
            manager.command(command,cwd=self.root,timeout=30)
            self.assertTrue((self.root/'venv'/'bin'/'python').is_file())
            requirements=self.root/'empty.lock';requirements.write_text('')
            manager.command([str(manager.uv),'pip','sync','--python',str(self.root/'venv'/'bin'/'python'),'--require-hashes',str(requirements)],cwd=self.root,timeout=30)
        finally: manager.children.close()
    def test_manager_preserves_home_and_uses_explicit_private_data(self):
        manager=self.make_manager()
        self.assertEqual(manager.env.get('HOME'),os.environ.get('HOME'))
        self.assertEqual(manager.env.get('UV_NO_CONFIG'),'1')
        self.assertEqual(manager.env.get('PAPER_COMPANION_DATA'),str(manager.root/'data'))
        self.assertNotEqual(pathlib.Path(manager.env['PAPER_COMPANION_DATA']),pathlib.Path.home())
    def test_dependency_path_patches_are_hash_checked_and_never_use_home(self):
        self.assertTrue(hasattr(m,'apply_path_patches'),'managed dependency path patches are required')
        import ast
        manifest=json.loads((SERVICE/'runtime-manifest.json').read_text());site=self.root/'site';managed=self.root/'data'
        fixtures={'babeldoc/const.py':'import os\nfrom pathlib import Path\nCACHE_FOLDER = Path.home() / ".cache" / "babeldoc"\n','pdf2zh_next/const.py':'from pathlib import Path\nDEFAULT_CONFIG_DIR = Path("~/.config/pdf2zh").expanduser()\n','pdf2zh_next/translator/cache.py':'import json\nfrom pathlib import Path\ndef init_db():\n    cache_folder = Path.home() / ".cache" / "pdf2zh_next"\n'}
        for item in manifest['engine']['pathPatches']:
            source=fixtures[item['path']];patched=source
            for change in item['replacements']:patched=patched.replace(change['before'],change['after'])
            item['sourceSHA256']=hashlib.sha256(source.encode()).hexdigest();item['patchedSHA256']=hashlib.sha256(patched.encode()).hexdigest()
            target=site/item['path'];target.parent.mkdir(parents=True,exist_ok=True);target.write_text(source)
        m.apply_path_patches(site,manifest)
        for item in manifest['engine']['pathPatches']:
            target=site/item['path'];self.assertEqual(m.file_hash(target),item['patchedSHA256'])
            assignments=[n for n in ast.walk(ast.parse(target.read_text())) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ('CACHE_FOLDER','DEFAULT_CONFIG_DIR','cache_folder') for t in n.targets)]
            self.assertEqual(len(assignments),1)
            expression=compile(ast.Expression(assignments[0].value),'<managed-path>','eval')
            with patch.dict(os.environ,{'PAPER_COMPANION_DATA':str(managed)}),patch.object(pathlib.Path,'home',side_effect=AssertionError('must not inspect HOME')):
                value=eval(expression,{'Path':pathlib.Path,'os':os})
            self.assertIn(managed,value.parents)
        m.apply_path_patches(site,manifest) # Retry accepts the exact same patch.
        victim=site/manifest['engine']['pathPatches'][0]['path'];victim.write_text('unexpected contents')
        with self.assertRaisesRegex(RuntimeError,'patch'):m.apply_path_patches(site,manifest)
    def test_command_cancellation_remains_cancelled_after_child_shutdown(self):
        manager=self.make_manager()
        def cancel():
            time.sleep(.15);manager.cancelled.set();manager.children.close()
        thread=threading.Thread(target=cancel);thread.start()
        try:
            with self.assertRaises(m.Cancelled):manager.command([sys.executable,'-c','import time;time.sleep(30)'])
        finally:thread.join();manager.children.close()
    def test_failed_same_fingerprint_reinstall_keeps_published_runner(self):
        manager=self.make_manager();old=manager.root/'staging'/manager.version;old.mkdir(parents=True);runner=old/'ollama'/'ollama';runner.parent.mkdir();runner.write_bytes(b'known working')
        (old/'validated.json').write_text(json.dumps({'version':manager.version,'fingerprint':manager.version}))
        versions=manager.root/'versions';versions.mkdir();(versions/manager.version).symlink_to(pathlib.Path('..')/'staging'/manager.version,target_is_directory=True)
        m.atomic_json(manager.root/'current.json',{'version':manager.version})
        def fake_command(command,**kwargs):
            if 'sync' in command:
                python=pathlib.Path(command[command.index('--python')+1]);site=python.parent.parent/'lib/python3.12/site-packages'
                (site/'pdf2zh_next/translator/translator_impl').mkdir(parents=True,exist_ok=True)
        manager.manifest['resources']=[]
        with patch.object(m.platform,'python_version',return_value=manager.manifest['python']['version']),patch.object(m.platform,'system',return_value='Darwin'),patch.object(m.platform,'machine',return_value='arm64'),patch.object(m.platform,'mac_ver',return_value=('14.0',(),'')),patch.object(m.shutil,'disk_usage',return_value=__import__('collections').namedtuple('Usage','total used free')(100,0,10**15)),patch.object(manager,'command',side_effect=fake_command),patch.object(m,'apply_path_patches'),patch.object(m,'download'),patch.object(m,'safe_extract',side_effect=RuntimeError('Synthetic extraction failure')):
            with self.assertRaisesRegex(RuntimeError,'extraction failure'):manager.install()
        self.assertEqual(manager.current(),versions/manager.version);self.assertEqual(runner.read_bytes(),b'known working')
        self.assertFalse((old/'installing.json').exists(),'a published generation must never be reopened for writes')
    def test_bridge_port_conflict_does_not_publish_connection(self):
        import socket
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1',0));occupied.listen()
            result=subprocess.run([sys.executable,str(SERVICE/'server.py'),'--state',str(self.root),'--port',str(occupied.getsockname()[1])],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
        self.assertNotEqual(result.returncode,0);self.assertFalse((self.root/'connection.json').exists())
    def test_managed_bridge_publishes_only_a_bound_authenticated_instance(self):
        ready=self.root/'ready.json';child=subprocess.Popen([sys.executable,str(SERVICE/'server.py'),'--state',str(self.root/'state'),'--port','0','--instance','fixture','--model-url','http://127.0.0.1:53211','--ready-file',str(ready)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            deadline=time.monotonic()+5
            while not ready.exists() and time.monotonic()<deadline: time.sleep(.03)
            data=json.loads(ready.read_text());self.assertEqual(data['protocol'],2);self.assertTrue(data['managed'])
            req=urllib.request.Request(data['serviceURL']+'/health',headers={'X-Paper-Companion-Token':data['token']})
            with urllib.request.urlopen(req) as response:m.validate_health(json.load(response),'fixture','http://127.0.0.1:53211')
        finally: child.terminate();child.wait(timeout=5)
        self.assertFalse(ready.exists())
    def test_managed_bridge_identity_and_legacy_protocol(self):
        bs=importlib.util.spec_from_file_location('managed_bridge',SERVICE/'server.py');b=importlib.util.module_from_spec(bs);bs.loader.exec_module(b)
        self.assertTrue(hasattr(b.Bridge,'health'), 'bridge managed readiness metadata is required')
        bridge=b.Bridge(self.root/'legacy');self.assertEqual(bridge.health()['protocol'],1);bridge.pool.shutdown()
        managed=b.Bridge(self.root/'managed',instance='fixture',model_url='http://127.0.0.1:53211',components={'engine':True,'model':True,'assets':True})
        m.validate_health(managed.health(),'fixture','http://127.0.0.1:53211');managed.pool.shutdown()

if __name__=='__main__': unittest.main()
