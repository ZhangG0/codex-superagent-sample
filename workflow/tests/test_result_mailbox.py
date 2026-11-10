import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from result_mailbox import prepare, submit, read_result

class Returns(unittest.TestCase):
    def test_identity_receipt_duplicate_and_missing_return(self):
        with tempfile.TemporaryDirectory() as directory:
            req={'run_id':'X-test','kind':'execute'}
            prepare(req,directory)
            with self.assertRaisesRegex(ValueError,'without a structured return'):
                read_result(req,directory)
            result={'outcome':'completed','summary':'可直接阅读的交付报告','evidence':['实际检查通过']}
            submit(req['run_id'],result,directory)
            submit(req['run_id'],result,directory)
            self.assertEqual(read_result(req,directory),result)
            with self.assertRaisesRegex(ValueError,'Conflicting'):
                submit(req['run_id'],{**result,'summary':'other'},directory)
            with self.assertRaises(ValueError):
                read_result({**req,'kind':'verify_task'},directory)
            with self.assertRaises(ValueError):
                prepare(req,directory)
    def test_validation_and_path_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):prepare({'run_id':'../../else','kind':'execute'},directory)
            req={'run_id':'X-verify','kind':'verify_task'};prepare(req,directory)
            with self.assertRaises(ValueError):submit(req['run_id'],{'verdict':'accepted','comment':'guess','evidence':[]},directory)
            self.assertFalse((Path(directory)/req['run_id']/'result.json').exists())
            result={'verdict':'accepted','comment':'核对通过','evidence':['检查实际交付']}
            submit(req['run_id'],result,directory);self.assertEqual(read_result(req,directory),result)

if __name__=='__main__':unittest.main()
