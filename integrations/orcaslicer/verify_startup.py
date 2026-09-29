"""Verify installed-runtime startup without granting write or socket permissions.

Run with OrcaSlicer's bundled Python and --packages pointing to its dependency
folder. The host API is represented only by the page/message surface; this does
not verify the native model importer.
"""
import argparse
import os
import sys
import types
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('runtime', type=Path)
parser.add_argument('--packages', type=Path)
args = parser.parse_args()
if args.packages:
    sys.path.insert(0, str(args.packages))
source = args.runtime.read_text(encoding='utf-8')
code = compile(source, str(args.runtime), 'exec')
events = []
phase = 'import'

def audit(event, arguments):
    if event.startswith('socket.'):
        events.append((phase, event))
        raise PermissionError('Socket operations are forbidden during this verification')
    if event == 'open':
        target, mode, flags = arguments
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
            events.append((phase, event, str(target)))
            raise PermissionError('File writes are forbidden during this verification')
    if event in ('os.mkdir', 'os.remove', 'os.rename', 'os.rmdir'):
        events.append((phase, event))
        raise PermissionError('Filesystem changes are forbidden during this verification')

sys.addaudithook(audit)
original_bytecode_policy = sys.dont_write_bytecode
orca = types.ModuleType('orca')
orca.base = object
orca.plugin = lambda cls: cls
orca.pages = types.SimpleNamespace(PagesPluginCapabilityBase=object)
orca.script = types.SimpleNamespace(ScriptPluginCapabilityBase=object)
orca.host = types.SimpleNamespace(app_language=lambda: 'ru_RU')
sys.modules['orca'] = orca
module = types.ModuleType('bumpmesh_startup_check')
module.__file__ = str(args.runtime)
sys.modules[module.__name__] = module
exec(code, module.__dict__)
phase = 'startup'
page = module.render_page()
assert 'web-chunk-request' in page
assert len(page.encode('utf-8')) < 100_000
received = []
controller = module.TransferController(received.append)
controller.on_message({'type': 'web-chunk-request', 'index': 0})
assert received[0]['type'] == 'web-chunk', received[0]
for index in range(1, received[0]['totalChunks']):
    controller.on_message({'type': 'web-chunk-request', 'index': index})
assert ''.join(message['data'] for message in received) == module.EMBEDDED_WEB_UI
controller.close()
assert sys.dont_write_bytecode == original_bytecode_policy
assert not [event for event in events if event[0] == 'startup'], events
assert 'encodings.cp437' not in sys.modules
print(f'PASS: Python {sys.version.split()[0]}, {len(received)} page chunks, no startup writes or socket events, cp437 not imported')
if events:
    print(f'Interpreter dependency import attempted {len(events)} writes before the startup callback; all were blocked')
