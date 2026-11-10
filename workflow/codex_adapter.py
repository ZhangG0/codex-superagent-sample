"""Optional JSON/stdin transport. Reuses bridge's supported desktop queue reader.
No credentials or real chat identities are distributed in this file.
"""
import json
import hashlib
import os
import sys
import threading
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(os.environ.get('FEISHU_CODEX_BRIDGE_DIR', str(Path(__file__).resolve().parents[2] / 'feishu-codex-bridge'))).expanduser().resolve()
sys.path.insert(0, str(root))
from bridge.codex import DesktopQueue, TurnEnded
from result_mailbox import prepare, read_result

def record_turn(request, turn_id):
    if not request.get('dispatch_token') or request['kind']=='intake':
        return
    try:
        base = Path(__file__).resolve().parent
        config_path = Path(os.environ.get('WORKFLOW_CONFIG', str(base / 'config.local.json')))
        config = json.loads(config_path.read_text()) if config_path.exists() else {}
        home = Path.home()
        default_data = home / 'Library/Application Support/codex-superagent-sample' if sys.platform == 'darwin' else Path(os.environ.get('LOCALAPPDATA', str(home / 'AppData/Local'))) / 'codex-superagent-sample' if sys.platform == 'win32' else Path(os.environ.get('XDG_DATA_HOME', str(home / '.local/share'))) / 'codex-superagent-sample'
        data_dir = Path(os.environ.get('WORKFLOW_DATA_DIR', str(default_data)))
        token_path = Path(os.environ['WORKFLOW_TOKEN_FILE']) if os.environ.get('WORKFLOW_TOKEN_FILE') else config_path.parent / config['tokenFile'] if config.get('tokenFile') else data_dir / 'workflow.token'
        data = json.dumps({'dispatch_token': request['dispatch_token'], 'host_turn_id': turn_id}).encode()
        req = Request('http://127.0.0.1:4317/api/runs/' + request['run_id'] + '/started', data=data,
                      headers={'Authorization': 'Bearer ' + token_path.read_text().strip(), 'Content-Type': 'application/json'})
        with urlopen(req, timeout=5) as response:
            response.read()
    except Exception:
        print('Workflow turn correlation unavailable; original execution is still being observed', file=sys.stderr)

def main():
    request = json.load(sys.stdin)
    if request['kind'] == 'usage':
        from token_usage import collect
        if all(t.get('rule') for t in request['targets']):
            print(json.dumps(collect(None, request['targets'])))
        else:
            reader = DesktopQueue(['codex', 'app-server', '--stdio'])
            try: print(json.dumps(collect(reader, request['targets'])))
            finally: reader.close()
        return
    if request['kind'] == 'notify':
        from bridge.service import Feishu
        config_path = os.environ.get('WORKFLOW_FEISHU_CONFIG')
        if not config_path:
            raise ValueError('WORKFLOW_FEISHU_CONFIG is required for Feishu output')
        config_file = Path(config_path).resolve()
        config = json.loads(config_file.read_text())
        credentials_path = config_file.parent / 'var/credentials.json'
        credentials = json.loads(credentials_path.read_text()) if credentials_path.exists() else {}
        app_id = os.environ.get('FEISHU_APP_ID') or credentials.get('app_id')
        app_secret = os.environ.get('FEISHU_APP_SECRET') or credentials.get('app_secret')
        if not app_id or not app_secret:
            raise ValueError('Feishu credentials unavailable')
        n = request['notification']
        Feishu(app_id, app_secret).send({
            'id': hashlib.sha256(n['id'].encode()).hexdigest()[:32], 'chat_id': n['destination']['conversation_id'],
            'parent_mid': n.get('reply_to_message_id'), 'text': n['content']})
        print(json.dumps({'sent': True}))
        return
    payload = request['payload']
    if request['kind'] == 'execute':
        instruction = ('Complete only this authorized local task. Do not deploy, send external messages, '
                       'or expand scope. Return ONLY JSON: {"outcome":"completed|failed",'
                       '"summary":"...","evidence":["test command and result or artifact path"]}. '
                       'The summary must contain the complete user-facing deliverable in Chinese, not merely a completion notice. Use the supplied dependency results. Do not claim evidence that was not verified.\n')
    else:
        instruction = payload['instruction'] + '\n'
    instruction = instruction.replace('Return ONLY JSON', 'Prepare a structured background return matching this schema').replace('Return one JSON object', 'Prepare a structured background return').replace('Return only the requested JSON.', '')
    policy = request.get('policy') or payload.get('policy') or {}
    instruction += ('\nThis is controller protocol for an already persisted workflow requirement, not a new human message. '
                    'Do not call /api/messages, send cross-chat messages, or dispatch other workers. '
                    'Write the final chat response as readable Chinese prose, never raw protocol JSON.\nSelected worker responsibility: ' +
                    str(request.get('worker', {}).get('role', 'Follow the task scope')) +
                    '\nAuthorized project root: ' + str(policy.get('root', 'not configured')) +
                    '\nAuthorization basis: ' + str(policy.get('authorization', 'manual task scope')) +
                    '\nKeep every change inside this root. Existing repository instructions still apply.\n')
    payload = dict(payload)
    payload.pop('instruction', None)
    import shlex
    submit_command = shlex.join([sys.executable, str(Path(__file__).resolve().with_name('result_mailbox.py')), '--run', request['run_id'], '--file', '-'])
    instruction += ('\nBefore the final answer, use a local command tool to submit the structured result via stdin to: ' + submit_command + '\nThis one protocol return is explicitly authorized outside the project root; product file changes remain restricted to the project. Never print or read tokens. Do not put protocol JSON in the final answer. If submission fails, report the failure in prose; never claim success without a receipt.\n')
    prompt = instruction + json.dumps(payload, ensure_ascii=False)
    queue_config = Path(__file__).resolve().parent / '.local/queue-command.json'
    queue_command = json.loads(queue_config.read_text()) if queue_config.exists() else None
    reader = DesktopQueue(['codex', 'app-server', '--stdio'], queue_command)
    try:
        turns = reader.turns(request['worker']['threadId'])['data']
        active = [t for t in turns[:1] if t.get('status') == 'inProgress' or (t.get('status') == 'interrupted' and t.get('completedAt') is None)]
        if active:
            print(json.dumps({'waiting': True, 'reason': '目标会话仍有未结束任务，尚未提交本次执行'}))
            return
        prepare(request)
        reader.run({'message_id': request['run_id'], 'thread_id': request['worker']['threadId'],
                    'prompt': prompt}, lambda turn: record_turn(request, turn), threading.Event())
        result = read_result(request)
        print(json.dumps(result, ensure_ascii=False))
    except TurnEnded as error:
        if request['kind'] != 'execute':
            raise
        print(json.dumps({'outcome': 'failed', 'summary': 'Codex task ended: ' + error.status,
                          'evidence': ['Observed stable terminal status: ' + error.status]}))
    finally:
        reader.close()

if __name__ == '__main__':
    main()
