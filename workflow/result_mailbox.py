"""Durable per-run return channel, separate from the human-readable chat answer."""
import argparse
import json
import os
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent / '.local' / 'returns'

def slot(run_id, base=BASE):
    if not re.fullmatch(r'[XI]-[A-Za-z0-9-]{1,100}', run_id):
        raise ValueError('Invalid run identity')
    return Path(base) / run_id

def validate(kind, result):
    if not isinstance(result, dict):
        raise ValueError('Result must be an object')
    if kind == 'intake':
        if result.get('intent') not in ('ignore','new','followup','clarify') or not isinstance(result.get('reason'), str) or not result['reason'].strip():
            raise ValueError('Intake intent and reason required')
        return result
    if kind == 'execute':
        if result.get('outcome') not in ('completed', 'failed') or not isinstance(result.get('summary'), str) or not result['summary'].strip():
            raise ValueError('Execution outcome and full summary required')
    elif kind.startswith('verify_'):
        if result.get('verdict') not in ('accepted', 'changes_requested') or not result.get('comment'):
            raise ValueError('Verification verdict and comment required')
    elif kind == 'analyze':
        if not all(result.get(k) for k in ('title', 'goal', 'scope', 'acceptance')) or not isinstance(result.get('tasks'), list) or not isinstance(result.get('questions'), list):
            raise ValueError('Analysis fields required')
    else:
        raise ValueError('Unsupported result kind')
    if kind != 'analyze' and (not isinstance(result.get('evidence'), list) or not result['evidence'] or not all(isinstance(x, str) and x.strip() for x in result['evidence'])):
        raise ValueError('Verified evidence required')
    return result

def prepare(request, base=BASE):
    directory = slot(request['run_id'], base)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = {'run_id': request['run_id'], 'kind': request['kind']}
    path = directory / 'manifest.json'
    if path.exists():
        if json.loads(path.read_text()) != manifest or (directory / 'result.json').exists():
            raise ValueError('Original return already exists; inspect original run, do not resubmit')
    else:
        with path.open('x') as stream:
            os.chmod(path, 0o600)
            json.dump(manifest, stream)
    return directory

def submit(run_id, result, base=BASE):
    directory = slot(run_id, base)
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest['run_id'] != run_id:
        raise ValueError('Mismatched run identity')
    validate(manifest['kind'], result)
    path = directory / 'result.json'
    # A complete fsynced file is linked atomically; a repeated identical report is safe.
    import tempfile
    fd, name = tempfile.mkstemp(prefix='.return-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(result, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(name, path)
        except FileExistsError:
            if json.loads(path.read_text()) != result:
                raise ValueError('Conflicting report for original run')
        dfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        os.unlink(name)
    return result

def read_result(request, base=BASE):
    directory = slot(request['run_id'], base)
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest != {'run_id': request['run_id'], 'kind': request['kind']}:
        raise ValueError('Mismatched return identity')
    path = directory / 'result.json'
    if not path.exists():
        raise ValueError('Chat ended without a structured return; inspect original run before retry')
    return validate(request['kind'], json.loads(path.read_text()))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', required=True)
    parser.add_argument('--file', required=True, help='JSON file, or - for stdin')
    args = parser.parse_args()
    import sys
    result = json.load(sys.stdin) if args.file == '-' else json.loads(Path(args.file).read_text())
    submit(args.run, result)
    print('处理结果已回传。请在聊天中正常说明结论与验证结果。')
