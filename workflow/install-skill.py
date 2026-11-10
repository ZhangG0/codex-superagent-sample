"""Back up and update the installed skill without replacing unrelated metadata."""
import argparse
import datetime
import hashlib
import json
import re
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--destination', type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1]
destination = args.destination.expanduser().resolve()
if destination.name != 'codex-superagent-sample' or not (destination / 'SKILL.md').is_file():
    raise SystemExit('Expected an existing codex-superagent-sample skill')
backup = Path(__file__).resolve().parent / '.local/skill-backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
shutil.copytree(destination, backup)
(backup / 'install-record.json').write_text(json.dumps({'destination':str(destination),'original_sha256':hashlib.sha256((destination/'SKILL.md').read_bytes()).hexdigest()},indent=2))
# Keep the installed version's old workflow as the installed compatibility reference.
(destination / 'references').mkdir(exist_ok=True)
if not (destination/'references/legacy-dispatch.md').exists():
    shutil.copy2(destination/'SKILL.md',destination/'references/legacy-dispatch.md')
shutil.copy2(source/'SKILL.md',destination/'SKILL.md')
meta = destination / 'agents/openai.yaml'
if meta.exists():
    text = meta.read_text()
    replacement = '使用 $codex-superagent-sample，将需求登记到本地工作流，拆分可独立验收的任务并跟踪执行、验证和结果通知。'
    text, count = re.subn(r'(?m)^(  default_prompt:) .*$', lambda m: m.group(1)+' '+json.dumps(replacement,ensure_ascii=False), text)
    if count != 1:
        raise SystemExit('Inspect metadata manually; skill backup retained at '+str(backup))
    meta.write_text(text)
print(json.dumps({'installed':str(destination),'backup':str(backup),'sha256':hashlib.sha256((destination/'SKILL.md').read_bytes()).hexdigest()},ensure_ascii=False))
