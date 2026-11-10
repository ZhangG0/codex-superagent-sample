import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from token_usage import parse_rollout,collect

def row(kind,payload):return json.dumps({'type':kind,'payload':payload})
def usage(input=100,output=10):return {'input_tokens':input,'output_tokens':output,'cached_input_tokens':80,'cache_write_input_tokens':0,'reasoning_output_tokens':5,'total_tokens':input+output}
def record(turn,response,value):return row('token_usage_record',{'thread_id':'thread','turn_id':turn,'response_id':response,'usage':value,'turn_token_usage':value,'thread_token_usage':usage(999999,9999)})
class TokenUsage(unittest.TestCase):
 def test_exact_turn_snapshot_duplicate_history_and_markers(self):
  first=record('turn','r1',usage());second=record('turn','r2',usage(300,30))
  lines=[row('event_msg',{'type':'task_started','turn_id':'turn'}),row('turn_context',{'turn_id':'turn','model':'actual-model'}),row('response_item',{'type':'message','role':'user','content':[{'text':'[FEISHU_BRIDGE_MESSAGE_ID:X-test]\nhello'}]}),first,second,first,row('event_msg',{'type':'task_complete','turn_id':'turn'}),'{incomplete']
  turns,markers=parse_rollout(lines,'thread');self.assertEqual(markers,{'X-test':'turn'});self.assertEqual(turns['turn']['usage']['total_tokens'],330);self.assertIsNone(turns['turn']['detail']);self.assertEqual(turns['turn']['model'],'actual-model');self.assertTrue(turns['turn']['finished'])
 def test_foreign_thread_agent_markers_and_old_unsupported_logs_are_not_attributed(self):
  lines=[row('turn_context',{'turn_id':'turn'}),row('response_item',{'type':'message','role':'assistant','content':[{'text':'[FEISHU_BRIDGE_MESSAGE_ID:wrong]'}]}),record('turn','response',usage()),row('event_msg',{'type':'token_count','info':{'total_token_usage':usage(999999,9999)}})]
  turns,markers=parse_rollout(lines,'other');self.assertEqual(markers,{});self.assertIsNone(turns['turn']['usage'])
 def test_rule_zero_is_explicit_and_missing_is_not_zero(self):
  result=collect(None,[{'invocation_id':'I-greet','thread_id':'none','rule':True},{'invocation_id':'X-unbound','thread_id':'unbound:old'}])['records'];self.assertEqual(result[0]['usage']['total_tokens'],0);self.assertEqual(result[0]['status'],'observed');self.assertIsNone(result[1]['usage']);self.assertEqual(result[1]['status'],'missing')
 def test_counter_reset_is_partial(self):
  turns,_=parse_rollout([record('t','r1',usage(300,30)),record('t','r2',usage())],'thread');self.assertIsNotNone(turns['t']['detail'])
if __name__=='__main__':unittest.main()
