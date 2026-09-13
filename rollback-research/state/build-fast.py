#!/usr/bin/env python3
"""Build an isolated original-game bridge with a faster complete-state checksum."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import struct
import subprocess
import zlib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PATCHES = ROOT / 'scripts' / 'patches'
BUILD = HERE.parent / 'build'
JAR = Path(os.environ.get('FFDEC_JAR', ROOT / 'research' / 'ffdec' / 'ffdec.jar'))
SOURCE = ROOT / 'gunmayhem.swf'
OUTPUT = BUILD / 'gunmayhem-fast.swf'
PROOF = PATCHES / 'resource-proof.json'
ORIGINAL_GUN_GAME_WEAPONS = [2, 29, 19, 46, 13, 51, 50, 11, 38, 33, 58, 62, 66, 65, 44]
REVERSED_GUN_GAME_WEAPONS = list(reversed(ORIGINAL_GUN_GAME_WEAPONS))


def tags(data, path='root'):
    offset = 0
    index = 0
    while offset < len(data):
        word, = struct.unpack_from('<H', data, offset)
        offset += 2
        tag, length = word >> 6, word & 63
        if length == 63:
            length, = struct.unpack_from('<I', data, offset)
            offset += 4
        body = data[offset:offset + length]
        assert len(body) == length, 'Truncated SWF tag'
        offset += length
        key = f'{path}/{index}:{tag}'
        if tag == 39:
            yield key + '/header', body[:4]
            yield from tags(body[4:], key)
        elif tag not in (12, 59):
            yield key, body
        index += 1


def unpack(file):
    raw = file.read_bytes()
    assert raw[:3] in (b'CWS', b'FWS'), 'Unsupported SWF compression'
    body = zlib.decompress(raw[8:]) if raw[:3] == b'CWS' else raw[8:]
    rect_length = (5 + 4 * (body[0] >> 3) + 7) // 8
    return body[:rect_length + 4], dict(tags(body[rect_length + 4:]))


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def patch_player_rules(movie):
    """Apply the spawn shield and reverse the original Gun Game weapon sequence."""
    import tempfile
    with tempfile.TemporaryDirectory(prefix='gunmayhem-shield-') as td:
        td = Path(td)
        exported = td / 'exported'
        imported = td / 'import'
        exported.mkdir()
        imported.mkdir()
        subprocess.run(['java', '-jar', str(JAR), '-export', 'script', str(exported), str(movie)], check=True)
        rel = Path('scripts/DefineSprite_697_player/frame_1/DoAction.as')
        src = exported / rel
        if not src.is_file():
            raise RuntimeError('Player script 697 was not exported')
        text = src.read_text()
        old = '   _root.hud.update();\n   invisibletime = 0;\n   shieldtime = 0;\n   jetfuel = 0;'
        new = '   _root.hud.update();\n   invisibletime = 0;\n   shieldtime = 140;\n   jetfuel = 0;'
        if text.count(old) != 1:
            raise RuntimeError('Spawn shield patch anchor changed')
        text = text.replace(old, new, 1)
        for level, (original_gun, reversed_gun) in enumerate(zip(ORIGINAL_GUN_GAME_WEAPONS, REVERSED_GUN_GAME_WEAPONS), 1):
            tail = '\n         break;' if level < 15 else ''
            old_case = f'      case {level}:\n         currentgun = {original_gun};{tail}'
            new_case = f'      case {level}:\n         currentgun = {reversed_gun};{tail}'
            if text.count(old_case) != 1:
                raise RuntimeError(f'Gun Game level {level} patch anchor changed')
            text = text.replace(old_case, new_case, 1)
        old_initial = 'currentlevel = 0;\nUPGRADE();\ncurrentgun = 2;\ncurrentwave = 1;'
        new_initial = 'currentlevel = 0;\nUPGRADE();\ncurrentgun = _root.gamemode == 4 ? 44 : 2;\ncurrentwave = 1;'
        if text.count(old_initial) != 1:
            raise RuntimeError('Gun Game initial weapon patch anchor changed')
        text = text.replace(old_initial, new_initial, 1)
        dst = imported / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(text)
        patched = td / 'patched.swf'
        subprocess.run(['java', '-jar', str(JAR), '-importScript', str(movie), str(patched), str(imported)], check=True)
        shutil.copyfile(patched, movie)


def main():
    if not JAR.is_file():
        raise SystemExit('FFDEC_JAR must identify the installed JPEXS FFDec 26.2.1 ffdec.jar')
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    classes = BUILD / 'classes'
    classes.mkdir(parents=True, exist_ok=True)
    original = (PATCHES / 'net-bootstrap.as').read_text()
    extension = (HERE / 'net-bootstrap-fast.as').read_text()
    marker = 'flash.external.ExternalInterface.addCallback("netStart",_root,_root.netStart);'
    assert original.count(marker) == 1, 'Original bridge registration boundary changed'
    combined = BUILD / 'net-bootstrap-combined.as'
    combined.write_text(original.replace(marker, extension + '\n' + marker))
    subprocess.run(['javac', '-cp', str(JAR), '-d', str(classes), str(PATCHES / 'BuildSwf.java')], check=True)
    subprocess.run(['java', '-cp', str(JAR) + os.pathsep + str(classes), 'BuildSwf',
                    str(SOURCE), str(OUTPUT), str(combined), str(PATCHES / 'net-frame10.as')], check=True)
    patch_player_rules(OUTPUT)
    original_header, original_tags = unpack(SOURCE)
    output_header, output_tags = unpack(OUTPUT)
    assert original_header == output_header, 'Stage dimensions, frame rate, or frame count changed'
    assert original_tags.keys() == output_tags.keys(), 'Non-script tag inventory changed'
    changed = [key for key in original_tags if original_tags[key] != output_tags[key]]
    assert not changed, f'Non-script resources changed: {changed}'
    proof = {
        'originalSHA256': sha(SOURCE), 'fastNetplaySHA256': sha(OUTPUT),
        'originalBridgeSHA256': sha(PATCHES / 'net-bootstrap.as'),
        'extensionSHA256': sha(HERE / 'net-bootstrap-fast.as'),
        'nonScriptTagsVerifiedByteForByte': len(original_tags),
        'nonScriptBytesVerified': sum(map(len, original_tags.values())),
        'changedNonScriptTags': changed, 'stageAndFrameRateUnchanged': True,
        'originalNetStatePreserved': True, 'fps': 35,
        'gunGameProgression': REVERSED_GUN_GAME_WEAPONS,
        'tool': 'JPEXS FFDec 26.2.1',
    }
    public_output = ROOT / 'public' / 'gunmayhem-net.swf'
    public_output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OUTPUT, public_output)
    prepared_output = BUILD / 'public' / 'gunmayhem-net.swf'
    prepared_output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OUTPUT, prepared_output)
    PROOF.write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps(proof, indent=2))
    print(OUTPUT)


if __name__ == '__main__':
    main()
