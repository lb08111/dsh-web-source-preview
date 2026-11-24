"""Installer regression checks using a stateful Docker CLI stand-in."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
from urllib.parse import urlsplit

path = Path(os.environ['MOCK_DOCKER_STATE'])
state = json.loads(path.read_text()) if path.exists() else {'containers': {}}
args = sys.argv[1:]

def done(code=0, output=''):
    path.write_text(json.dumps(state))
    if output:
        print(output)
    sys.exit(code)

if args[0] in ['info', 'pull', 'logs']:
    done()
if args[:2] == ['container', 'inspect']:
    container = state['containers'].get(args[-1])
    if container is None:
        done(1)
    if '--format' not in args:
        done(output='{}')
    template = args[args.index('--format') + 1]
    if '.Config.Labels' in template:
        done(output='managed')
    if '.Config.User' in template:
        done(output=container['user'])
    if '.Destination "/data"' in template:
        done(output=container['mounts'].get('/data', ''))
    if '.Destination "/workspace"' in template:
        done(output=container['mounts'].get('/workspace', ''))
    done(2)
if args[0] == 'run' and '--rm' in args:
    url = urlsplit(args[-1])
    port = url.port
    suffix = ':' + str(port) if port and (url.scheme, port) not in [('http', 80), ('https', 443)] else ''
    done(output=url.scheme.lower() + '://' + url.hostname.lower() + suffix)
if args[0] == 'run':
    name = args[args.index('--name') + 1]
    mounts = {}
    for index, argument in enumerate(args):
        if argument == '--volume':
            source, destination = args[index + 1].rsplit(':', 1)
            mounts[destination] = source
    state['containers'][name] = {
        'user': args[args.index('--user') + 1], 'mounts': mounts,
        'image': args[-1], 'running': not bool(os.environ.get('MOCK_FAIL_NEW')),
        'url': args[args.index('--env') + 1].split('=', 1)[1],
    }
    done(1 if os.environ.get('MOCK_FAIL_NEW') else 0, 'container-id')
if args[0] == 'inspect':
    container = state['containers'].get(args[-1])
    if container is None:
        done(1)
    done(output='running healthy' if container['running'] else 'exited unhealthy')
if args[0] == 'exec':
    done(output=state['containers'][args[1]]['url'] + '/?token=regression-token')
if args[0] == 'rename':
    state['containers'][args[2]] = state['containers'].pop(args[1])
    done()
if args[0] in ['start', 'stop']:
    state['containers'][args[-1]]['running'] = args[0] == 'start'
    done()
if args[0] == 'rm':
    state['containers'].pop(args[-1], None)
    done()
done(2, 'unsupported Docker stand-in invocation')
'''


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dsh-install-regression-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.state_path = self.root / 'docker-state.json'
        scripts = {
            'docker': DOCKER,
            'flock': '#!/bin/sh\nexit 0\n',
            'uname': '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',
            'id': '#!/bin/sh\ncase "$1" in -u) echo "$MOCK_UID";; -g) echo "$MOCK_GID";; esac\n',
        }
        for name, contents in scripts.items():
            path = self.bin / name
            path.write_text(contents)
            path.chmod(0o755)

    def install(self, home='first-home', uid='1001', gid='1002', options=(), extra_env=None, success=True):
        home_path = self.root / home
        home_path.mkdir(exist_ok=True)
        env = {key: value for key, value in os.environ.items() if not key.startswith('DSH_')}
        env.update({
            'HOME': str(home_path), 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
            'MOCK_DOCKER_STATE': str(self.state_path), 'MOCK_UID': uid, 'MOCK_GID': gid,
        })
        env.update(extra_env or {})
        result = subprocess.run([
            'bash', str(Path(__file__).with_name('install.sh').resolve()),
            '--no-install-docker', '--skip-login', '--public-url', 'http://server.example:3080',
            *options,
        ], env=env, text=True, capture_output=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(self.state_path.read_text())['containers']

    def test_update_reuses_mounts_and_user_after_home_and_uid_change(self):
        first = self.install()['dsh-web']
        self.assertEqual(first['user'], '1001:1002')
        for source in first['mounts'].values():
            Path(source, 'keep').write_text('persistent')
        updated = self.install(home='sudo-home', uid='0', gid='0')['dsh-web']
        self.assertEqual(updated['mounts'], first['mounts'])
        self.assertEqual(updated['user'], first['user'])
        self.assertFalse((self.root / 'sudo-home/dsh-web/data').exists())
        self.assertFalse((self.root / 'sudo-home/dsh-web/workspace').exists())
        for source in updated['mounts'].values():
            self.assertEqual(Path(source, 'keep').read_text(), 'persistent')

    def test_explicit_directories_override_only_the_selected_mount(self):
        first = self.install()['dsh-web']
        data = self.root / 'explicit-data'
        updated = self.install(home='sudo-home', uid='0', gid='0', options=('--data-dir', str(data)))['dsh-web']
        self.assertEqual(updated['mounts'], {'/data': str(data), '/workspace': first['mounts']['/workspace']})
        workspace = self.root / 'explicit-workspace'
        updated = self.install(home='third-home', extra_env={'DSH_WORKSPACE_DIR': str(workspace)})['dsh-web']
        self.assertEqual(updated['mounts'], {'/data': str(data), '/workspace': str(workspace)})
        self.assertEqual(updated['user'], first['user'])

    def test_failed_update_restores_previous_mounts_and_user(self):
        first = self.install()['dsh-web']
        containers = self.install(home='sudo-home', uid='0', gid='0', extra_env={'MOCK_FAIL_NEW': '1'}, success=False)
        self.assertEqual(list(containers), ['dsh-web'])
        self.assertEqual(containers['dsh-web'], first)

    def test_missing_existing_bind_fails_before_replacement(self):
        self.install()
        state = json.loads(self.state_path.read_text())
        del state['containers']['dsh-web']['mounts']['/data']
        self.state_path.write_text(json.dumps(state))
        containers = self.install(home='sudo-home', uid='0', gid='0', success=False)
        self.assertEqual(containers, state['containers'])


if __name__ == '__main__':
    unittest.main()
