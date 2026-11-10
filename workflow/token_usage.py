"""Read-only attribution of persisted Codex usage to exact workflow invocations."""
import json
import re
from pathlib import Path

FIELDS=('input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens')
MARKER=re.compile(r'^\[FEISHU_BRIDGE_MESSAGE_ID:([^\]\s]+)\]')

def parse_rollout(lines, thread_id):
    turns={};markers={};current=None;pending=[]
    def entry(tid):
        return turns.setdefault(tid,{'usage':None,'model':None,'finished':False,'source':'codex_rollout','detail':None,'seen':{}})
    for line in lines:
        try:r=json.loads(line)
        except (ValueError,TypeError):continue # A concurrently appended final line may be incomplete.
        p=r.get('payload') or {};typ=r.get('type');event=p.get('type')
        if typ=='event_msg' and event=='task_started':
            current=p.get('turn_id');
            if current:entry(current)
        elif typ=='turn_context':
            current=p.get('turn_id') or current
            if current:
                e=entry(current);e['model']=p.get('model') or e['model']
                for marker in pending:markers[marker]=current
                pending=[]
        elif typ=='response_item' and event=='message' and p.get('role')=='user':
            for block in p.get('content',[]):
                match=MARKER.match(block.get('text',''))
                if match:
                    if current:markers[match[1]]=current
                    else:pending.append(match[1])
        elif typ=='token_usage_record':
            if p.get('thread_id')!=thread_id or not p.get('turn_id'):continue
            e=entry(p['turn_id']);usage=p.get('turn_token_usage')
            response_id=p.get('response_id');fingerprint=json.dumps({'usage':p.get('usage'),'turn_usage':usage},sort_keys=True)
            if response_id and e['seen'].get(response_id)==fingerprint:continue
            if response_id:
                if response_id in e['seen']:e['detail']='Conflicting usage record for one response'
                e['seen'][response_id]=fingerprint
            if isinstance(usage,dict) and all(isinstance(usage.get(k),int) and usage[k]>=0 for k in ('input_tokens','output_tokens','total_tokens')):
                previous=e['usage']
                if previous and usage['total_tokens']<previous['total_tokens']:
                    e['detail']='Turn counter reset; observed usage may be incomplete'
                e['usage']={key:usage.get(key) for key in FIELDS}
        elif typ=='event_msg' and event=='task_complete' and p.get('turn_id'):
            entry(p['turn_id'])['finished']=True
    return turns,markers

def collect(reader, targets):
    snapshots={};results=[]
    for target in targets:
        base={'invocation_id':target['invocation_id'],'thread_id':target['thread_id'],'turn_id':None,'model':None,'status':'missing','finished':False,'source':'codex_rollout','detail':'No matching persisted usage yet','usage':None}
        if target.get('rule'):
            results.append({**base,'status':'observed','finished':True,'source':'local_rule','detail':None,'usage':dict.fromkeys(FIELDS,0)})
            continue
        tid=target['thread_id']
        if tid.startswith('unbound:'):
            results.append({**base,'detail':'Worker binding unavailable'});continue
        if tid not in snapshots:
            try:
                thread=reader.call('thread/read',{'threadId':tid,'includeTurns':False})['thread']
                with Path(thread['path']).open() as lines:snapshots[tid]=parse_rollout(lines,tid)
            except Exception:
                snapshots[tid]=None
        snapshot=snapshots[tid]
        if snapshot:
            turns,markers=snapshot;turn_id=target.get('host_turn_id') or markers.get(target['invocation_id'])
            # A conflicting persisted marker is never attributed using the supplied turn alone.
            if markers.get(target['invocation_id']) and markers[target['invocation_id']]!=turn_id:
                results.append({**base,'detail':'Turn correlation conflict'});continue
            e=turns.get(turn_id)
            if e:
                base.update({'turn_id':turn_id,'model':e['model'],'finished':e['finished']})
                if e['usage']:
                    base.update({'usage':e['usage'],'status':'partial' if e['detail'] else 'observed','detail':e['detail']})
        results.append(base)
    return {'records':results}
