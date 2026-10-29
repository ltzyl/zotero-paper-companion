# SPDX-License-Identifier: AGPL-3.0-only
import base64,importlib.util,json,pathlib,tempfile,threading,unittest,urllib.request,urllib.error
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('bridge',pathlib.Path(__file__).parents[1]/'service/server.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ServiceTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.bridge=m.Bridge(self.temp.name);self.server=m.ThreadingHTTPServer(('127.0.0.1',0),m.handler(self.bridge));self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.url='http://127.0.0.1:'+str(self.server.server_port)
 def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.bridge.pool.shutdown(wait=True);self.temp.cleanup()
 def test_auth_and_browser_origin(self):
  for headers in [{},{'X-Paper-Companion-Token':self.bridge.token,'Origin':'https://example.invalid'}]:
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(urllib.request.Request(self.url+'/health',headers=headers))
   self.assertEqual(error.exception.code,403)
  with urllib.request.urlopen(urllib.request.Request(self.url+'/health',headers={'X-Paper-Companion-Token':self.bridge.token})) as r:self.assertEqual(json.load(r)['service'],'paper-companion')
 def test_output_paths_cannot_escape(self):
  for path in ['../token','/etc/passwd','a'*32+'-mono.pdf/../token']:
   with self.assertRaises(ValueError):self.bridge.output(path)
 def test_pdf_validation_and_generated_paths(self):
  with self.assertRaises(ValueError):self.bridge.submit({'fileContent':base64.b64encode(b'not a PDF').decode()})
  with patch.object(self.bridge.pool,'submit'):
   result=self.bridge.submit({'fileName':'../../private.pdf','fileContent':base64.b64encode(b'%PDF-1.4\nfictional fixture').decode()})
  self.assertTrue((pathlib.Path(self.temp.name)/'jobs'/result['taskId']/'original.pdf').exists())
 def test_restart_does_not_resubmit_uncertain_job(self):
  with patch.object(self.bridge.pool,'submit'):result=self.bridge.submit({'fileContent':base64.b64encode(b'%PDF-fixture').decode()})
  other=m.Bridge(self.temp.name);self.assertEqual(other.jobs[result['taskId']]['status'],'failed');other.pool.shutdown()
 def test_mono_output_and_no_shell(self):
  with patch.object(self.bridge.pool,'submit'):result=self.bridge.submit({'fileContent':base64.b64encode(b'%PDF-fixture').decode()})
  folder=pathlib.Path(self.temp.name)/'jobs'/result['taskId']
  def fake_run(command,**kwargs):
   self.assertIsInstance(command,list);self.assertNotIn('shell',kwargs);self.assertIn('--no-dual',command);(folder/'fixture.mono.pdf').write_bytes(b'%PDF-Chinese-demo')
  with patch.object(m.subprocess,'run',side_effect=fake_run):self.bridge.translate_pdf(result['taskId'])
  self.assertEqual(self.bridge.jobs[result['taskId']]['status'],'completed');self.assertTrue(self.bridge.output(result['taskId']+'-mono.pdf').exists())
if __name__=='__main__':unittest.main()
