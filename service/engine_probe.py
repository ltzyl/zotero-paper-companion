# SPDX-License-Identifier: AGPL-3.0-only
"""Validate only managed packages/assets; optionally translate a fictional PDF.

Run with the private engine Python and private HOME. No Zotero profile or
literature folder is inspected. Network translation is used only for --smoke.
"""
import argparse
import hashlib
import importlib.metadata
import json
import pathlib
import subprocess
import sys
import tempfile


def digest(path, algorithm='sha256'):
    result=hashlib.new(algorithm)
    with pathlib.Path(path).open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):result.update(chunk)
    return result.hexdigest()


def validate(resources):
    manifest=json.loads((resources/'runtime-manifest.json').read_text())
    if '.'.join(map(str,sys.version_info[:3]))!=manifest['python']['version']:
        raise RuntimeError('Installed Python does not match pinned runtime')
    for name,version in manifest['engine']['versions'].items():
        if importlib.metadata.version(name)!=version:raise RuntimeError('Installed package version mismatch: '+name)
    from pdf2zh_next.translator.translator_impl import bing
    if digest(bing.__file__)!=digest(resources/'bing_compat.py'):raise RuntimeError('Bing compatibility fix is missing')
    for asset in manifest['resources']:
        path=pathlib.Path.home()/asset['path'];algorithm='sha256' if 'sha256' in asset else 'sha3_256'
        if not path.is_file() or ('size' in asset and path.stat().st_size!=asset['size']) or digest(path,algorithm)!=asset[algorithm]:
            raise RuntimeError('Required managed PDF asset is missing or corrupt: '+path.name)
    import pymupdf
    import onnxruntime
    from babeldoc.assets import assets
    font=pathlib.Path.home()/'.cache/babeldoc/fonts/SourceHanSansCN-Regular.ttf'
    pymupdf.Font(fontfile=str(font))
    onnxruntime.InferenceSession(str(assets.get_doclayout_onnx_model_path()),providers=['CPUExecutionProvider'])
    print('Pinned engine, Bing fix, PDF model, fonts and character maps are ready',flush=True)


def smoke():
    import pymupdf
    with tempfile.TemporaryDirectory(prefix='paper-companion-check-') as folder:
        root=pathlib.Path(folder);source=root/'fictional.pdf';doc=pymupdf.open();page=doc.new_page();page.insert_text((72,100),'This fictional example describes a blue square.');doc.save(source);doc.close()
        command=[sys.executable,'-c','from pdf2zh_next.main import cli; cli()','--bing','--lang-in','en','--lang-out','zh-CN','--no-dual','--watermark-output-mode','no_watermark','--no-auto-extract-glossary','--qps','2','--pool-max-workers','1','--output',str(root),str(source)]
        subprocess.run(command,check=True,timeout=1500)
        outputs=list(root.glob('*.mono.pdf'))
        if len(outputs)!=1:raise RuntimeError('Synthetic PDF translation did not produce one Chinese PDF')
        with pymupdf.open(outputs[0]) as translated:
            text=''.join(page.get_text() for page in translated)
            if not any('\u4e00'<=c<='\u9fff' for c in text):raise RuntimeError('Synthetic PDF translation did not contain Chinese text')
    print('Fictional Chinese PDF check passed',flush=True)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--smoke',action='store_true');args=parser.parse_args()
    validate(pathlib.Path(__file__).resolve().parent)
    if args.smoke:smoke()

if __name__=='__main__':main()
