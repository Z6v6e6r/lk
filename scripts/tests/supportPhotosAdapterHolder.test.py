"""Synthetic holder recovery; never opens production paths."""
from pathlib import Path
import os
import sys
import json
import tempfile
import unittest
import importlib.util
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('holder', Path(__file__).parent.parent / 'nodered_reviewed_flow_deploy/support_photos_adapter_holder.py')
holder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(holder)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix='adapter-recovery-')
        self.stage = Path(self.home.name) / 'stage'
        self.backup = Path(self.home.name) / 'backup'
        for directory in [self.stage, self.backup, self.stage / 'requests', self.stage / 'responses']:
            directory.mkdir(mode=0o700)
        self.original = b'foreign-exact-private-fixture'
        self.base_read, self.base_epoch = holder.read, holder.epoch
        self.lease = b''
        def read(file, **kwargs):
            if str(file) == '/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json':
                return self.lease
            return self.base_read(file, uid=os.getuid(), **kwargs)
        holder.read = read
        holder.epoch = lambda _pid: None
        self.plan = {'kind': 'support-media-adapter-install', 'stage': str(self.stage), 'backupStage': str(self.backup),
                     'operatorSha256': 'a' * 64, 'targetSha256': 'b' * 64, 'operationId': 'synthetic-op',
                     'predecessor': {'sha256': holder.sha(self.original)}}
        for directory in [self.stage, self.backup]:
            holder.put(directory / 'plan.json', self.plan)
            (directory / 'predecessor.lease.json').write_bytes(self.original)
            (directory / 'predecessor.lease.json').chmod(0o600)
        self.plan_sha = holder.sha(holder.read(self.stage / 'plan.json'))
        self.lease = json.dumps({'formatVersion': 4, 'kind': self.plan['kind'], 'deploymentId': self.plan['operationId'],
                                'stage': str(self.stage), 'backupStage': str(self.backup), 'planSha256': self.plan_sha,
                                'operatorSha256': 'a' * 64, 'phase': 'attempted'}).encode()
        holder.put(self.stage / 'holder.json', {'pid': 123, 'startTicks': 'old'})
        self.prior_sha = holder.sha(holder.read(self.stage / 'holder.json'))
        self.config = {'prepare': {'operatorSha256': 'a' * 64}, 'targetSha256': 'b' * 64}
        self.request = {'command': 'confirm', 'input': {'expectedPlanSha256': self.plan_sha}, 'native': {}}

    def tearDown(self):
        holder.read, holder.epoch = self.base_read, self.base_epoch
        self.home.cleanup()

    def recover(self):
        return holder.recovery_state(self.stage, self.backup, self.config, self.prior_sha)

    def test_old_consumed_and_unconsumed_commands_are_skipped(self):
        holder.put(self.stage / 'requests/00000001.json', self.request)
        holder.put(self.stage / 'responses/00000001.consumed.json', {'unknown': True})
        holder.put(self.stage / 'requests/00000002.json', self.request)
        self.assertEqual(self.recover(), (3, 1, self.prior_sha))
        self.assertTrue((self.stage / 'requests/00000001.json').exists())

    def test_recovered_holder_never_starts_a_new_attempt(self):
        for command in ['begin', 'publishPolicy', 'reserve', 'prepare']:
            with self.assertRaisesRegex(RuntimeError, 'RECOVERY_NO_NEW_ATTEMPT'):
                holder.operator_request(self.stage / 'requests', 3, {**self.request, 'command': command}, True)

    def test_later_close_gets_an_independent_immutable_handback_request(self):
        request = {**self.request, 'command': 'close'}
        first, close1 = holder.operator_request(self.stage / 'requests', 3, request, True)
        second, close2 = holder.operator_request(self.stage / 'requests', 4, request, True)
        self.assertNotEqual(first, second)
        self.assertTrue(close1 and close2)
        self.assertEqual(json.loads(holder.read(first))['command'], 'handback')
        self.assertEqual(json.loads(holder.read(second))['command'], 'handback')

    def test_live_holder_foreign_loan_and_bad_dual_copy_are_rejected(self):
        holder.epoch = lambda _pid: 'old'
        with self.assertRaisesRegex(RuntimeError, 'PREVIOUS_ALIVE'):
            self.recover()
        holder.epoch = lambda _pid: None
        original_lease = self.lease
        self.lease = json.dumps({'formatVersion': 4, 'kind': 'foreign'}).encode()
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_LOAN'):
            self.recover()
        self.lease = original_lease
        (self.backup / 'plan.json').write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_PLAN'):
            self.recover()

    def test_restored_predecessor_requires_exact_dual_intent_chain(self):
        self.lease = self.original
        with self.assertRaises(FileNotFoundError):
            self.recover()
        outcome = {'planSha256': self.plan_sha, 'audit': {'synthetic': True}}
        for directory in [self.stage, self.backup]:
            holder.put(directory / 'terminal.json', outcome)
        outcome_sha = holder.sha(holder.read(self.stage / 'terminal.json'))
        for directory in [self.stage, self.backup]:
            holder.put(directory / 'handback-intent.json', {'planSha256': self.plan_sha, 'outcomeSha256': outcome_sha,
                                                         'predecessorSha256': holder.sha(self.original)})
            holder.put(directory / 'policy-removed.json', {'planSha256': self.plan_sha, 'outcomeSha256': outcome_sha})
        # Missing complete copies do not prevent the fresh idempotent core retry.
        self.assertEqual(self.recover(), (1, 1, self.prior_sha))
        holder.put(self.stage / 'handback-complete.json', {'planSha256': self.plan_sha})
        # A partial completion pair is likewise recoverable via handback/close.
        self.assertEqual(self.recover(), (1, 1, self.prior_sha))
        file, close = holder.operator_request(self.stage / 'requests', 1, {**self.request, 'command': 'close'}, True)
        self.assertTrue(close)
        self.assertEqual(json.loads(holder.read(file))['command'], 'handback')
        self.assertEqual(self.recover(), (2, 1, self.prior_sha))


if __name__ == '__main__':
    unittest.main()
