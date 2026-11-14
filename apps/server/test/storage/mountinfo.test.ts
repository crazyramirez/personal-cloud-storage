import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeDevT, encodeDevT } from '../../src/storage/device-number.ts';
import {
  findTopMount,
  hasMountOption,
  MountInfoParseError,
  parseMountInfo,
  unescapeMountField,
} from '../../src/storage/mountinfo.ts';
import { formatVolumeMarker, isVolumeMarkerId, parseVolumeMarker } from '../../src/storage/volume-marker.ts';

const UBUNTU_SAMPLE = [
  '22 1 179:2 / / rw,noatime shared:1 - ext4 /dev/mmcblk0p2 rw,commit=600,errors=remount-ro',
  '25 22 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=470000k,mode=755',
  '31 25 0:26 / /dev/pts rw,nosuid,noexec,relatime shared:3 master:9 - devpts devpts rw,gid=5,mode=620,ptmxmode=000',
  '40 22 8:1 / /srv/pcloud rw,nosuid,nodev,noexec,noatime shared:30 - exfat /dev/sda1 rw,uid=998,gid=998,fmask=0177,dmask=0077,iocharset=utf8,errors=remount-ro',
  '41 22 0:45 / /media/usuario/Mi\\040Disco rw,nosuid,nodev,relatime - fuseblk /dev/sdb1 rw,user_id=0,group_id=0,allow_other,blksize=4096',
  '42 22 0:50 / /var/snap/x rw - tmpfs none rw',
  '',
].join('\n');

describe('parseMountInfo', () => {
  const entries = parseMountInfo(UBUNTU_SAMPLE);

  it('lee todas las líneas', () => {
    assert.equal(entries.length, 6);
  });

  it('extrae campos de un montaje exFAT', () => {
    const hdd = entries.find((entry) => entry.mountPoint === '/srv/pcloud');
    assert.ok(hdd);
    assert.equal(hdd.mountId, 40);
    assert.equal(hdd.parentId, 22);
    assert.equal(hdd.major, 8);
    assert.equal(hdd.minor, 1);
    assert.equal(hdd.root, '/');
    assert.equal(hdd.fsType, 'exfat');
    assert.equal(hdd.source, '/dev/sda1');
    assert.deepEqual(hdd.optionalFields, ['shared:30']);
    assert.ok(hasMountOption(hdd, 'errors=remount-ro'));
    assert.ok(!hasMountOption(hdd, 'ro'));
  });

  it('admite varios campos opcionales y ninguno', () => {
    assert.deepEqual(entries[2]?.optionalFields, ['shared:3', 'master:9']);
    assert.deepEqual(entries[4]?.optionalFields, []);
  });

  it('deshace los escapes octales del kernel', () => {
    assert.equal(entries[4]?.mountPoint, '/media/usuario/Mi Disco');
    assert.equal(unescapeMountField('a\\011b\\012c\\134d'), 'a\tb\nc\\d');
  });

  it('conserva nombres UTF-8 sin escapar', () => {
    const [entry] = parseMountInfo('50 22 8:1 / /srv/Fotografías rw - exfat /dev/sda1 rw\n');
    assert.equal(entry?.mountPoint, '/srv/Fotografías');
  });

  const malformed: Array<[string, string]> = [
    ['vacío', ''],
    ['sin separador', '22 1 179:2 / / rw shared:1 ext4 /dev/mmcblk0p2 rw'],
    ['id no numérico', 'xx 1 179:2 / / rw - ext4 /dev/mmcblk0p2 rw'],
    ['major:minor inválido', '22 1 179 / / rw - ext4 /dev/mmcblk0p2 rw'],
    ['campos sobrantes', '22 1 179:2 / / rw - ext4 /dev/mmcblk0p2 rw extra'],
    ['línea en blanco intermedia', '22 1 179:2 / / rw - ext4 /dev/root rw\n\n23 22 0:5 / /dev rw - devtmpfs udev rw\n'],
  ];
  for (const [name, text] of malformed) {
    it(`rechaza mountinfo ${name}`, () => {
      assert.throws(() => parseMountInfo(text), MountInfoParseError);
    });
  }
});

describe('findTopMount', () => {
  const line = (id: number, parent: number, dev: string) =>
    `${id} ${parent} ${dev} / /srv/pcloud rw - exfat /dev/sda1 rw`;
  const root = '22 1 179:2 / / rw - ext4 /dev/mmcblk0p2 rw';

  it('none si no hay montaje en la ruta', () => {
    assert.equal(findTopMount(parseMountInfo(root), '/srv/pcloud').kind, 'none');
  });

  it('elige el montaje superior de una pila', () => {
    const top = findTopMount(parseMountInfo([root, line(40, 22, '179:2'), line(50, 40, '8:1')].join('\n')), '/srv/pcloud');
    assert.equal(top.kind, 'found');
    assert.equal(top.kind === 'found' ? top.entry.mountId : -1, 50);
  });

  it('ambiguo si hay dos montajes hermanos', () => {
    const top = findTopMount(parseMountInfo([root, line(40, 22, '8:1'), line(41, 22, '8:17')].join('\n')), '/srv/pcloud');
    assert.equal(top.kind, 'ambiguous');
  });
});

describe('dev_t (glibc makedev)', () => {
  it('decodifica valores conocidos', () => {
    assert.deepEqual(decodeDevT(2049n), { major: 8, minor: 1 });
    assert.deepEqual(decodeDevT(66305n), { major: 259, minor: 1 });
    assert.deepEqual(decodeDevT(45826n), { major: 179, minor: 2 });
  });

  it('ida y vuelta con minors y majors grandes', () => {
    for (const device of [
      { major: 8, minor: 300 },
      { major: 0, minor: 45 },
      { major: 259, minor: 65536 },
      { major: 4095, minor: 1048575 },
      { major: 70000, minor: 3 },
    ]) {
      assert.deepEqual(decodeDevT(encodeDevT(device)), device);
    }
    assert.equal(encodeDevT({ major: 8, minor: 300 }), 1050668n);
  });
});

describe('marcador de volumen', () => {
  const id = '3f1c2b7e-8d4a-4c1e-9a2b-5d6e7f8a9b0c';

  it('formatea y parsea v1', () => {
    assert.equal(formatVolumeMarker(id), `pcloud-volume-v1 ${id}\n`);
    assert.equal(parseVolumeMarker(formatVolumeMarker(id)), id);
    assert.equal(parseVolumeMarker(`pcloud-volume-v1 ${id}\r\n`), id);
    assert.equal(parseVolumeMarker(`pcloud-volume-v1 ${id}`), id);
  });

  it('rechaza variantes', () => {
    for (const text of [
      '',
      id,
      `pcloud-volume-v2 ${id}\n`,
      `pcloud-volume-v1 ${id.toUpperCase()}\n`,
      `pcloud-volume-v1 ${id}\n\n`,
      ` pcloud-volume-v1 ${id}\n`,
      'pcloud-volume-v1 3f1c2b7e-8d4a-1c1e-9a2b-5d6e7f8a9b0c\n', // no es v4
    ]) {
      assert.equal(parseVolumeMarker(text), null, JSON.stringify(text));
    }
    assert.ok(!isVolumeMarkerId('REEMPLAZAR_EN_ONBOARDING'));
    assert.throws(() => formatVolumeMarker('no-es-un-uuid'), TypeError);
  });
});
