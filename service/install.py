# SPDX-License-Identifier: AGPL-3.0-only
"""Create an isolated engine environment. Never reads the user's Zotero profile."""
import argparse,pathlib,subprocess,sys,venv,shutil

def main():
 p=argparse.ArgumentParser();p.add_argument('--directory',type=pathlib.Path,default=pathlib.Path.home()/'.paper-companion');p.add_argument('--start',action='store_true');a=p.parse_args()
 if not (3,12)<=sys.version_info[:2]<(3,14):raise SystemExit('Use Python 3.12 or 3.13. The translation engine does not support Python 3.14 yet.')
 root=a.directory.resolve();env=root/'venv';root.mkdir(parents=True,exist_ok=True,mode=0o700)
 venv.EnvBuilder(with_pip=True).create(env);python=env/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python')
 subprocess.run([str(python),'-m','pip','install','pdf2zh-next==2.9.0','babeldoc==0.6.2'],check=True)
 # The upstream Bing provider truncated long paragraphs. Install our documented
 # AGPL-compatible chunking fix only into this dedicated virtual environment.
 target=subprocess.check_output([str(python),'-c','import sysconfig; print(sysconfig.get_paths()["purelib"])'],text=True).strip()
 shutil.copy2(pathlib.Path(__file__).with_name('bing_compat.py'),pathlib.Path(target)/'pdf2zh_next/translator/translator_impl/bing.py')
 shutil.copy2(pathlib.Path(__file__).with_name('server.py'),root/'server.py')
 print('For local summaries install Ollama from https://ollama.com and run: ollama pull qwen3:4b')
 print('Start command:',str(python),str(root/'server.py'),'--state',str(root))
 if a.start:subprocess.run([str(python),str(root/'server.py'),'--state',str(root)],check=True)
if __name__=='__main__':main()
