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
